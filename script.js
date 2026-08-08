/* =========================================================================
   AI FACE STUDIO — script.js
   - Face tracking: vladmandic/human (468-pt face mesh, on-device, WebGL)
   - Rendering: Canvas 2D (video frame + procedural filter overlays)
   - Filters are plug-in objects in FILTERS{} — add one to extend the app.

   IMPORTANT FIX vs. the previous version:
   The camera preview now starts drawing to the canvas IMMEDIATELY once the
   camera permission is granted. Face tracking (the AI model) loads in the
   BACKGROUND and only adds landmark-based filters once ready. Previously the
   preview loop only started *after* the AI model finished loading, so if the
   model was slow (or failed) to load, the screen stayed black even though the
   camera was on. Now you always see your face right away.
   ========================================================================= */

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const carousel = document.getElementById('carousel');
const gallery = document.getElementById('gallery');
const shutterBtn = document.getElementById('shutterBtn');
const flipBtn = document.getElementById('flipBtn');
const photoModeBtn = document.getElementById('photoModeBtn');
const videoModeBtn = document.getElementById('videoModeBtn');
const permissionGate = document.getElementById('permissionGate');
const enableBtn = document.getElementById('enableBtn');
const faceDot = document.getElementById('faceDot');
const faceStatus = document.getElementById('faceStatus');
const aiStatusPill = document.getElementById('aiStatusPill');
const aiDot = document.getElementById('aiDot');
const aiStatus = document.getElementById('aiStatus');
const fpsBadge = document.getElementById('fpsBadge');
const recBadge = document.getElementById('recBadge');
const recTimer = document.getElementById('recTimer');
const toastEl = document.getElementById('toast');
const serverNotice = document.getElementById('serverNotice');
const serverNoticeClose = document.getElementById('serverNoticeClose');
const diagnosticsBox = document.getElementById('diagnosticsBox');
const diagnosticsText = document.getElementById('diagnosticsText');
const diagnosticsCopyBtn = document.getElementById('diagnosticsCopyBtn');
const isFileProtocol = location.protocol === 'file:';

function checkWebglSupport() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch (e) { return false; }
}
const hasWebgl = checkWebglSupport();

if (isFileProtocol) {
  serverNotice.classList.add('show');
}
serverNoticeClose.addEventListener('click', () => serverNotice.classList.remove('show'));

diagnosticsCopyBtn.addEventListener('click', () => {
  diagnosticsText.select();
  try {
    document.execCommand('copy');
    toast('Copied! Paste it wherever you need to share it.');
  } catch (e) {
    toast('Could not copy automatically, please select the text and copy it by hand.');
  }
});
const captureModal = document.getElementById('captureModal');
const modalPreview = document.getElementById('modalPreview');
const modalDownloadBtn = document.getElementById('modalDownloadBtn');
const modalClose = document.getElementById('modalClose');
const modalTitle = document.getElementById('modalTitle');
const modalMeta = document.getElementById('modalMeta');

let stream = null;
let facingMode = 'user';
let mode = 'photo';
let activeFilterId = 'none';
let latestFace = null;
let humanReady = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordStartTime = 0;
let recordTimerHandle = null;
let isRecording = false;
let pendingDownload = null; // { url, filename }

function toast(msg, ms = 2400) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ---------- Landmark math helpers ----------
const P = (mesh, i) => mesh[i];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const angleOf = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);

// Standard 468-pt face-mesh indices (same topology MediaPipe/Human both use)
const IDX = {
  faceOval: [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109],
  leftEyeInner: 133, leftEyeOuter: 33,
  rightEyeInner: 362, rightEyeOuter: 263,
  cheekL: 234, cheekR: 454,
  forehead: 10, noseTip: 1, chin: 152,
  noseBottom: 2, nostrilL: 98, nostrilR: 327,
  mouthL: 61, mouthR: 291, mouthTop: 0, mouthBottom: 17,
  eyeBottomL: 145, eyeBottomR: 374,
};

// ---------- Sticker image processing ----------
// The uploaded doodle images are plain JPEGs with a light background (some
// with a visible gray and white checkerboard baked in from being exported
// out of an image editor with transparency showing). "multiply" blending
// only hides a perfectly pure white background, so anything else (like that
// checkerboard) was showing up as a solid gray box on your face, and if the
// actual drawing only fills part of the image, sizing by the full image
// dimensions made the sticker look huge and misplaced.
//
// Fix: for each sticker, once its image loads, this flood fills the light
// colored background starting from the four edges (so it only removes the
// connected background, not light colors inside the drawing itself), turns
// it fully transparent, then crops tightly to the remaining artwork so the
// size and position you set are based on the actual drawing, not padding.
const stickerCache = {};

function processSticker(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  octx.drawImage(img, 0, 0);
  const imageData = octx.getImageData(0, 0, w, h);
  const data = imageData.data;

  const isBackground = (i) => data[i * 4] > 190 && data[i * 4 + 1] > 190 && data[i * 4 + 2] > 190;
  const visited = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x); stack.push(x + (h - 1) * w); }
  for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + (w - 1)); }

  let minX = w, minY = h, maxX = -1, maxY = -1;

  while (stack.length) {
    const idx = stack.pop();
    if (visited[idx]) continue;
    visited[idx] = 1;
    if (!isBackground(idx)) continue;
    data[idx * 4 + 3] = 0;
    const x = idx % w, y = (idx / w) | 0;
    if (x > 0) stack.push(idx - 1);
    if (x < w - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - w);
    if (y < h - 1) stack.push(idx + w);
  }
  octx.putImageData(imageData, 0, 0);

  // Bounding box of what is left opaque, so padding never affects sizing.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bbox = maxX >= minX
    ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
    : { x: 0, y: 0, w, h };

  return { canvas: off, bbox };
}

function getSticker(src) {
  if (!stickerCache[src]) {
    const entry = { ready: false, canvas: null, bbox: null };
    const img = new Image();
    img.onload = () => {
      const processed = processSticker(img);
      entry.canvas = processed.canvas;
      entry.bbox = processed.bbox;
      entry.ready = true;
    };
    img.src = src;
    stickerCache[src] = entry;
  }
  return stickerCache[src];
}

// Draws one of the uploaded doodle images onto the face at a given anchor
// point, size and rotation, using the background removed, cropped version.
// anchorY: 'center' (default) centers the artwork on (cx, cy); 'bottom' treats
// (cx, cy) as where the BOTTOM edge of the artwork should sit, which is far
// more predictable for tall images like ears (ears stick up above wherever
// (cx, cy) is, instead of the amount of "stick up" changing with each image's
// own height when centered).
function drawSticker(c, src, cx, cy, targetWidth, angle, anchorY = 'center') {
  const entry = getSticker(src);
  if (!entry.ready) return; // still processing, just skip this frame
  const { canvas, bbox } = entry;
  const targetHeight = targetWidth * (bbox.h / bbox.w);
  const topOffset = anchorY === 'bottom' ? -targetHeight : -targetHeight / 2;
  c.save();
  c.translate(cx, cy);
  c.rotate(angle);
  c.drawImage(canvas, bbox.x, bbox.y, bbox.w, bbox.h, -targetWidth / 2, topOffset, targetWidth, targetHeight);
  c.restore();
}

function drawEarShape(c, x, y, size, furColor, innerColor, flip) {
  c.save();
  c.translate(x, y);
  if (flip) c.scale(-1, 1);
  c.fillStyle = furColor;
  c.beginPath();
  c.moveTo(0, 0);
  c.quadraticCurveTo(-size * 0.55, -size * 0.85, -size * 0.08, -size * 1.35);
  c.quadraticCurveTo(size * 0.35, -size * 0.85, 0, 0);
  c.closePath();
  c.fill();
  c.fillStyle = innerColor;
  c.beginPath();
  c.ellipse(-size * 0.13, -size * 0.72, size * 0.16, size * 0.32, 0.35, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

function drawFlower(c, x, y, size, color) {
  c.save();
  c.translate(x, y);
  for (let p = 0; p < 5; p++) {
    c.save();
    c.rotate((p / 5) * Math.PI * 2);
    c.fillStyle = color;
    c.beginPath();
    c.ellipse(0, -size * 0.55, size * 0.42, size * 0.55, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
  c.fillStyle = '#FFD24C';
  c.beginPath();
  c.arc(0, 0, size * 0.32, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

function drawHeart(c, x, y, size, color) {
  c.save();
  c.translate(x, y);
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(0, size * 0.35);
  c.bezierCurveTo(size * 0.55, -size * 0.35, size * 1.25, size * 0.3, 0, size * 1.15);
  c.bezierCurveTo(-size * 1.25, size * 0.3, -size * 0.55, -size * 0.35, 0, size * 0.35);
  c.fill();
  c.restore();
}

// ---------- FILTER REGISTRY (the extensibility point) ----------
// icon: either { emoji: '...' } or { img: 'assets/xxx.jpeg' } — drives the carousel icon.
const FILTERS = {
  none: {
    name: 'None', icon: { emoji: '🚫' },
    draw: () => {},
  },
  bigEyes: {
    name: 'Big Eyes', icon: { img: 'assets/download.jpeg' },
    draw: (c, mesh) => {
      [[IDX.leftEyeOuter, IDX.leftEyeInner], [IDX.rightEyeOuter, IDX.rightEyeInner]].forEach(([a, b]) => {
        const pa = P(mesh, a), pb = P(mesh, b);
        const center = mid(pa, pb);
        const eyeSpan = dist(pa, pb);
        const destSize = eyeSpan * 2.5;
        const srcSize = destSize / 1.55;
        c.save();
        c.beginPath();
        c.arc(center[0], center[1], destSize / 2, 0, Math.PI * 2);
        c.clip();
        c.drawImage(video,
          center[0] - srcSize / 2, center[1] - srcSize / 2, srcSize, srcSize,
          center[0] - destSize / 2, center[1] - destSize / 2, destSize, destSize);
        c.restore();
      });
    },
  },
  slimFace: {
    name: 'Slim Face', icon: { img: 'assets/slim_face.jpeg' },
    draw: (c, mesh) => {
      const l = P(mesh, IDX.cheekL), r = P(mesh, IDX.cheekR), nose = P(mesh, IDX.noseTip);
      const faceW = dist(l, r);
      const regionW = faceW * 1.35, regionH = faceW * 1.9;
      const cx = nose[0], cy = nose[1] - regionH * 0.05;
      const squeeze = 0.86;
      c.save();
      c.beginPath();
      c.ellipse(cx, cy, regionW / 2, regionH / 2, 0, 0, Math.PI * 2);
      c.clip();
      c.drawImage(video,
        cx - regionW / 2, cy - regionH / 2, regionW, regionH,
        cx - (regionW * squeeze) / 2, cy - regionH / 2, regionW * squeeze, regionH);
      c.restore();
    },
  },
  dogEars: {
    name: 'Dog Ears', icon: { img: 'assets/dog_ears_logo.jpeg' },
    draw: (c, mesh) => {
      const faceW = dist(P(mesh, IDX.cheekL), P(mesh, IDX.cheekR));
      const l = P(mesh, IDX.cheekL), r = P(mesh, IDX.cheekR), fh = P(mesh, IDX.forehead);
      const earSize = faceW * 0.62;
      drawEarShape(c, l[0] - earSize * 0.15, fh[1] - earSize * 0.25, earSize, '#8B5A2B', '#D9A066', false);
      drawEarShape(c, r[0] + earSize * 0.15, fh[1] - earSize * 0.25, earSize, '#8B5A2B', '#D9A066', true);
      const nose = P(mesh, IDX.noseTip);
      c.fillStyle = '#2E2019';
      c.beginPath();
      c.ellipse(nose[0], nose[1], faceW * 0.085, faceW * 0.065, 0, 0, Math.PI * 2);
      c.fill();
    },
  },
  catEars: {
    name: 'Cat Ears', icon: { img: 'assets/cat_ears_logo.jpeg' },
    draw: (c, mesh) => {
      const faceW = dist(P(mesh, IDX.cheekL), P(mesh, IDX.cheekR));
      const l = P(mesh, IDX.cheekL), r = P(mesh, IDX.cheekR), fh = P(mesh, IDX.forehead);
      const s = faceW * 0.5;
      [[l[0] - s * 0.1, -1], [r[0] + s * 0.1, 1]].forEach(([x, dir]) => {
        c.save();
        c.translate(x, fh[1] - s * 0.15);
        c.fillStyle = '#3a3a42';
        c.beginPath();
        c.moveTo(0, 0);
        c.lineTo(dir * s * 0.55, -s * 1.1);
        c.lineTo(dir * s * -0.15, -s * 0.25);
        c.closePath();
        c.fill();
        c.fillStyle = '#f2a6c1';
        c.beginPath();
        c.moveTo(dir * s * 0.06, -s * 0.15);
        c.lineTo(dir * s * 0.4, -s * 0.85);
        c.lineTo(dir * s * -0.02, -s * 0.28);
        c.closePath();
        c.fill();
        c.restore();
      });
      const cheekMidL = P(mesh, 205), cheekMidR = P(mesh, 425);
      c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 1.6;
      [cheekMidL, cheekMidR].forEach((pt, i) => {
        const dir = i === 0 ? -1 : 1;
        for (let k = -1; k <= 1; k++) {
          c.beginPath();
          c.moveTo(pt[0], pt[1] + k * faceW * 0.03);
          c.lineTo(pt[0] + dir * faceW * 0.35, pt[1] + k * faceW * 0.07);
          c.stroke();
        }
      });
    },
  },
  glasses: {
    name: 'Glasses', icon: { img: 'assets/glasses.jpeg' },
    draw: (c, mesh) => {
      const le = P(mesh, IDX.leftEyeOuter), re = P(mesh, IDX.rightEyeOuter);
      const center = mid(le, re);
      const angle = angleOf(le, re);
      const w = dist(le, re) * 2.6;
      drawSticker(c, 'assets/glasses.jpeg', center[0], center[1], w, angle);
    },
  },
  crown: {
    name: 'Crown', icon: { img: 'assets/crown.jpeg' },
    draw: (c, mesh) => {
      const fh = P(mesh, IDX.forehead);
      const faceW = dist(P(mesh, IDX.cheekL), P(mesh, IDX.cheekR));
      const w = faceW * 1.35, h = faceW * 0.62;
      const x = fh[0] - w / 2, y = fh[1] - h * 1.25;
      c.save();
      c.fillStyle = '#FFD24C'; c.strokeStyle = '#B8860B'; c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x, y + h);
      c.lineTo(x, y + h * 0.35);
      c.lineTo(x + w * 0.2, y + h * 0.72);
      c.lineTo(x + w * 0.35, y);
      c.lineTo(x + w * 0.5, y + h * 0.6);
      c.lineTo(x + w * 0.65, y);
      c.lineTo(x + w * 0.8, y + h * 0.72);
      c.lineTo(x + w, y + h * 0.35);
      c.lineTo(x + w, y + h);
      c.closePath();
      c.fill(); c.stroke();
      ['#E74C3C', '#3498DB', '#2ECC71'].forEach((col, i) => {
        c.fillStyle = col;
        c.beginPath();
        c.arc(x + w * (0.3 + i * 0.2), y + h * 0.78, w * 0.035, 0, Math.PI * 2);
        c.fill();
      });
      c.restore();
    },
  },
  flowerCrown: {
    name: 'Flower Crown', icon: { img: 'assets/flower_logo.png' },
    draw: (c, mesh) => {
      const fh = P(mesh, IDX.forehead);
      const faceW = dist(P(mesh, IDX.cheekL), P(mesh, IDX.cheekR));
      const angle = angleOf(P(mesh, IDX.leftEyeOuter), P(mesh, IDX.rightEyeOuter));
      const colors = ['#FF6B6B', '#FFD93D', '#6BCBFF', '#FF8FCB', '#8B5CF6', '#FF6B6B'];
      const count = 6;
      c.save();
      c.translate(fh[0], fh[1] - faceW * 0.1);
      c.rotate(angle);
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1) - 0.5;
        const x = t * faceW * 1.15;
        const y = -Math.cos(t * Math.PI * 0.9) * faceW * 0.12;
        drawFlower(c, x, y, faceW * 0.11, colors[i % colors.length]);
      }
      c.restore();
    },
  },
  mustache: {
    name: 'Mustache', icon: { img: 'assets/mustache.jpeg' },
    draw: (c, mesh) => {
      const l = P(mesh, IDX.mouthL), r = P(mesh, IDX.mouthR);
      const angle = angleOf(l, r);
      const cx = (l[0] + r[0]) / 2, cy = (l[1] + r[1]) / 2 - dist(l, r) * 0.15;
      drawSticker(c, 'assets/mustache.jpeg', cx, cy, dist(l, r) * 2.2, angle);
    },
  },
  beard: {
    name: 'Beard', icon: { img: 'assets/beard_logo.png' },
    draw: (c, mesh) => {
      const l = P(mesh, IDX.mouthL), r = P(mesh, IDX.mouthR);
      const chin = P(mesh, IDX.chin);
      const angle = angleOf(l, r);
      const faceW = dist(P(mesh, IDX.cheekL), P(mesh, IDX.cheekR));
      const cx = chin[0], cy = (chin[1] + mid(l, r)[1]) / 2;
      c.save();
      c.translate(cx, cy);
      c.rotate(angle);
      c.fillStyle = '#3B2A1F';
      c.beginPath();
      c.moveTo(-faceW * 0.42, -faceW * 0.22);
      c.quadraticCurveTo(-faceW * 0.5, faceW * 0.15, -faceW * 0.22, faceW * 0.42);
      c.quadraticCurveTo(0, faceW * 0.52, faceW * 0.22, faceW * 0.42);
      c.quadraticCurveTo(faceW * 0.5, faceW * 0.15, faceW * 0.42, -faceW * 0.22);
      c.quadraticCurveTo(0, -faceW * 0.05, -faceW * 0.42, -faceW * 0.22);
      c.closePath();
      c.fill();
      c.restore();
    },
  },
  heartEyes: {
    name: 'Heart Eyes', icon: { img: 'assets/heart_eyes.jpeg' },
    draw: (c, mesh) => {
      const lc = mid(P(mesh, IDX.leftEyeOuter), P(mesh, IDX.leftEyeInner));
      const rc = mid(P(mesh, IDX.rightEyeOuter), P(mesh, IDX.rightEyeInner));
      const eyeSpan = dist(P(mesh, IDX.leftEyeOuter), P(mesh, IDX.leftEyeInner));
      drawHeart(c, lc[0], lc[1] - eyeSpan * 0.55, eyeSpan * 0.95, '#FF3B6B');
      drawHeart(c, rc[0], rc[1] - eyeSpan * 0.55, eyeSpan * 0.95, '#FF3B6B');
    },
  },
  bigNostrils: {
    name: 'Big Nostrils', icon: { img: 'assets/big_nostrils.jpeg' },
    draw: (c, mesh) => {
      const nl = P(mesh, IDX.nostrilL), nr = P(mesh, IDX.nostrilR), bottom = P(mesh, IDX.noseBottom);
      const faceW = dist(P(mesh, IDX.cheekL), P(mesh, IDX.cheekR));
      const r = faceW * 0.075;
      [nl, nr].forEach((p) => {
        // slightly zoom the nostril area for an exaggerated "goofy" look, then draw a dark ellipse on top
        const zoomSize = r * 3.6;
        c.save();
        c.beginPath();
        c.ellipse(p[0], p[1] + r * 0.2, r * 1.9, r * 1.5, 0, 0, Math.PI * 2);
        c.clip();
        c.drawImage(video,
          p[0] - zoomSize / 2, p[1] - zoomSize / 2, zoomSize, zoomSize,
          p[0] - zoomSize / 1.35, p[1] - zoomSize / 1.35, zoomSize * 1.5, zoomSize * 1.5);
        c.restore();

        c.save();
        c.fillStyle = 'rgba(35,20,20,0.85)';
        c.beginPath();
        c.ellipse(p[0], p[1] + r * 0.25, r, r * 0.8, 0, 0, Math.PI * 2);
        c.fill();
        c.restore();
      });
    },
  },
};

function buildCarousel() {
  carousel.innerHTML = '';
  Object.entries(FILTERS).forEach(([id, f]) => {
    const btn = document.createElement('button');
    btn.className = 'filter-chip' + (id === activeFilterId ? ' active' : '');
    btn.dataset.id = id;
    const iconHtml = f.icon.img
      ? `<img src="${f.icon.img}" alt="${f.name}" />`
      : f.icon.emoji;
    btn.innerHTML = `<div class="filter-icon">${iconHtml}</div><div class="filter-name">${f.name}</div>`;
    btn.addEventListener('click', () => {
      activeFilterId = id;
      [...carousel.children].forEach(ch => ch.classList.toggle('active', ch.dataset.id === id));
    });
    carousel.appendChild(btn);
  });
}
buildCarousel();

// ---------- Human.js (on-device face mesh) — loads in the BACKGROUND ----------
// Model files are bundled locally in models/ (next to this script) so the app
// works fully offline and is not at the mercy of a network blocking a CDN,
// which was the actual root cause of face detection never starting before.
const MODEL_SOURCES = [
  'models/',
];

let human = null;
let consecutiveDetectFailures = 0;

function setAiStatus(state, text) {
  aiStatus.textContent = text;
  aiDot.className = 'dot' + (state === 'loading' ? ' loading' : state === 'ready' ? ' live' : '');
  aiStatusPill.classList.toggle('failed', state === 'failed');
  aiStatusPill.classList.toggle('ready', state === 'ready');
}

function showDiagnostics(errors) {
  const lines = [
    `Page address type: ${location.protocol}`,
    `WebGL available: ${hasWebgl ? 'yes' : 'no'}`,
    `Browser: ${navigator.userAgent}`,
    '',
    ...errors.map(e => `Tried ${e.source} using ${e.backend} backend: ${e.message}`),
  ];
  diagnosticsText.value = lines.join('\n');
  diagnosticsBox.classList.add('show');
}

async function initHuman() {
  setAiStatus('loading', 'waking up the ai 🧠');
  diagnosticsBox.classList.remove('show');
  const backend = hasWebgl ? 'webgl' : 'cpu';
  const errors = [];

  for (const modelBasePath of MODEL_SOURCES) {
    try {
      console.log('[AI Face Studio] trying model source:', modelBasePath, 'backend:', backend);
      // The bundled lib/human.js exposes a namespace object on window.Human,
      // whose actual class is Human.Human (this is what "Human is not a
      // constructor" was telling us: window.Human itself is not callable).
      const HumanClass = window.Human.Human || window.Human.default;
      human = new HumanClass({
        modelBasePath,
        backend,
        warmup: 'none',
        debug: false,
        face: {
          enabled: true,
          detector: { rotation: true, maxDetected: 1 },
          mesh: { enabled: true },
          iris: { enabled: false },
          description: { enabled: false },
          emotion: { enabled: false },
          antispoof: { enabled: false },
          liveness: { enabled: false },
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        gesture: { enabled: false },
        segmentation: { enabled: false },
      });
      await human.load();
      humanReady = true;
      consecutiveDetectFailures = 0;
      setAiStatus('ready', 'filters ready ✅');
      diagnosticsBox.classList.remove('show');
      console.log('[AI Face Studio] model loaded successfully from', modelBasePath, 'using', backend);
      detectionLoop();
      return;
    } catch (e) {
      console.error('[AI Face Studio] model source failed:', modelBasePath, e);
      errors.push({ source: modelBasePath, backend, message: (e && e.message) ? e.message : String(e) });
    }
  }
  // Every source failed.
  humanReady = false;
  showDiagnostics(errors);
  if (isFileProtocol) {
    setAiStatus('failed', 'needs local server, see notice above ⚠️');
    serverNotice.classList.add('show');
    toast('Filters need this page served over a local address, not opened directly as a file. See the yellow notice at the top for the fix.', 6000);
  } else {
    setAiStatus('failed', 'filters offline, tap to retry ⚠️');
    toast('Could not load the face tracking model. See the pink details box below the header for the exact reason.', 5500);
  }
}

async function detectionLoop() {
  if (!humanReady) return;
  if (video.readyState >= 2 && video.videoWidth > 0) {
    try {
      const result = await human.detect(video);
      consecutiveDetectFailures = 0;
      if (result.face && result.face.length > 0) {
        latestFace = result.face[0];
        faceDot.classList.add('live');
        faceStatus.textContent = 'gotcha! 🎯';
      } else {
        latestFace = null;
        faceDot.classList.remove('live');
        faceStatus.textContent = 'no face yet 👀';
      }
    } catch (e) {
      consecutiveDetectFailures++;
      console.error('[AI Face Studio] detection error:', e);
      // A handful of one off errors is normal (e.g. a frame mid decode).
      // If it fails repeatedly in a row, something is actually wrong,
      // so say so instead of pretending everything is fine forever.
      if (consecutiveDetectFailures === 30) {
        setAiStatus('failed', 'filters glitched, tap to retry ⚠️');
        toast('Face tracking keeps failing. Tap the AI badge up top to restart it.', 5000);
      }
    }
  }
  requestAnimationFrame(detectionLoop);
}

aiStatusPill.addEventListener('click', () => {
  if (!humanReady) {
    humanReady = false;
    consecutiveDetectFailures = 0;
    initHuman();
  }
});

// ---------- Render loop — starts as soon as the camera is on, independent
//             of whether the AI face-tracking model has finished loading ----------
let lastFrameTime = performance.now();
let fpsSmoothed = 0;
let renderLoopStarted = false;

function renderLoop() {
  if (video.readyState >= 2) {
    if (canvas.width !== video.videoWidth && video.videoWidth > 0) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (latestFace && latestFace.mesh && activeFilterId !== 'none') {
      try { FILTERS[activeFilterId].draw(ctx, latestFace.mesh, canvas.width, canvas.height); }
      catch (e) { /* keep rendering even if one filter throws on an edge-case pose */ }
    }
    ctx.restore();
  }

  const now = performance.now();
  const instFps = 1000 / (now - lastFrameTime);
  fpsSmoothed = fpsSmoothed ? fpsSmoothed * 0.9 + instFps * 0.1 : instFps;
  lastFrameTime = now;
  fpsBadge.textContent = `${Math.round(fpsSmoothed)} fps`;

  requestAnimationFrame(renderLoop);
}

async function startCamera() {
  try {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 720 }, height: { ideal: 960 } },
      audio: true,
    });
    video.srcObject = stream;
    await video.play();
    permissionGate.classList.add('hidden');
    return true;
  } catch (err) {
    toast('Camera access denied or unavailable: ' + err.message, 4500);
    return false;
  }
}

enableBtn.addEventListener('click', async () => {
  enableBtn.textContent = 'one sec…';
  enableBtn.disabled = true;
  const ok = await startCamera();
  if (ok) {
    // Preview starts immediately — this is the fix for "my face is not shown".
    if (!renderLoopStarted) { renderLoopStarted = true; renderLoop(); }
    // Face-tracking model loads separately in the background.
    if (!human) initHuman();
  } else {
    enableBtn.textContent = 'Turn On Camera';
    enableBtn.disabled = false;
  }
});

flipBtn.addEventListener('click', async () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  await startCamera();
});

photoModeBtn.addEventListener('click', () => setMode('photo'));
videoModeBtn.addEventListener('click', () => setMode('video'));
function setMode(m) {
  mode = m;
  photoModeBtn.classList.toggle('active', m === 'photo');
  videoModeBtn.classList.toggle('active', m === 'video');
}

function clearGalleryEmptyState() {
  const empty = gallery.querySelector('.gallery-empty');
  if (empty) empty.remove();
}

function downloadFile(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

function openCaptureModal({ url, filename, isVideo, title, metaText }) {
  pendingDownload = { url, filename };
  modalTitle.textContent = title;
  modalPreview.innerHTML = isVideo
    ? `<video src="${url}" controls autoplay muted loop playsinline></video>`
    : `<img src="${url}" alt="capture" />`;
  modalMeta.textContent = metaText
    ? (isVideo ? `Saved, ${metaText}. Tap play to preview.` : `Saved, ${metaText}.`)
    : '';
  captureModal.classList.add('show');
}
modalClose.addEventListener('click', () => captureModal.classList.remove('show'));
captureModal.addEventListener('click', (e) => { if (e.target === captureModal) captureModal.classList.remove('show'); });
modalDownloadBtn.addEventListener('click', () => {
  if (pendingDownload) downloadFile(pendingDownload.url, pendingDownload.filename);
});

// ---------- Capture: photo ----------
function takePhoto() {
  clearGalleryEmptyState();
  canvas.toBlob((blob) => {
    if (!blob || blob.size === 0) {
      toast('That photo came out empty. Please try again.', 4000);
      return;
    }
    const url = URL.createObjectURL(blob);
    const filename = `ai-face-studio-${Date.now()}.png`;
    const sizeLabel = blob.size > 1024 * 1024
      ? `${(blob.size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(blob.size / 1024)} KB`;

    const item = document.createElement('div');
    item.className = 'gallery-item';
    item.innerHTML = `<img src="${url}" /><span class="dl-badge">PNG</span>`;
    item.addEventListener('click', () => openCaptureModal({ url, filename, isVideo: false, title: 'Snapped it! 📸', metaText: sizeLabel }));
    gallery.prepend(item);

    openCaptureModal({ url, filename, isVideo: false, title: 'Snapped it! 📸', metaText: sizeLabel });
  }, 'image/png');
}

// ---------- Capture: video ----------
function startRecording() {
  const canvasStream = canvas.captureStream(30);
  const hasAudio = !!(stream && stream.getAudioTracks().length > 0);
  if (hasAudio) stream.getAudioTracks().forEach(t => canvasStream.addTrack(t));

  recordedChunks = [];
  let mimeType;
  try {
    mimeType = pickMimeType(hasAudio);
    mediaRecorder = new MediaRecorder(canvasStream, { mimeType });
  } catch (e) {
    console.error('[AI Face Studio] could not start recorder with', mimeType, e);
    toast('Could not start recording on this browser. Try Chrome or Edge.', 4000);
    return;
  }

  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onerror = (e) => {
    console.error('[AI Face Studio] recorder error:', e.error || e);
    toast('Recording hit an error partway through. Please try again.', 4000);
  };
  mediaRecorder.onstop = () => {
    const totalBytes = recordedChunks.reduce((sum, c) => sum + c.size, 0);
    if (totalBytes === 0) {
      console.error('[AI Face Studio] recording produced zero bytes');
      toast('That recording came out empty. Please try again, keep it a bit longer.', 4500);
      return;
    }
    clearGalleryEmptyState();
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
    const url = URL.createObjectURL(blob);
    const filename = `ai-face-studio-${Date.now()}.webm`;
    const sizeLabel = totalBytes > 1024 * 1024
      ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(totalBytes / 1024)} KB`;

    const item = document.createElement('div');
    item.className = 'gallery-item';
    item.innerHTML = `<video src="${url}" muted playsinline></video><span class="dl-badge">WEBM</span>`;
    item.addEventListener('click', () => openCaptureModal({ url, filename, isVideo: true, title: 'That was a whole mood 🎬', metaText: sizeLabel }));
    gallery.prepend(item);

    openCaptureModal({ url, filename, isVideo: true, title: 'That was a whole mood 🎬', metaText: sizeLabel });
  };
  mediaRecorder.start();
  recordStartTime = Date.now();
  recBadge.classList.add('show');
  recordTimerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - recordStartTime) / 1000);
    recTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
}

function pickMimeType(hasAudio) {
  const withAudio = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'];
  const videoOnly = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const candidates = hasAudio ? [...withAudio, ...videoOnly] : videoOnly;
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  clearInterval(recordTimerHandle);
  recBadge.classList.remove('show');
  shutterBtn.classList.remove('recording');
}

shutterBtn.addEventListener('click', () => {
  if (mode === 'photo') {
    takePhoto();
  } else {
    if (!isRecording) { startRecording(); shutterBtn.classList.add('recording'); }
    else { stopRecording(); }
    isRecording = !isRecording;
  }
});
