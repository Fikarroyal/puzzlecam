// =============================================================
// PUZZLE·CAM — Hand Gesture Capture
// Jepret foto dengan membentuk KOTAK pakai dua tangan terbuka,
// susun jadi puzzle 3x3 (pakai cubit), simpan dengan kepalan tangan,
// kumpulkan jadi strip foto dengan color grade ala cinema.
//
// Deteksi tangan: MediaPipe Tasks Vision (HandLandmarker), via CDN.
// Semua interaksi juga punya fallback mouse/touch/tombol supaya
// aplikasi tetap jalan lancar walau kamera/gestur bermasalah.
// =============================================================

/* ---------------------------------------------------------
   Konfigurasi & konstanta (boleh disetel ulang jika perlu)
--------------------------------------------------------- */
const TASKS_VISION_VERSIONS = ["0.10.17", "0.10.14"];
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const STRIP_TARGET = 3; // jumlah foto per strip
const SHATTER_COLS = 3;
const SHATTER_ROWS = 3;
const SHATTER_DURATION_MS = 850;
const COUNTDOWN_TOTAL_MS = 3000;
const CAPTURE_DWELL_MS = 700; // lama tahan bentuk kotak untuk memicu jepretan
const FIST_DWELL_MS = 600; // lama tahan kepalan untuk menyimpan
const SAVE_ANIM_MS = 460;
const MODEL_LOAD_TIMEOUT_MS = 15000; // batas waktu unduh model gestur sebelum jatuh ke mode manual
const DEBOUNCE_FRAMES = 2; // anti-flicker untuk deteksi gestur
const CINEMA_GRAIN_STD = 9; // std-dev grain film halus ala cinema
const PINCH_ON = 0.55; // rasio jarak ibu-jari/telunjuk relatif ukuran tangan (dipakai utk drag puzzle)

// --- syarat gestur "kotak tangan" (dua tangan terbuka & terentang) ---
const BOX_OPEN_MIN_FINGERS = 3; // dari 4 jari (telunjuk..kelingking) yang harus terentang
const BOX_MIN_GAP_RATIO = 0.22; // jarak minimum pusat-ke-pusat antar tangan, relatif sisi terpendek panggung (berlaku ke arah manapun)
const BOX_MIN_ASPECT = 0.5; // batas bawah rasio lebar/tinggi kotak (portrait paling ramping yang diizinkan)
const BOX_MAX_ASPECT = 2.0; // batas atas rasio lebar/tinggi kotak (landscape paling lebar yang diizinkan)
const BOX_MIN_SIZE_PX = 90; // ukuran minimum sisi kotak (px) supaya tidak kepicu oleh noise kecil

const GOLD = "#e7b84c";
const GREEN = "#3ecf8e";
const CREAM = "#f6f2e8";

// Standar 21-titik landmark tangan MediaPipe
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/* ---------------------------------------------------------
   DOM refs
--------------------------------------------------------- */
const stage = document.getElementById("stage");
const videoEl = document.getElementById("webcam");
const canvas = document.getElementById("sceneCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: false });

const statusPill = document.getElementById("statusPill");
const statusText = document.getElementById("statusText");
const progressBadge = document.getElementById("progressBadge");
const progressText = document.getElementById("progressText");
const hintBar = document.getElementById("hintBar");

const loadingOverlay = document.getElementById("loadingOverlay");
const loaderText = document.getElementById("loaderText");
const errorBanner = document.getElementById("errorBanner");
const errorText = document.getElementById("errorText");
const errorRetry = document.getElementById("errorRetry");

const captureBtn = document.getElementById("captureBtn");
const saveBtn = document.getElementById("saveBtn");

const galleryStrip = document.getElementById("galleryStrip");
const galleryEmpty = document.getElementById("galleryEmpty");
const galleryCount = document.getElementById("galleryCount");
const downloadStripBtn = document.getElementById("downloadStripBtn");
const resetAllBtn = document.getElementById("resetAllBtn");
const stripCompleteMsg = document.getElementById("stripCompleteMsg");

/* ---------------------------------------------------------
   State
--------------------------------------------------------- */
let appState = "loading"; // loading | tracking | countdown | shatter | puzzle | solved | saving | complete
let currentStream = null;
let handLandmarker = null;
let handModelState = "loading"; // loading | ready | unavailable

let coverT = null; // { scale, offsetX, offsetY, srcW, srcH }

let handPresent = false;
let boxGestureActive = false;
let liveFrameRect = null; // rect kotak tangan yang sedang dibentuk (live, ikut gerak tangan)
let lockedFrameRect = null; // rect terkunci saat countdown/capture dimulai
let captureHoldStart = null;

let pinchStable = false;
let pinchFrames = 0;
let unpinchFrames = 0;

let fistStable = false;
let fistFrames = 0;
let unfistFrames = 0;
let fistHoldStart = null;

let gestureFrame = { hands: [], pinchStable: false, pinchPoint: null, fistStable: false, fistHandLm: null };

let countdownStartedAt = 0;
let shatterStartedAt = 0;
let savingStartedAt = 0;

const processedCanvas = document.createElement("canvas");
const mirrorCanvas = document.createElement("canvas");

let slotOccupant = [0, 1, 2, 3, 4, 5, 6, 7, 8];
let pieceRotSeed = new Array(9).fill(0);
let puzzleProgress = 0;
let draggingSlot = null;
let dragOwner = null; // 'hand' | 'mouse' | null
let dragPos = { x: 0, y: 0 };

let capturedStrip = []; // { canvas, dataUrl }
let capturedCount = 0;

let rafHandle = null;

/* ---------------------------------------------------------
   Utilitas matematika & geometri
--------------------------------------------------------- */
function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pointInRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function getCaptureBoxRect() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const size = Math.min(w, h) * 0.6;
  return { x: (w - size) / 2, y: h * 0.5 - size * 0.55, w: size, h: size };
}

// Rect papan puzzle yang ditampilkan (shatter/puzzle/solved/saving) —
// mengikuti rasio aspek foto yang sebenarnya diambil (bisa potrait,
// landscape, atau persegi, sesuai bentuk kotak tangan waktu jepret),
// diskalakan supaya pas di layar.
function getBoardRect() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const maxSize = Math.min(w, h) * 0.62;
  const srcAspect =
    processedCanvas.width && processedCanvas.height
      ? processedCanvas.width / processedCanvas.height
      : 1;
  let boardW, boardH;
  if (srcAspect >= 1) {
    boardW = maxSize;
    boardH = maxSize / srcAspect;
  } else {
    boardH = maxSize;
    boardW = maxSize * srcAspect;
  }
  return { x: (w - boardW) / 2, y: h * 0.5 - boardH * 0.55, w: boardW, h: boardH };
}

function slotIndexAt(p, rect) {
  const tileW = rect.w / SHATTER_COLS;
  const tileH = rect.h / SHATTER_ROWS;
  const col = Math.floor((p.x - rect.x) / tileW);
  const row = Math.floor((p.y - rect.y) / tileH);
  if (col < 0 || col > SHATTER_COLS - 1 || row < 0 || row > SHATTER_ROWS - 1) return null;
  return row * SHATTER_COLS + col;
}

/* ---------------------------------------------------------
   Transform kamera (object-fit: cover) <-> koordinat panggung
--------------------------------------------------------- */
function updateCoverTransform() {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return;
  const dw = stage.clientWidth;
  const dh = stage.clientHeight;
  const scale = Math.max(dw / vw, dh / vh);
  coverT = {
    scale,
    offsetX: (dw - vw * scale) / 2,
    offsetY: (dh - vh * scale) / 2,
    srcW: vw,
    srcH: vh,
  };
}

// landmark (0..1, sudut kamera asli) -> koordinat CSS px di panggung (mengikuti tampilan mirror)
function landmarkToStage(lm) {
  if (!coverT) return { x: 0, y: 0 };
  const mx = (1 - lm.x) * coverT.srcW;
  const my = lm.y * coverT.srcH;
  return { x: mx * coverT.scale + coverT.offsetX, y: my * coverT.scale + coverT.offsetY };
}

// rect di ruang panggung -> rect sumber video (dalam ruang termirror)
function stageRectToSource(rect) {
  if (!coverT) return { x: 0, y: 0, w: 1, h: 1 };
  const x = (rect.x - coverT.offsetX) / coverT.scale;
  const y = (rect.y - coverT.offsetY) / coverT.scale;
  const w = rect.w / coverT.scale;
  const h = rect.h / coverT.scale;
  const cx = clamp(x, 0, coverT.srcW);
  const cy = clamp(y, 0, coverT.srcH);
  const cw = Math.max(1, Math.min(w, coverT.srcW - cx));
  const ch = Math.max(1, Math.min(h, coverT.srcH - cy));
  return { x: cx, y: cy, w: cw, h: ch };
}

function resizeCanvasIfNeeded() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (canvas._cssW === w && canvas._cssH === h && canvas._dpr === dpr) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvas._cssW = w;
  canvas._cssH = h;
  canvas._dpr = dpr;
  updateCoverTransform();
}

/* ---------------------------------------------------------
   Gestur tangan
--------------------------------------------------------- */
function palmScale(lm) { return dist(lm[0], lm[9]) || 0.0001; }

function isFistHand(lm) {
  const scale = palmScale(lm);
  const tips = [8, 12, 16, 20];
  return tips.every((t) => dist(lm[t], lm[0]) < scale * 1.35);
}

function pinchAmount(lm) {
  return dist(lm[4], lm[8]) / palmScale(lm);
}

function handBoundingBox(lm) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pt of lm) {
    const p = landmarkToStage(pt);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = 18;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

// Tangan dianggap "terbuka" kalau minimal 3 dari 4 jari (telunjuk..kelingking)
// terentang jauh dari pergelangan dibanding ukuran telapak.
function isHandOpen(lm) {
  const scale = palmScale(lm);
  const tips = [8, 12, 16, 20];
  const extended = tips.filter((t) => dist(lm[t], lm[0]) > scale * 1.15).length;
  return extended >= BOX_OPEN_MIN_FINGERS;
}

// Deteksi gestur "kotak": dua tangan TERBUKA yang cukup berjauhan satu sama
// lain, ke arah manapun — kiri-kanan (landscape), atas-bawah (potrait), atau
// diagonal (jadi persegi). Bentuk & orientasi kotaknya mengikuti bebas posisi
// kedua tangan; rasionya cuma dibatasi supaya tidak jadi gepeng ekstrem.
// Mengembalikan rect (ruang panggung), atau null kalau syarat belum terpenuhi.
function computeBoxGesture(hands) {
  if (hands.length < 2) return null;

  const infos = hands.map((lm) => {
    const bb = handBoundingBox(lm);
    return { bb, cx: bb.x + bb.w / 2, cy: bb.y + bb.h / 2, open: isHandOpen(lm) };
  });
  if (!infos.every((h) => h.open)) return null;

  const [a, b] = infos;
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;

  // dua tangan harus benar-benar terentang berjauhan (ke arah manapun),
  // bukan cuma berdempetan di satu titik.
  const centerGap = Math.hypot(a.cx - b.cx, a.cy - b.cy);
  if (centerGap < Math.min(stageW, stageH) * BOX_MIN_GAP_RATIO) return null;

  const x = Math.min(a.bb.x, b.bb.x);
  const y = Math.min(a.bb.y, b.bb.y);
  const right = Math.max(a.bb.x + a.bb.w, b.bb.x + b.bb.w);
  const bottom = Math.max(a.bb.y + a.bb.h, b.bb.y + b.bb.h);

  const rawCx = (x + right) / 2;
  const rawCy = (y + bottom) / 2;
  let w = right - x;
  let h = bottom - y;
  if (w < BOX_MIN_SIZE_PX || h < BOX_MIN_SIZE_PX) return null;

  // jaga rasio tetap wajar (izinkan potrait, landscape, maupun persegi —
  // cuma cegah bentuk yang kelewat gepeng/ramping)
  const rawAspect = w / h;
  const clampedAspect = clamp(rawAspect, BOX_MIN_ASPECT, BOX_MAX_ASPECT);
  if (clampedAspect !== rawAspect) {
    if (rawAspect > clampedAspect) w = h * clampedAspect;
    else h = w / clampedAspect;
  }

  return { x: rawCx - w / 2, y: rawCy - h / 2, w, h };
}

function updateGestureState(hands, now) {
  handPresent = hands.length > 0;

  // ---- pinch: cari tangan dengan jarak cubit terkecil ----
  let bestPinch = null;
  let bestAmount = Infinity;
  for (const lm of hands) {
    const amt = pinchAmount(lm);
    if (amt < bestAmount) { bestAmount = amt; bestPinch = lm; }
  }
  const rawPinching = !!bestPinch && bestAmount < PINCH_ON;
  if (rawPinching) { pinchFrames++; unpinchFrames = 0; } else { unpinchFrames++; pinchFrames = 0; }
  if (pinchFrames >= DEBOUNCE_FRAMES) pinchStable = true;
  if (unpinchFrames >= DEBOUNCE_FRAMES) pinchStable = false;

  let pinchPoint = null;
  if (pinchStable && bestPinch) {
    const a = landmarkToStage(bestPinch[4]);
    const b = landmarkToStage(bestPinch[8]);
    pinchPoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // ---- drag puzzle piece via pinch ----
  if (appState === "puzzle") {
    if (pinchStable && pinchPoint) {
      if (dragOwner === null) tryPickup(pinchPoint, "hand");
      else if (dragOwner === "hand") dragPos = pinchPoint;
    } else if (dragOwner === "hand") {
      dropPiece(dragPos || pinchPoint || { x: -9999, y: -9999 });
    }
  }

  // ---- tahan bentuk kotak (dua tangan terbuka) untuk memicu jepretan ----
  if (appState === "tracking" && capturedCount < STRIP_TARGET) {
    const boxRect = computeBoxGesture(hands);
    boxGestureActive = !!boxRect;
    liveFrameRect = boxRect;
    if (boxRect) {
      if (captureHoldStart === null) captureHoldStart = now;
      if (now - captureHoldStart >= CAPTURE_DWELL_MS) {
        captureHoldStart = null;
        lockedFrameRect = boxRect;
        startCountdown();
      }
    } else {
      captureHoldStart = null;
    }
  } else if (appState !== "countdown") {
    captureHoldStart = null;
    boxGestureActive = false;
    liveFrameRect = null;
  }

  // ---- kepalan tangan (fist) ----
  let fistHandLm = null;
  for (const lm of hands) { if (isFistHand(lm)) { fistHandLm = lm; break; } }
  const rawFist = !!fistHandLm;
  if (rawFist) { fistFrames++; unfistFrames = 0; } else { unfistFrames++; fistFrames = 0; }
  if (fistFrames >= DEBOUNCE_FRAMES) fistStable = true;
  if (unfistFrames >= DEBOUNCE_FRAMES) fistStable = false;

  if (appState === "solved") {
    if (fistStable) {
      if (fistHoldStart === null) fistHoldStart = now;
      else if (now - fistHoldStart >= FIST_DWELL_MS) {
        fistHoldStart = null;
        saveCompletedPuzzle();
      }
    } else {
      fistHoldStart = null;
    }
  } else {
    fistHoldStart = null;
  }

  gestureFrame = { hands, pinchStable, pinchPoint, fistStable, fistHandLm };
}

/* ---------------------------------------------------------
   Drag & drop keping puzzle (dipakai oleh pinch & pointer)
--------------------------------------------------------- */
function tryPickup(p, source) {
  if (dragOwner !== null) return false;
  if (appState !== "puzzle") return false;
  const rect = getBoardRect();
  if (!pointInRect(p, rect)) return false;
  const slot = slotIndexAt(p, rect);
  if (slot === null) return false;
  draggingSlot = slot;
  dragOwner = source;
  dragPos = p;
  return true;
}

function dropPiece(p) {
  if (dragOwner === null) return;
  const rect = getBoardRect();
  const targetSlot = pointInRect(p, rect) ? slotIndexAt(p, rect) : null;
  if (targetSlot !== null && targetSlot !== draggingSlot) {
    const tmp = slotOccupant[draggingSlot];
    slotOccupant[draggingSlot] = slotOccupant[targetSlot];
    slotOccupant[targetSlot] = tmp;
  }
  draggingSlot = null;
  dragOwner = null;
  recomputeProgress();
}

function recomputeProgress() {
  puzzleProgress = slotOccupant.reduce((acc, pieceIdx, slot) => acc + (pieceIdx === slot ? 1 : 0), 0);
  if (puzzleProgress === SHATTER_COLS * SHATTER_ROWS && appState === "puzzle") {
    appState = "solved";
  }
}

/* Fallback mouse / touch untuk menyusun puzzle */
function getLocalPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
canvas.addEventListener("pointerdown", (e) => {
  if (appState !== "puzzle") return;
  const p = getLocalPoint(e);
  if (tryPickup(p, "mouse")) {
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (dragOwner === "mouse") { dragPos = getLocalPoint(e); e.preventDefault(); }
});
function endMouseDrag(e) { if (dragOwner === "mouse") dropPiece(getLocalPoint(e)); }
canvas.addEventListener("pointerup", endMouseDrag);
canvas.addEventListener("pointercancel", endMouseDrag);

/* ---------------------------------------------------------
   Efek cinema: filmic contrast + color grade teal-orange + grain halus + vignette
--------------------------------------------------------- */
function gaussianNoise(std) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function applyCinematicGrade(pctx, w, h) {
  const imgData = pctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const contrast = 1.14;
  const cx = w / 2;
  const cy = h / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy);

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];

    // kontras filmic lembut
    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;

    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    // color grade khas cinema: bayangan condong teal, highlight condong hangat/oranye
    const shadow = clamp(1 - lum / 120, 0, 1);
    const highlight = clamp((lum - 140) / 115, 0, 1);
    r += highlight * 16 - shadow * 4;
    g += highlight * 4 - shadow * 2;
    b += shadow * 18 - highlight * 14;

    // sedikit desaturasi supaya terasa filmic, bukan warna mentah kamera
    r = lerp(r, lum, 0.12);
    g = lerp(g, lum, 0.12);
    b = lerp(b, lum, 0.12);

    // grain halus (noise sama di 3 kanal supaya warnanya tetap bersih, tidak belang)
    const n = gaussianNoise(CINEMA_GRAIN_STD);
    r += n; g += n; b += n;

    // vignette lembut di tepi
    const px = (i / 4) % w;
    const py = Math.floor(i / 4 / w);
    const distFrac = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2) / maxDist;
    const vig = 1 - Math.pow(distFrac, 2.2) * 0.32;

    d[i] = clamp(r * vig, 0, 255);
    d[i + 1] = clamp(g * vig, 0, 255);
    d[i + 2] = clamp(b * vig, 0, 255);
  }
  pctx.putImageData(imgData, 0, 0);
}

/* ---------------------------------------------------------
   Alur: capture -> shatter -> puzzle -> solved -> saving
--------------------------------------------------------- */
function startCountdown() {
  if (appState !== "tracking" || capturedCount >= STRIP_TARGET) return;
  appState = "countdown";
  countdownStartedAt = performance.now();
}

function performCapture() {
  const rect = lockedFrameRect || getCaptureBoxRect();
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) { appState = "tracking"; return; }

  mirrorCanvas.width = vw;
  mirrorCanvas.height = vh;
  const mctx = mirrorCanvas.getContext("2d");
  mctx.save();
  mctx.translate(vw, 0);
  mctx.scale(-1, 1);
  mctx.drawImage(videoEl, 0, 0, vw, vh);
  mctx.restore();

  const src = stageRectToSource(rect);
  const OUT_BASE = 720;
  const aspect = rect.w / rect.h;
  const outW = aspect >= 1 ? OUT_BASE : Math.round(OUT_BASE * aspect);
  const outH = aspect >= 1 ? Math.round(OUT_BASE / aspect) : OUT_BASE;
  processedCanvas.width = outW;
  processedCanvas.height = outH;
  const pctx = processedCanvas.getContext("2d");
  pctx.drawImage(mirrorCanvas, src.x, src.y, src.w, src.h, 0, 0, outW, outH);
  applyCinematicGrade(pctx, outW, outH);

  lockedFrameRect = null;
  setupPuzzleFromProcessed();
  appState = "shatter";
  shatterStartedAt = performance.now();
}

function setupPuzzleFromProcessed() {
  let order = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  let tries = 0;
  do {
    shuffleArray(order);
    tries++;
  } while (order.every((v, i) => v === i) && tries < 20);
  slotOccupant = order;
  pieceRotSeed = Array.from({ length: 9 }, () => (Math.random() - 0.5) * 1.1);
  draggingSlot = null;
  dragOwner = null;
  puzzleProgress = order.reduce((acc, v, i) => acc + (v === i ? 1 : 0), 0);
}

function saveCompletedPuzzle() {
  if (appState !== "solved") return;
  appState = "saving";
  savingStartedAt = performance.now();
}

function cloneCanvas(src) {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

function finalizeSave() {
  const snap = cloneCanvas(processedCanvas);
  const dataUrl = snap.toDataURL("image/png");
  capturedStrip.push({ canvas: snap, dataUrl });
  capturedCount = capturedStrip.length;

  renderGalleryItem(capturedStrip[capturedStrip.length - 1], capturedCount);
  galleryCount.textContent = `${capturedCount} / ${STRIP_TARGET}`;
  galleryEmpty.hidden = capturedCount > 0;

  if (capturedCount >= STRIP_TARGET) {
    appState = "complete";
    stripCompleteMsg.hidden = false;
    downloadStripBtn.disabled = false;
  } else {
    appState = "tracking";
  }
}

/* ---------------------------------------------------------
   Sidebar / strip foto
--------------------------------------------------------- */
function renderGalleryItem(item, index) {
  const el = document.createElement("div");
  el.className = "strip-item";
  const img = document.createElement("img");
  img.src = item.dataUrl;
  img.alt = `Puzzle tersimpan ${index}`;
  img.style.aspectRatio = `${item.canvas.width} / ${item.canvas.height}`;
  const caption = document.createElement("div");
  caption.className = "strip-item-caption";
  caption.textContent = String(index).padStart(3, "0");
  el.appendChild(img);
  el.appendChild(caption);
  galleryStrip.appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "end" });
}

function resetAll() {
  capturedStrip = [];
  capturedCount = 0;
  galleryStrip.innerHTML = "";
  galleryEmpty.hidden = false;
  galleryCount.textContent = `0 / ${STRIP_TARGET}`;
  stripCompleteMsg.hidden = true;
  downloadStripBtn.disabled = true;

  slotOccupant = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  puzzleProgress = 0;
  draggingSlot = null;
  dragOwner = null;
  captureHoldStart = null;
  fistHoldStart = null;
  boxGestureActive = false;
  liveFrameRect = null;
  lockedFrameRect = null;

  if (appState !== "loading" && appState !== "error") appState = "tracking";
}

function downloadStrip() {
  if (capturedStrip.length === 0) return;
  const photoWidth = 640;
  const pad = 36, gap = 28, captionH = 34, footerH = 74;

  // hitung tinggi tiap foto sesuai rasio aslinya (bisa beda-beda: potrait/landscape/persegi)
  const heights = capturedStrip.map((item) => Math.round(photoWidth * (item.canvas.height / item.canvas.width)));
  const width = photoWidth + pad * 2;
  const height =
    pad + heights.reduce((sum, h) => sum + h + captionH + gap, 0) - gap + footerH + pad;

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const octx = out.getContext("2d");
  octx.fillStyle = CREAM;
  octx.fillRect(0, 0, width, height);

  let y = pad;
  capturedStrip.forEach((item, i) => {
    const photoHeight = heights[i];
    octx.save();
    octx.shadowColor = "rgba(32,29,22,0.22)";
    octx.shadowBlur = 18;
    octx.shadowOffsetY = 6;
    octx.fillStyle = "#ffffff";
    octx.fillRect(pad - 8, y - 8, photoWidth + 16, photoHeight + 16);
    octx.restore();

    octx.drawImage(item.canvas, pad, y, photoWidth, photoHeight);

    octx.fillStyle = "#7a7365";
    octx.font = '600 20px "JetBrains Mono", monospace';
    octx.textAlign = "center";
    octx.fillText(String(i + 1).padStart(3, "0"), width / 2, y + photoHeight + captionH);
    y += photoHeight + captionH + gap;
  });

  octx.fillStyle = "#201d16";
  octx.textAlign = "center";
  octx.font = '700 24px "Space Grotesk", sans-serif';
  octx.fillText("PUZZLE · CAM", width / 2, height - pad - 30);

  octx.fillStyle = "#7a7365";
  octx.font = '500 14px "JetBrains Mono", monospace';
  const dateStr = new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
  octx.fillText(dateStr, width / 2, height - pad - 6);

  out.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `puzzlecam-strip-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");
}

/* ---------------------------------------------------------
   Gambar HUD & papan puzzle
--------------------------------------------------------- */
function drawHandSkeleton(hands, color) {
  if (!hands || !hands.length) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  for (const lm of hands) {
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = landmarkToStage(lm[a]);
      const pb = landmarkToStage(lm[b]);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    for (let i = 0; i < lm.length; i++) {
      const p = landmarkToStage(lm[i]);
      const r = [4, 8, 12, 16, 20].includes(i) ? 3.6 : 2.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function roundRectStroke(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.stroke();
}

function drawViewfinderBrackets(rect, color) {
  const L = Math.min(rect.w, rect.h) * 0.12;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  const corners = [
    [rect.x, rect.y, 1, 1],
    [rect.x + rect.w, rect.y, -1, 1],
    [rect.x, rect.y + rect.h, 1, -1],
    [rect.x + rect.w, rect.y + rect.h, -1, -1],
  ];
  corners.forEach(([cx, cy, sx, sy]) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy + L * sy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + L * sx, cy);
    ctx.stroke();
  });
  ctx.restore();
}

function drawDwellRing(c, frac, color) {
  const R = 22;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(c.x, c.y, R, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawTrackingOverlay() {
  const { hands } = gestureFrame;
  drawHandSkeleton(hands, boxGestureActive ? GOLD : "rgba(246,242,232,0.85)");

  if (!boxGestureActive) {
    // tampilkan kotak tipis di tiap tangan yang terdeteksi sebagai umpan balik
    for (const lm of hands) {
      const bb = handBoundingBox(lm);
      ctx.save();
      ctx.strokeStyle = isHandOpen(lm) ? "rgba(231,184,76,0.55)" : "rgba(246,242,232,0.4)";
      ctx.lineWidth = 1.5;
      roundRectStroke(bb.x, bb.y, bb.w, bb.h, 10);
      ctx.restore();
    }
  }

  if (boxGestureActive && liveFrameRect) {
    drawViewfinderBrackets(liveFrameRect, GOLD);
    if (captureHoldStart !== null) {
      const frac = clamp((performance.now() - captureHoldStart) / CAPTURE_DWELL_MS, 0, 1);
      const center = { x: liveFrameRect.x + liveFrameRect.w / 2, y: liveFrameRect.y + liveFrameRect.h / 2 };
      drawDwellRing(center, frac, GOLD);
    }
  }
}

function drawCountdown(now) {
  const rect = lockedFrameRect || getCaptureBoxRect();
  ctx.save();
  ctx.fillStyle = "rgba(7,8,11,0.28)";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
  drawViewfinderBrackets(rect, GOLD);
  drawHandSkeleton(gestureFrame.hands, GOLD);

  const remaining = Math.max(0, COUNTDOWN_TOTAL_MS - (now - countdownStartedAt));
  const n = Math.max(1, Math.ceil(remaining / 1000));
  const secFrac = 1 - ((remaining % 1000) / 1000);
  const scale = 1 + 0.18 * (1 - secFrac);

  ctx.save();
  ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.scale(scale, scale);
  ctx.font = '700 120px "Space Grotesk", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(7,8,11,0.55)";
  ctx.fillText(String(n), 3, 4);
  ctx.fillStyle = GOLD;
  ctx.fillText(String(n), 0, 0);
  ctx.restore();

  if (now - countdownStartedAt >= COUNTDOWN_TOTAL_MS) performCapture();
}

function drawBoard(rect, opts) {
  opts = opts || {};
  const tileW = rect.w / SHATTER_COLS;
  const tileH = rect.h / SHATTER_ROWS;
  const pieceSrcW = processedCanvas.width / SHATTER_COLS;
  const pieceSrcH = processedCanvas.height / SHATTER_ROWS;

  ctx.save();
  ctx.fillStyle = "#0a0b0e";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();

  for (let slot = 0; slot < SHATTER_COLS * SHATTER_ROWS; slot++) {
    if (slot === draggingSlot) continue;
    const pieceIdx = slotOccupant[slot];
    const sx = (pieceIdx % SHATTER_COLS) * pieceSrcW;
    const sy = Math.floor(pieceIdx / SHATTER_COLS) * pieceSrcH;
    const col = slot % SHATTER_COLS;
    const row = Math.floor(slot / SHATTER_COLS);
    const dx = rect.x + col * tileW;
    const dy = rect.y + row * tileH;
    ctx.drawImage(processedCanvas, sx, sy, pieceSrcW, pieceSrcH, dx, dy, tileW, tileH);
    ctx.strokeStyle = "rgba(7,8,11,0.55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(dx + 0.5, dy + 0.5, tileW - 1, tileH - 1);
  }

  ctx.strokeStyle = opts.borderColor || GOLD;
  ctx.lineWidth = 3;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  if (draggingSlot !== null) {
    const pieceIdx = slotOccupant[draggingSlot];
    const sx = (pieceIdx % SHATTER_COLS) * pieceSrcW;
    const sy = Math.floor(pieceIdx / SHATTER_COLS) * pieceSrcH;
    const dw = tileW * 1.1;
    const dh = tileH * 1.1;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 16;
    ctx.drawImage(processedCanvas, sx, sy, pieceSrcW, pieceSrcH, dragPos.x - dw / 2, dragPos.y - dh / 2, dw, dh);
    ctx.restore();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(dragPos.x - dw / 2, dragPos.y - dh / 2, dw, dh);
  }
}

function drawShatter(rect, now) {
  const t = clamp((now - shatterStartedAt) / SHATTER_DURATION_MS, 0, 1);
  const eased = easeOutCubic(t);
  const tileW = rect.w / SHATTER_COLS;
  const tileH = rect.h / SHATTER_ROWS;
  const pieceSrcW = processedCanvas.width / SHATTER_COLS;
  const pieceSrcH = processedCanvas.height / SHATTER_ROWS;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  for (let slot = 0; slot < SHATTER_COLS * SHATTER_ROWS; slot++) {
    const pieceIdx = slotOccupant[slot];
    const sx = (pieceIdx % SHATTER_COLS) * pieceSrcW;
    const sy = Math.floor(pieceIdx / SHATTER_COLS) * pieceSrcH;
    const col = slot % SHATTER_COLS;
    const row = Math.floor(slot / SHATTER_COLS);
    const fx = rect.x + col * tileW;
    const fy = rect.y + row * tileH;
    const startX = cx - tileW / 2;
    const startY = cy - tileH / 2;
    const dx = lerp(startX, fx, eased);
    const dy = lerp(startY, fy, eased);
    const rot = lerp(pieceRotSeed[slot], 0, eased);
    const alpha = lerp(0.15, 1, eased);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(dx + tileW / 2, dy + tileH / 2);
    ctx.rotate(rot);
    ctx.drawImage(processedCanvas, sx, sy, pieceSrcW, pieceSrcH, -tileW / 2, -tileH / 2, tileW, tileH);
    ctx.restore();
  }

  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 3;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  if (t >= 1) appState = "puzzle";
}

function drawSolved(now) {
  const rect = getBoardRect();
  drawBoard(rect, { borderColor: GREEN });

  ctx.save();
  ctx.fillStyle = "rgba(62,207,142,0.16)";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = "rgba(62,207,142,0.55)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(rect.x + (rect.w / 3) * i, rect.y);
    ctx.lineTo(rect.x + (rect.w / 3) * i, rect.y + rect.h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rect.x, rect.y + (rect.h / 3) * i);
    ctx.lineTo(rect.x + rect.w, rect.y + (rect.h / 3) * i);
    ctx.stroke();
  }
  ctx.font = '700 24px "Space Grotesk", sans-serif';
  ctx.fillStyle = "#eafff5";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 10;
  ctx.fillText("PUZZLE SELESAI!", rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.restore();

  drawHandSkeleton(gestureFrame.hands, gestureFrame.fistStable ? GREEN : "rgba(246,242,232,0.85)");

  if (fistHoldStart !== null && gestureFrame.fistHandLm) {
    const wrist = landmarkToStage(gestureFrame.fistHandLm[0]);
    const frac = clamp((now - fistHoldStart) / FIST_DWELL_MS, 0, 1);
    drawDwellRing(wrist, frac, GREEN);
  }
}

function drawSavingAnim(rect, now) {
  const t = clamp((now - savingStartedAt) / SAVE_ANIM_MS, 0, 1);
  const alpha = 1 - t;
  const scale = 1 - 0.25 * t;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  drawBoard(rect, { borderColor: GREEN });
  ctx.restore();

  if (t >= 1) finalizeSave();
}

/* ---------------------------------------------------------
   Teks status / hint / badge
--------------------------------------------------------- */
function setStatus(tone, text) {
  if (statusPill.dataset.tone !== tone) statusPill.dataset.tone = tone;
  if (statusText.textContent !== text) statusText.textContent = text;
}
function setHint(text) {
  if (hintBar.textContent !== text) hintBar.textContent = text;
}

function updateUIStrings(now) {
  captureBtn.hidden = !(appState === "tracking" && capturedCount < STRIP_TARGET);
  saveBtn.hidden = appState !== "solved";

  const showProgress = appState === "puzzle" || appState === "solved";
  progressBadge.hidden = !showProgress;
  if (showProgress) progressText.textContent = `${puzzleProgress} / 9 KEPING TERPASANG`;

  const gestureAvailable = handModelState === "ready";

  switch (appState) {
    case "tracking": {
      if (handModelState === "loading") {
        setStatus("idle", "MEMUAT GESTUR TANGAN…");
        setHint("Kamu tetap bisa pakai tombol Ambil Foto sambil menunggu");
      } else if (handModelState === "unavailable") {
        setStatus("idle", "MODE MANUAL");
        setHint("Deteksi gestur tak tersedia — pakai tombol Ambil Foto");
      } else if (!handPresent) {
        setStatus("search", "MENCARI TANGAN…");
        setHint("Tunjukkan tanganmu ke kamera");
      } else if (boxGestureActive) {
        setStatus("active", "TAHAN BENTUK KOTAKNYA…");
        setHint("Tahan terus posisi kotaknya…");
      } else {
        setStatus("active", "BENTUK KOTAK DENGAN TANGAN");
        setHint("Rentangkan dua tangan terbuka membentuk kotak — bebas arah");
      }
      break;
    }
    case "countdown": {
      const remaining = Math.max(0, COUNTDOWN_TOTAL_MS - (now - countdownStartedAt));
      const n = Math.max(1, Math.ceil(remaining / 1000));
      setStatus("active", `MENANGKAP DALAM ${n}…`);
      setHint("Bersiap…");
      break;
    }
    case "shatter":
      setStatus("active", "MEMPROSES FOTO…");
      setHint("");
      break;
    case "puzzle":
      setStatus("active", "SUSUN PUZZLE DENGAN CUBITAN");
      setHint("Cubit sebuah keping, lalu geser ke kotak lain untuk menukar");
      break;
    case "solved": {
      setStatus("success", "PUZZLE SELESAI! KEPALKAN UNTUK SIMPAN");
      setHint(gestureAvailable ? "Kepalkan tanganmu untuk menyimpan ke strip" : "Tekan tombol Simpan Puzzle untuk melanjutkan");
      break;
    }
    case "saving":
      setStatus("success", "MENYIMPAN…");
      setHint("");
      break;
    case "complete":
      setStatus("success", "STRIP LENGKAP — UNDUH ATAU RESET");
      setHint("Unduh stripmu atau reset untuk mulai sesi baru");
      break;
    default:
      break;
  }
}

/* ---------------------------------------------------------
   Loop render utama
--------------------------------------------------------- */
function renderFrame() {
  const now = performance.now();
  resizeCanvasIfNeeded();
  ctx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);

  let hands = [];
  if (handLandmarker && !document.hidden && videoEl.readyState >= 2 && !videoEl.paused) {
    try {
      const res = handLandmarker.detectForVideo(videoEl, now);
      hands = res.landmarks || [];
    } catch (err) {
      // Jangan biarkan error deteksi menghentikan loop — cukup anggap tak ada tangan frame ini.
      hands = [];
    }
  }

  updateGestureState(hands, now);
  updateUIStrings(now);

  switch (appState) {
    case "tracking":
    case "complete":
      drawTrackingOverlay();
      break;
    case "countdown":
      drawCountdown(now);
      break;
    case "shatter":
      drawShatter(getBoardRect(), now);
      break;
    case "puzzle":
      drawBoard(getBoardRect(), { borderColor: GOLD });
      drawHandSkeleton(gestureFrame.hands, gestureFrame.pinchStable ? GOLD : "rgba(246,242,232,0.7)");
      break;
    case "solved":
      drawSolved(now);
      break;
    case "saving":
      drawSavingAnim(getBoardRect(), now);
      break;
    default:
      break;
  }

  rafHandle = requestAnimationFrame(renderFrame);
}

/* ---------------------------------------------------------
   Kamera & model
--------------------------------------------------------- */
function cameraErrorMessage(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Izin kamera ditolak. Aktifkan akses kamera untuk situs ini di pengaturan browser, lalu coba lagi.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "Kamera tidak ditemukan di perangkat ini.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Kamera sedang dipakai aplikasi lain. Tutup aplikasi tersebut lalu coba lagi.";
  }
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    return "Kamera hanya bisa diakses lewat HTTPS atau localhost. Jalankan file ini lewat server lokal.";
  }
  return "Tidak dapat mengakses kamera. Periksa koneksi kamera lalu coba lagi.";
}

async function setupCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
  const constraints = {
    audio: false,
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  currentStream = stream;
  videoEl.srcObject = stream;
  await new Promise((resolve, reject) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play().then(resolve).catch(reject);
    };
    videoEl.onerror = () => reject(new Error("Video gagal dimuat"));
  });
  resizeCanvasIfNeeded();
  updateCoverTransform();
}

async function setupHandLandmarker() {
  let lastErr = null;
  for (const v of TASKS_VISION_VERSIONS) {
    try {
      const mod = await import(
        /* webpackIgnore: true */ `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${v}`
      );
      const { HandLandmarker, FilesetResolver } = mod;
      const fileset = await FilesetResolver.forVisionTasks(
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${v}/wasm`
      );
      try {
        handLandmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 2,
        });
      } catch (gpuErr) {
        handLandmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          runningMode: "VIDEO",
          numHands: 2,
        });
      }
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Gagal memuat model deteksi tangan");
}

function showLoading(text) {
  loadingOverlay.hidden = false;
  errorBanner.hidden = true;
  loaderText.textContent = text;
}
function hideLoading() { loadingOverlay.hidden = true; }
function showError(text) {
  loadingOverlay.hidden = true;
  errorBanner.hidden = false;
  errorText.textContent = text;
  appState = "error";
  setStatus("error", "GAGAL MEMUAT");
}

async function loadHandModelInBackground() {
  handModelState = "loading";
  let settled = false;

  // Kalau CDN lambat, jangan biarkan pengguna menunggu tanpa kepastian —
  // setelah batas waktu, UI jatuh ke mode manual dulu. Proses unduh tetap
  // lanjut di belakang; kalau akhirnya berhasil, status otomatis naik lagi
  // jadi mode gestur tanpa perlu reload halaman.
  const fallbackTimer = setTimeout(() => {
    if (!settled) handModelState = "unavailable";
  }, MODEL_LOAD_TIMEOUT_MS);

  try {
    await setupHandLandmarker();
    settled = true;
    clearTimeout(fallbackTimer);
    handModelState = "ready";
  } catch (err) {
    settled = true;
    clearTimeout(fallbackTimer);
    handLandmarker = null;
    handModelState = "unavailable";
  }
}

async function init() {
  appState = "loading";
  showLoading("Meminta izin kamera…");
  try {
    await setupCamera();
  } catch (err) {
    showError(cameraErrorMessage(err));
    return;
  }

  // Kamera sudah siap -> langsung tampilkan & bisa dipakai (tombol manual aktif),
  // tidak perlu menunggu model gestur yang bisa lambat diunduh dari CDN.
  hideLoading();
  appState = "tracking";
  updateUIStrings(performance.now());
  if (!rafHandle) rafHandle = requestAnimationFrame(renderFrame);

  // Muat model deteksi tangan di belakang layar; gestur otomatis aktif begitu siap.
  loadHandModelInBackground();
}

/* ---------------------------------------------------------
   Event wiring
--------------------------------------------------------- */
captureBtn.addEventListener("click", () => startCountdown());
saveBtn.addEventListener("click", () => saveCompletedPuzzle());
downloadStripBtn.addEventListener("click", () => downloadStrip());
resetAllBtn.addEventListener("click", () => resetAll());
errorRetry.addEventListener("click", () => init());

window.addEventListener("resize", () => resizeCanvasIfNeeded());
window.addEventListener("orientationchange", () => setTimeout(resizeCanvasIfNeeded, 200));
window.addEventListener("pagehide", () => {
  if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
  if (rafHandle) cancelAnimationFrame(rafHandle);
});

/* ---------------------------------------------------------
   Mulai
--------------------------------------------------------- */
init();