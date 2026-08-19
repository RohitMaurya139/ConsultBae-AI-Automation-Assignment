/**
 * Regenerate the audio test fixtures:  node tests/fixtures/generate.js
 *
 * These are synthesised rather than downloaded so the correct answer is known
 * independently of the code under test. A committed random mp3 would only tell
 * us the analyser is consistent, not that it is right.
 */

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import ffmpegPath from 'ffmpeg-static';

const DIR = dirname(fileURLToPath(import.meta.url));
const run = (args) => execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { cwd: DIR });

// Bursts of tone alternating with silence - what a voice looks like to a
// frame-energy analyser. Mixed with a noise bed to set the room level.
const BURSTS = "sine=frequency=300:duration=4:sample_rate=16000,volume=0:enable='gte(mod(t,1),0.5)'";
const mixWithNoise = (amplitude, out) => run([
  '-f', 'lavfi', '-i', BURSTS,
  '-f', 'lavfi', '-i', `anoisesrc=duration=4:sample_rate=16000:amplitude=${amplitude}`,
  '-filter_complex', '[0][1]amix=inputs=2:duration=shortest:normalize=0',
  '-ac', '1', out,
]);

const FIXTURES = [
  // 3s / 44.1 kHz / stereo WAV -> bitrate must come out as exactly 1411.2 kbps
  () => run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=44100', '-af', 'volume=-6dB', '-ac', '2', 'tone_44k.wav']),
  // 128 kbps MP3 at 22.05 kHz mono -> declared bitrate must read back as 128
  () => run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=22050', '-ac', '1', '-b:a', '128k', 'tone_22k_128k.mp3']),
  // WebM/Opus 48 kHz - what the browser MediaRecorder produces
  () => run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000', '-c:a', 'libopus', '-b:a', '64k', 'browser_like.webm']),
  // Deliberately over-driven -> clipping_pct must be high, peak at 0 dBFS
  () => run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=16000', '-af', 'volume=20dB', 'clipped.wav']),
  // Speech-like bursts in a quiet room -> high SNR, "good"
  () => mixWithNoise(0.004, 'speech_quiet_room.wav'),
  // Same bursts in a loud room  -> low SNR, "noisy"
  () => mixWithNoise(0.12, 'speech_loud_room.wav'),
];

for (const make of FIXTURES) make();
console.log(`${FIXTURES.length} fixtures written to ${DIR}`);
