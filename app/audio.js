/**
 * Audio property extraction.
 *
 * The brief requires duration, sample rate, bitrate and loudness for every
 * submission, plus a bonus noise/quality estimate.
 *
 * Two tools, because neither alone is enough:
 *
 *   ffprobe  reads container/stream metadata - duration, sample rate, channels,
 *            codec, bitrate. Bitrate in particular cannot be computed from the
 *            decoded samples, it is a property of the *encoding*, so it has to
 *            come from the file's own headers.
 *
 *   ffmpeg   decodes to raw PCM so we can measure the actual signal - RMS
 *            loudness, peak, noise floor, SNR, clipping. It also runs the EBU
 *            R128 filter for a broadcast-standard LUFS figure.
 *
 * Everything is wrapped so a weird file degrades to `analysis_error` on the row
 * rather than throwing away the upload.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';

import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const exec = promisify(execFile);
const FFPROBE = ffprobeStatic.path;

/** Decoded-sample analysis runs at this rate; enough for speech measurements. */
const ANALYSIS_RATE = 16000;
/** 20 ms frames - the usual window for short-term speech energy. */
const FRAME_MS = 20;
/** |sample| at or above this fraction of full scale counts as clipped. */
const CLIP_THRESHOLD = 0.99;

const FULL_SCALE = 32768;

/** Linear amplitude (0..1) -> dBFS. Silence floors at -120 rather than -Infinity. */
const toDbfs = (linear) => (linear <= 0 ? -120 : Math.max(-120, 20 * Math.log10(linear)));

const round = (n, places = 2) =>
  (n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(places)));

// ---------------------------------------------------------------------------
// Container metadata
// ---------------------------------------------------------------------------

async function probe(filePath) {
  const { stdout } = await exec(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { maxBuffer: 8 * 1024 * 1024 });

  const info = JSON.parse(stdout);
  const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!audio) throw new Error('No audio stream found in file');

  const duration = Number(info.format?.duration ?? audio.duration ?? 0) || null;
  const sizeBytes = Number(info.format?.size ?? 0) || statSync(filePath).size;

  // Bitrate: prefer what the file declares. WebM/Opus from MediaRecorder very
  // often declares nothing, so fall back to the only thing that is always true -
  // total bits divided by total seconds. Both can be null when the container
  // also declares no duration; guard that below rather than dividing null by
  // 1000, which is 0 in JavaScript and reads as a real measurement.
  const declared = Number(audio.bit_rate ?? info.format?.bit_rate ?? 0) || null;
  const derived = duration && sizeBytes ? (sizeBytes * 8) / duration : null;
  const bitrate = declared ?? derived;

  return {
    duration_sec: round(duration, 3),
    sample_rate_hz: Number(audio.sample_rate) || null,
    channels: Number(audio.channels) || null,
    codec: audio.codec_name ?? null,
    size_bytes: sizeBytes,
    bitrate_kbps: bitrate === null ? null : round(bitrate / 1000, 1),
    bitrate_source: declared ? 'declared' : (derived ? 'derived from size/duration' : null),
  };
}

// ---------------------------------------------------------------------------
// Signal measurements from decoded PCM
// ---------------------------------------------------------------------------

/** Decode any input to mono 16-bit little-endian PCM at ANALYSIS_RATE. */
async function decodePcm(filePath) {
  const { stdout } = await exec(ffmpegPath, [
    '-v', 'error',
    '-i', filePath,
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    '-ac', '1',
    '-ar', String(ANALYSIS_RATE),
    '-',
  ], { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' });

  // Reinterpret the byte buffer as signed 16-bit samples.
  return new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
}

function measure(samples) {
  if (!samples.length) return null;

  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  const clipLevel = CLIP_THRESHOLD * FULL_SCALE;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const abs = s < 0 ? -s : s;
    sumSquares += s * s;
    if (abs > peak) peak = abs;
    if (abs >= clipLevel) clipped++;
  }

  const rms = Math.sqrt(sumSquares / samples.length) / FULL_SCALE;

  // Short-term energy per frame. The quietest frames are the room/noise floor;
  // the loudest are the person actually speaking. The gap between them is a
  // usable SNR estimate without needing to detect speech.
  const frameLen = Math.floor((ANALYSIS_RATE * FRAME_MS) / 1000);
  const frameDb = [];
  for (let start = 0; start + frameLen <= samples.length; start += frameLen) {
    let acc = 0;
    for (let i = start; i < start + frameLen; i++) acc += samples[i] * samples[i];
    frameDb.push(toDbfs(Math.sqrt(acc / frameLen) / FULL_SCALE));
  }

  let noiseFloor = null;
  let snr = null;
  if (frameDb.length >= 5) {
    const sorted = [...frameDb].sort((a, b) => a - b);
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    noiseFloor = at(0.10);   // quietest tenth  -> background
    const signal = at(0.90); // loudest tenth   -> voice
    snr = signal - noiseFloor;
  }

  return {
    loudness_dbfs: round(toDbfs(rms)),
    peak_dbfs: round(toDbfs(peak / FULL_SCALE)),
    clipping_pct: round((clipped / samples.length) * 100, 3),
    noise_floor_dbfs: round(noiseFloor),
    snr_db: round(snr),
  };
}

/**
 * EBU R128 integrated loudness. dBFS answers "how big are the numbers"; LUFS
 * answers "how loud does this sound to a person", which is the figure broadcast
 * and podcast tooling actually targets.
 */
async function integratedLufs(filePath) {
  try {
    // ebur128 reports on stderr, and the null muxer means nothing is written out.
    const { stderr } = await exec(ffmpegPath, [
      '-v', 'info', '-nostats',
      '-i', filePath,
      '-af', 'ebur128=peak=true',
      '-f', 'null', '-',
    ], { maxBuffer: 32 * 1024 * 1024 }).catch((e) => ({ stderr: e.stderr ?? '' }));

    // The summary block at the end contains e.g. "    I:         -23.0 LUFS"
    const m = String(stderr).match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g);
    if (!m || !m.length) return null;
    const last = m[m.length - 1].match(/(-?\d+(?:\.\d+)?)/);
    return last ? round(Number(last[1]), 1) : null;
  } catch {
    return null;
  }
}

/**
 * Below this spread between the loudest and quietest frames, the recording has
 * no pauses and the percentile SNR estimate is meaningless.
 */
const MIN_DYNAMIC_RANGE_DB = 3;

/**
 * Rough usability verdict. Deliberately coarse - the point is to flag a
 * recording a human should re-do, not to grade it.
 *
 * Important limitation, stated rather than hidden: the SNR figure is the gap
 * between the loudest and quietest tenth of frames, which only means "signal
 * versus background" when the recording actually contains pauses. A continuous
 * sound - a held tone, music, or unbroken noise - has no quiet frames, so the
 * gap collapses to ~0 dB. That is not evidence of noise, it is absence of
 * evidence, and the label says so instead of guessing.
 */
function qualityLabel({ snr_db, clipping_pct, loudness_dbfs }) {
  const reasons = [];
  if (clipping_pct !== null && clipping_pct > 1) reasons.push('clipped');
  if (loudness_dbfs !== null && loudness_dbfs < -45) reasons.push('very quiet');

  const snrUnusable = snr_db === null || snr_db < MIN_DYNAMIC_RANGE_DB;

  if (snrUnusable) {
    const note = 'SNR not measurable - continuous audio with no pauses';
    return reasons.length ? `poor (${reasons.join(', ')})` : `unknown (${note})`;
  }

  if (snr_db < 10) reasons.push('noisy');

  if (reasons.length === 0) return snr_db >= 25 ? 'good' : 'fair';
  if (reasons.length === 1) return `fair (${reasons[0]})`;
  return `poor (${reasons.join(', ')})`;
}

/**
 * @param {string} filePath
 * @returns {Promise<object>} always resolves; failures land in analysis_error
 */
export async function analyzeAudio(filePath) {
  const empty = {
    duration_sec: null, sample_rate_hz: null, bitrate_kbps: null, channels: null,
    codec: null, size_bytes: null, loudness_dbfs: null, peak_dbfs: null,
    loudness_lufs: null, noise_floor_dbfs: null, snr_db: null, clipping_pct: null,
    quality_label: null, bitrate_source: null, analysis_error: null,
  };

  let meta;
  try {
    meta = await probe(filePath);
  } catch (e) {
    return { ...empty, analysis_error: `ffprobe failed: ${e.message.split('\n')[0]}` };
  }

  let signal = null;
  let signalError = null;
  let decodedSeconds = null;
  try {
    const pcm = await decodePcm(filePath);
    // The decoded stream always knows its own length. This is the one duration
    // that exists even when the container declares none.
    if (pcm.length) decodedSeconds = pcm.length / ANALYSIS_RATE;
    signal = measure(pcm);
    if (!signal) signalError = 'decoded to zero samples';
  } catch (e) {
    signalError = `decode failed: ${e.message.split('\n')[0]}`;
  }

  // A WebM from MediaRecorder is written as a live stream, so it usually carries
  // no duration in its header and ffprobe returns null - taking bitrate down
  // with it. Duration is one of the four properties this app exists to report,
  // so fall back to the decoded length instead of reporting nothing.
  if (meta.duration_sec === null && decodedSeconds) {
    meta.duration_sec = round(decodedSeconds, 3);
    if (meta.bitrate_kbps === null && meta.size_bytes) {
      meta.bitrate_kbps = round((meta.size_bytes * 8) / decodedSeconds / 1000, 1);
      meta.bitrate_source = 'derived from size/duration';
    }
  }

  const lufs = await integratedLufs(filePath);

  return {
    ...empty,
    ...meta,
    ...(signal ?? {}),
    loudness_lufs: lufs,
    quality_label: signal ? qualityLabel(signal) : null,
    analysis_error: signalError,
  };
}
