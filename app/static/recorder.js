/**
 * Browser recording via the native MediaRecorder API - no library.
 *
 * The recorded Blob is injected into the form's file input using a DataTransfer,
 * so the server sees an ordinary multipart upload whether the audio was recorded
 * or picked from disk. That keeps one code path on the server instead of two.
 */
(() => {
  const recBtn = document.getElementById('rec');
  const stopBtn = document.getElementById('stop');
  const status = document.getElementById('status');
  const preview = document.getElementById('preview');
  const fileInput = document.getElementById('file');
  if (!recBtn) return;

  let recorder = null;
  let chunks = [];
  let ticker = null;

  const unsupported = !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined';
  if (unsupported) {
    recBtn.disabled = true;
    status.textContent = 'in-browser recording not supported here - use the file upload below';
    return;
  }

  // Let the browser choose a container it can actually produce. Chrome and
  // Firefox both do WebM/Opus; Safari does mp4. ffprobe reads all of them.
  const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
    .find((t) => MediaRecorder.isTypeSupported(t)) ?? '';

  recBtn.addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMime();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks = [];

      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type });

        preview.src = URL.createObjectURL(blob);
        preview.hidden = false;

        // Hand the recording to the file input so the normal form post carries it.
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const dt = new DataTransfer();
        dt.items.add(new File([blob], `recording.${ext}`, { type: type.split(';')[0] }));
        fileInput.files = dt.files;

        status.textContent = `recorded ${(blob.size / 1024).toFixed(0)} KB - ready to submit`;
      };

      recorder.start();
      const startedAt = Date.now();
      ticker = setInterval(() => {
        status.textContent = `recording... ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
      }, 100);

      recBtn.disabled = true;
      recBtn.classList.add('recording');
      stopBtn.disabled = false;
    } catch (e) {
      status.textContent = `microphone unavailable: ${e.message}`;
    }
  });

  stopBtn.addEventListener('click', () => {
    if (recorder?.state === 'recording') recorder.stop();
    clearInterval(ticker);
    recBtn.disabled = false;
    recBtn.classList.remove('recording');
    stopBtn.disabled = true;
  });
})();
