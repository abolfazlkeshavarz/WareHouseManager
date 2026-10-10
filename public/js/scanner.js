// Camera QR scanner. Uses the native BarcodeDetector when available (Chrome/Android), jsQR otherwise (iOS Safari etc.).

let jsqrPromise;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsqrPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jsQR.js';
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => reject(new Error('بارگذاری اسکنر ناموفق بود.'));
    document.head.append(s);
  });
  return jsqrPromise;
}

export function cameraSupport() {
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: 'unsupported' };
  return { ok: true };
}

export class QrScanner {
  /**
   * @param {HTMLVideoElement} video
   * @param {(text: string) => void} onCode
   */
  constructor(video, onCode) {
    this.video = video;
    this.onCode = onCode;
    this.stream = null;
    this.running = false;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.detector = null;
    this.lastText = '';
    this.lastAt = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', 'true');
    await this.video.play();
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) this.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch { /* fall back to jsQR */ }
    }
    if (!this.detector) await loadJsQR();
    this.running = true;
    this.loop();
  }

  get torchSupported() {
    const track = this.stream?.getVideoTracks()[0];
    return !!track?.getCapabilities?.().torch;
  }

  async setTorch(on) {
    const track = this.stream?.getVideoTracks()[0];
    if (track) await track.applyConstraints({ advanced: [{ torch: on }] });
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  emit(text) {
    const now = Date.now();
    // same code seen again within 2.5 s = still pointing at the same label, ignore
    if (text === this.lastText && now - this.lastAt < 2500) { this.lastAt = now; return; }
    this.lastText = text;
    this.lastAt = now;
    this.onCode(text);
  }

  async loop() {
    let last = 0;
    const tick = async (ts) => {
      if (!this.running) return;
      if (ts - last > 110 && this.video.readyState >= 2) {
        last = ts;
        try {
          if (this.detector) {
            const codes = await this.detector.detect(this.video);
            if (codes.length) this.emit(codes[0].rawValue);
          } else {
            const vw = this.video.videoWidth, vh = this.video.videoHeight;
            if (vw && vh) {
              const scale = Math.min(1, 640 / vw);
              const w = Math.round(vw * scale), hgt = Math.round(vh * scale);
              if (this.canvas.width !== w) { this.canvas.width = w; this.canvas.height = hgt; }
              this.ctx.drawImage(this.video, 0, 0, w, hgt);
              const img = this.ctx.getImageData(0, 0, w, hgt);
              const res = window.jsQR(img.data, w, hgt, { inversionAttempts: 'dontInvert' });
              if (res?.data) this.emit(res.data);
            }
          }
        } catch { /* a bad frame is not fatal */ }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

export function feedback(ok = true) {
  try { navigator.vibrate?.(ok ? 60 : [80, 60, 80]); } catch { /* ignore */ }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    feedback.ctx ??= new Ctx();
    const ctx = feedback.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.09 : 0.25));
  } catch { /* ignore */ }
}
