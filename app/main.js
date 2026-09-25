import { CONFIG } from './config.js';
import { getSession, requireSessionOrRedirect, signOut } from './auth.js';
import {
  cellAt,
  cellCenter,
  createEngine,
  isUnlocked,
  progressPercent,
  remainingMs,
} from './engine.js';
import { createMap } from './map.js';
import { bootstrap, exposeDebug, flush } from './sync.js';
import { setupJoystick } from './joystick.js';
import { regionCenter, regionCredit, regionForPoint, savedRegion, setRegion } from './areas.js';
import * as areasDbg from './areas.js';
import { isAdmin, isSuperadmin } from './roles.js';
import { compressPhoto, pickAudioMime, pickPhotoMime, pickVideoMime, uploadMedia } from './media.js';

const $ = (sel) => document.querySelector(sel);

// PWA: register shell SW (network-first for HTML, offline fallback). nosw=1 bypasses for dev.
if ('serviceWorker' in navigator && !new URLSearchParams(window.location.search).has('nosw')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// Auth gate: unauthenticated visitors go to auth.html (Google + magic link).
// Throws/redirects when signed out, so nothing below runs without a user.
const session = await requireSessionOrRedirect();
const currentUser = session.user;

// Role gate: sandbox + zoom for admin+, tilt for superadmin only.
const adminUser = await isAdmin();
const superadminUser = await isSuperadmin();
if (!adminUser) {
  $('#joystickButton')?.remove();
  $('#zoomLevel')?.remove();
  $('#tiltLevel')?.remove();
} else if (!superadminUser) {
  $('#tiltLevel')?.remove();
}

const engine = createEngine();
// Debug hook early: available even while auth/map/sync are still loading.
exposeDebug(window, engine);
const mapView = createMap({
  onHexSelect: (cell) => selectCell(cell, { toastOnSelect: true }),
  onMove: () => mapView.paint(engine.getSnapshot().store),
  onLevelSelect: (band, props) => {
    const detail = props.status === 'unclaimed' ? '' : ` · ${props.frac}% explored`;
    toast(`${props.name} · ${props.status}${detail}`);
  },
});

const locationFilter = {
  samples: [],
  lastGood: { lat: CONFIG.defaultCenter[1], lng: CONFIG.defaultCenter[0] },
  frozen: false,
};

let tracking = false;
let watchId = null;
let selectedCell = engine.getSnapshot().store.baseCell;
let captureType = 'photo';
let selectedCategory = 'dining';
let placeCache = new Map();
let lastDwellAt = performance.now();

function toast(message) {
  // Muted per request — keep console for debugging, no navy pill
  console.log('[toast muted]', message);
  return;
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => el.classList.remove('visible'), 2800);
}

function smoothFix(coords) {
  if (typeof coords.speed === 'number' && coords.speed > CONFIG.implausibleSpeedMps) return null;
  if (coords.accuracy > CONFIG.weakAccuracyM) {
    locationFilter.frozen = true;
    return { ...locationFilter.lastGood, weak: true };
  }
  locationFilter.frozen = false;
  locationFilter.samples.push({ lat: coords.latitude, lng: coords.longitude, t: Date.now() });
  if (locationFilter.samples.length > CONFIG.smoothWindow) locationFilter.samples.shift();
  const lat =
    locationFilter.samples.reduce((sum, s) => sum + s.lat, 0) / locationFilter.samples.length;
  const lng =
    locationFilter.samples.reduce((sum, s) => sum + s.lng, 0) / locationFilter.samples.length;
  locationFilter.lastGood = { lat, lng };
  return { lat, lng, weak: false };
}

// Summary card helpers: My City title, area name, live mm:ss countdown.
const LOCK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const UNLOCK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0"/><path d="M16 8V6a4 4 0 0 0-4-4"/></svg>';

function formatCountdown(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateCityTitle() {
  const el = $('#cityTitle');
  if (!el) return;
  // My City — word City replaced by the actual city name the user is in.
  const label = areasDbg.regionLabel();
  el.textContent = `My ${label}`;
}

function updateAreaName(cell = selectedCell) {
  const el = $('#areaName');
  const hexEl = $('#hexLine');
  if (!el) return;
  let lat, lng, id;
  if (cell) {
    const c = cellCenter(cell);
    lat = c.lat; lng = c.lng; id = cell;
  } else if (mapView) {
    const p = mapView.getUserLocation();
    lat = p.lat; lng = p.lng; id = cellAt(lat, lng);
  } else {
    lat = CONFIG.defaultCenter[1]; lng = CONFIG.defaultCenter[0]; id = cellAt(lat, lng);
  }
  const area = areasDbg.areaAt(lng, lat) || areasDbg.districtAt(lng, lat);
  el.textContent = area ? area.name : 'Outside mapped areas';
  if (hexEl) hexEl.textContent = `H3 · ${id}`;
}

function updateCountdown(rec) {
  const row = $('#countdownRow');
  const textEl = $('#countdownText');
  const iconEl = $('#lockIcon');
  const track = $('#tileProgressTrack');
  const bar = $('#tileProgressBar');
  if (!textEl || !iconEl || !bar) return;
  const unlocked = isUnlocked(rec);
  const pct = progressPercent(rec);
  bar.style.width = `${pct}%`;
  if (track) track.classList.toggle('unlocked', unlocked);
  if (row) row.classList.toggle('unlocked', unlocked);
  if (unlocked) {
    textEl.textContent = 'Unlocked';
    iconEl.innerHTML = UNLOCK_SVG;
  } else {
    const left = remainingMs(rec);
    const mmss = formatCountdown(left);
    textEl.innerHTML = `Current Tile Unlocks in <b id="countdown">${mmss} mins</b>`;
    iconEl.innerHTML = LOCK_SVG;
  }
}

// Per-tile media gallery: module scope so renderHud/selectCell can refresh it
// on every tile change (bindUi-local defs are invisible here).
function openViewer(url, isVideo) {
  const dlg = $('#mediaViewer');
  if (!dlg) return;
  const img = $('#viewerImg'), vid = $('#viewerVideo');
  img.hidden = true; vid.hidden = true;
  try { vid.pause?.(); } catch {}
  if (isVideo) { vid.src = url; vid.hidden = false; }
  else { img.src = url; img.hidden = false; }
  try { dlg.showModal(); } catch {}
}

function renderTileGallery() {
  const gal = $('#tileGallery');
  if (!gal) return;
  const acts = engine.getSnapshot().store.activities.filter((a) => a.cell === selectedCell && (a.media_url || a.localUrl));
  gal.innerHTML = '';
  gal.hidden = acts.length === 0;
  for (const a of acts) {
    const url = a.media_url || a.localUrl;
    if (!url) continue;
    const isVideo = (a.captureType === 'video') || /\.(mp4|webm|mov)$/i.test(url.split('?')[0]);
    let el;
    if (isVideo) { el = document.createElement('video'); el.src = url; el.preload = 'metadata'; el.muted = true; el.playsInline = true; }
    else {
      el = document.createElement('img'); el.alt = a.title || 'memory';
      el.addEventListener('error', () => { el.style.opacity = '0.25'; });
      el.src = url;
    }
    el.className = 'g-thumb';
    el.addEventListener('click', () => openViewer(url, isVideo));
    gal.appendChild(el);
  }
}

async function placeName(lat, lng) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (placeCache.has(key)) return placeCache.get(key);
  try {
    const url = `${CONFIG.nominatimUrl}?lat=${lat}&lon=${lng}&format=jsonv2`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('geocode failed');
    const data = await res.json();
    const addr = data.address || {};
    const name =
      addr.suburb ||
      addr.neighbourhood ||
      addr.quarter ||
      addr.city_district ||
      addr.town ||
      addr.city ||
      data.name ||
      'Unnamed area';
    const city = addr.city || addr.town || addr.state || '';
    const label = city ? `${name}, ${city}` : name;
    placeCache.set(key, label);
    return label;
  } catch {
    return 'Current tile';
  }
}

function selectCell(cell, { toastOnSelect = false } = {}) {
  selectedCell = cell;
  mapView.setSelected(cell);
  const snap = engine.getSnapshot();
  mapView.paint(snap.store);
  const info = mapView.inspectCell(snap.store, cell);
  const pct = progressPercent(info.rec);
  updateAreaName(cell);
  updateCityTitle();
  updateCountdown(info.rec);
  // Animate bar 0 → current on every tap (progress already reflects tile)
  const bar = document.getElementById('tileProgressBar');
  if (bar) {
    bar.style.transition = 'none';
    bar.style.width = '0%';
    void bar.offsetWidth;
    bar.style.transition = 'width 0.5s ease';
    bar.style.width = `${pct}%`;
  }
  if (toastOnSelect) {
    if (info.status === 'unlocked') toast('This tile is already part of your story.');
    else if (info.status === 'activated')
      toast(`Activated tile ${cell.slice(0, 8)} — dwell progress is ${pct}%.`);
    else toast('Unclaimed tile. Move through it to activate.');
  }
  renderHud();
}

function renderHud() {
  const snap = engine.getSnapshot();
  const rec = snap.store.tiles[selectedCell];
  const coverage = snap.coverage;
  const unlockedEl = $('#unlockedCount');
  if (unlockedEl) unlockedEl.textContent = snap.unlockedCount;
  const covEl = $('#coveragePercent');
  if (covEl) covEl.textContent = `${coverage}%`;
  const covBar = $('#coverageBar');
  if (covBar) covBar.style.width = `${coverage}%`;
  const todayEl = $('#todayProgress');
  if (todayEl) todayEl.textContent = `${coverage}%`;
  const streakEl = $('#streakCount');
  if (streakEl) streakEl.textContent = snap.streakDays;
  const activityCountEl = $('#activityCount');
  if (activityCountEl) activityCountEl.textContent = `${snap.activities.length} activities`;
  const youTilesEl = $('#youTiles');
  if (youTilesEl) youTilesEl.textContent = `${snap.unlockedCount} tiles`;
  const outingBadge = $('#outingBadge');
  if (outingBadge) outingBadge.hidden = !snap.outing;
  // Summary card live fields — Areas: 2 boxes (activated blue + unlocked green), Tiles: unlocked only
  const tilesChip = $('#tilesUnlockedCount');
  if (tilesChip) tilesChip.textContent = String(snap.unlockedCount);
  const areasActEl = $('#areasActivatedCount');
  const areasUnlEl = $('#areasUnlockedCount');
  if (areasActEl || areasUnlEl) {
    try {
      // Ensure hex raster is built before stats — otherwise all totals are 0
      // and activated stays 0 even with live dwell (paint is rAF-deferred).
      if (areasDbg.levelReady('area')) areasDbg.buildAreaHexes();
      const { areaStats } = areasDbg.getRollup(snap.store);
      let activatedAreas = 0;
      let unlockedAreas = 0;
      for (const s of areaStats.values()) {
        if (s.status === 'activated') activatedAreas += 1;
        else if (s.status === 'unlocked' || s.status === 'mastered') unlockedAreas += 1;
      }
      if (areasActEl) areasActEl.textContent = String(activatedAreas);
      if (areasUnlEl) areasUnlEl.textContent = String(unlockedAreas);
    } catch {
      if (areasActEl) areasActEl.textContent = '0';
      if (areasUnlEl) areasUnlEl.textContent = '0';
    }
  }
  updateCityTitle();
  updateAreaName(selectedCell);
  updateCountdown(rec);
  try { renderTileGallery(); } catch {}
  mapView.paint(snap.store);
}

function applyPosition(lat, lng, { fly = false, dwellMs = 0 } = {}) {
  mapView.setUserLocation(lng, lat, { fly });
  const cell = cellAt(lat, lng);
  if (dwellMs > 0 && !locationFilter.frozen) engine.dwell(cell, dwellMs);
  if (cell !== selectedCell) selectCell(cell);
  else renderHud();
}

function startWatch() {
  if (!navigator.geolocation) {
    toast('This browser has no GPS. Use + to walk a real Hyderabad path.');
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const fix = smoothFix(pos.coords);
      if (!fix) return;
      applyPosition(fix.lat, fix.lng, { fly: false });
      engine.setBase(fix.lat, fix.lng);
      // Real travel across regions: packs follow the base (sandbox excluded —
      // the joystick manages its own region).
      if (!engine.isSandbox()) autoRegion(fix.lat, fix.lng);
    },
    () => {
      toast('Location permission denied. Simulator still walks real tiles.');
    },
    { enableHighAccuracy: true, maximumAge: 4000, timeout: 12000 },
  );
}

function stopWatch() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && tracking) wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tracking) requestWakeLock();
});

function setTracking(on) {
  tracking = on;
  $('#trackingButton').classList.toggle('live', tracking);
  $('#trackingButton').setAttribute('aria-pressed', String(tracking));
  const tl = $('#trackingLabel');
  if (tl) tl.textContent = tracking ? 'Fog clearing on' : 'Fog clearing off';
  if (tracking) {
    lastDwellAt = performance.now();
    startWatch();
    requestWakeLock();
    toast('Live fog clearing is on. Hexes follow your real coordinates.');
  } else {
    stopWatch();
    releaseWakeLock();
    toast('Fog clearing paused.');
  }
}

function openDialog(type) {
  captureType = type;
  const copy = {
    photo: ['Capture a moment', 'Photo is tagged to the H3 tile under you and grants a flat unlock boost.'],
    voice: ['Leave a voice note', 'Voice note is tagged to this real tile. Same flat boost as a photo.'],
    session: ['Save this outing', 'Every hex you touched while the outing was open gets the Activity boost.'],
  }[type];
  $('#dialogTitle').textContent = copy[0];
  $('#dialogCopy').textContent = copy[1];
  $('#activityDialog').showModal();
}

function bindUi() {
  const bottomCard = $('#bottomCard');
  const summaryToggle = $('#summaryToggle');
  const setExpanded = (on) => {
    bottomCard?.classList.toggle('expanded', on);
    summaryToggle?.setAttribute('aria-expanded', String(on));
    summaryToggle?.setAttribute('aria-label', on ? 'Collapse details' : 'Expand details');
  };
  summaryToggle?.addEventListener('click', () => {
    setExpanded(!bottomCard?.classList.contains('expanded'));
  });
  summaryToggle?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setExpanded(!bottomCard?.classList.contains('expanded'));
    }
  });

  // PWA install prompt (deferred) — show banner when ready
  let deferredPrompt = null;
  const pwaBanner = $('#pwaBanner');
  const pwaInstallBtn = $('#pwaInstallBtn');
  const pwaDismissBtn = $('#pwaDismissBtn');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone && pwaBanner && !localStorage.getItem('tourtle.pwa.dismissed')) {
      pwaBanner.hidden = false;
    }
    console.log('[pwa] install prompt ready');
  });
  pwaInstallBtn?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch {}
    deferredPrompt = null;
    if (pwaBanner) pwaBanner.hidden = true;
  });
  pwaDismissBtn?.addEventListener('click', () => {
    if (pwaBanner) pwaBanner.hidden = true;
    try { localStorage.setItem('tourtle.pwa.dismissed', '1'); } catch {}
  });
  // iOS has no beforeinstallprompt — banner never shows; user uses Share → Add to Home Screen

  $('#trackingButton').addEventListener('click', () => setTracking(!tracking));
  $('#recenterButton').addEventListener('click', () => {
    mapView.recenter();
    toast('Centered on your current tile.');
  });
  // My City area name is informational — keep toast on tap for debug, guard missing el.
  const tileInfoBtn = $('#tileInfoButton') || $('#areaName');
  tileInfoBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const snap = engine.getSnapshot();
    const info = mapView.inspectCell(snap.store, selectedCell);
    toast(`${info.status} · H3 ${info.cell} · ${progressPercent(info.rec)}% dwell`);
  });
  $('#leaderboardButton')?.addEventListener('click', () => {
    toast('Pilot leaderboard stays private to invited testers.');
  });
  // Unlocking section collapse
  const unlockingContent = $('#unlockingContent');
  const collapsedBar = $('#collapsedBar');
  const understoodBtn = $('#understoodBtn');
  const UNDERSTOOD_KEY = 'tourtle.v0.unlockingDismissed';
  const setUnlockingCollapsed = (collapsed) => {
    if (!unlockingContent || !collapsedBar) return;
    unlockingContent.hidden = collapsed;
    collapsedBar.hidden = !collapsed;
    try { localStorage.setItem(UNDERSTOOD_KEY, collapsed ? '1' : ''); } catch {}
  };
  try {
    if (localStorage.getItem(UNDERSTOOD_KEY) === '1') setUnlockingCollapsed(true);
  } catch {}
  understoodBtn?.addEventListener('click', () => setUnlockingCollapsed(true));
  collapsedBar?.addEventListener('click', () => setUnlockingCollapsed(false));
  $('#profileButton').addEventListener('click', async () => {
    const email = currentUser?.email || 'Signed in';
    if (window.confirm(`${email}\n\nPersonal territory is never shared by default.\n\nOK = stay signed in\nCancel = sign out`)) {
      toast('Personal territory is never shared by default.');
      return;
    }
    try {
      await signOut();
    } finally {
      window.location.replace('./auth.html');
    }
  });

  // Personalize avatar + leaderboard label from auth user.
  const initial = (currentUser?.email || 'A').trim().charAt(0).toUpperCase() || 'A';
  const profileBtn = $('#profileButton');
  if (profileBtn) profileBtn.textContent = initial;

  // Inline Voice capture (card itself) + fullscreen Camera + tile gallery
  const voiceArea = $('#voiceCapture');
  let camStream = null, camMode = 'photo', camFacing = 'environment', camRecorder = null, camChunks = [], camPhotoBlob = null, camVideoBlob = null;
  let voiceStream = null, voiceRecorder = null, voiceChunks = [], voiceBlob = null, voiceTimer = null, voiceSec = 0;

  $('#viewerClose')?.addEventListener('click', () => { try { $('#mediaViewer').close(); } catch {} const v = $('#viewerVideo'); v.pause?.(); v.removeAttribute('src'); v.load?.(); });

  function stopCamStream() { try { camRecorder?.state === 'recording' && camRecorder.stop(); } catch {} try { camStream?.getTracks().forEach((t) => t.stop()); } catch {} camStream = null; const v = $('#camPreview'); if (v) v.srcObject = null; }
  async function openCamera(mode = 'photo') {
    camMode = mode; camPhotoBlob = camVideoBlob = null;
    closeVoiceArea();
    const dlg = $('#cameraSheet');
    document.querySelectorAll('.cam-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
    const review = $('#camReview'); review.hidden = true;
    const preview = $('#camPreview'); preview.hidden = false;
    $('#camSave').hidden = true; $('#camRetake').hidden = true;
    $('#camShutter').classList.remove('recording');
    try { dlg.showModal(); } catch {}
    await startCam();
  }
  async function startCam() {
    const preview = $('#camPreview');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('no cam');
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: camFacing }, audio: camMode === 'video' });
      preview.srcObject = camStream;
    } catch {
      $('#camFile').click();
      closeCamera();
    }
  }
  function closeCamera() { stopCamStream(); try { $('#cameraSheet').close(); } catch {} }
  async function saveCamBlob() {
    const blob = camPhotoBlob || camVideoBlob; if (!blob) return;
    const { lat, lng } = mapView.getUserLocation();
    const cell = cellAt(lat, lng);
    const isVideo = blob.type.startsWith('video/');
    const activity = engine.logActivity({ title: isVideo ? 'Video memory' : 'Photo memory', category: selectedCategory, captureType: isVideo ? 'video' : 'photo', lat, lng, cell });
    const localUrl = URL.createObjectURL(blob);
    activity.localUrl = localUrl;
    try {
      const uid = (await import('./auth.js').then((m) => m.supabase.auth.getUser())).data.user?.id;
      const ext = blob.type.includes('webp') ? 'webp' : blob.type.includes('mp4') ? 'mp4' : isVideo ? 'webm' : 'jpg';
      const url = await uploadMedia(`${uid}/${activity.id}.${ext}`, blob, blob.type);
      activity.media_url = url;
      try { localStorage.setItem('tourtle.v0.hex-progress', JSON.stringify(engine.getSnapshot().store)); } catch {}
    } catch (e) { console.warn('[media] upload failed', e?.message || e); }
    closeCamera(); renderTileGallery(); renderHud();
  }
  document.querySelectorAll('.cam-tab').forEach((t) => t.addEventListener('click', async () => {
    camMode = t.dataset.tab;
    document.querySelectorAll('.cam-tab').forEach((x) => x.classList.toggle('active', x === t));
    camPhotoBlob = camVideoBlob = null;
    $('#camReview').hidden = true; $('#camPreview').hidden = false;
    $('#camSave').hidden = true; $('#camRetake').hidden = true;
    stopCamStream(); await startCam();
  }));
  $('#camClose')?.addEventListener('click', closeCamera);
  $('#camFlip')?.addEventListener('click', async () => { camFacing = camFacing === 'environment' ? 'user' : 'environment'; stopCamStream(); await startCam(); });
  $('#camRetake')?.addEventListener('click', () => { camPhotoBlob = camVideoBlob = null; $('#camReview').hidden = true; $('#camPreview').hidden = false; $('#camSave').hidden = true; $('#camRetake').hidden = true; $('#camShutter').classList.remove('recording'); });
  $('#camSave')?.addEventListener('click', saveCamBlob);
  $('#camFile')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.type.startsWith('video/')) camVideoBlob = f; else camPhotoBlob = await compressPhoto(f);
    const rev = $('#camReview'); rev.src = URL.createObjectURL(camPhotoBlob || camVideoBlob); rev.hidden = false;
    $('#camPreview').hidden = true; $('#camSave').hidden = false; $('#camRetake').hidden = false;
  });
  $('#camShutter')?.addEventListener('click', async () => {
    const preview = $('#camPreview');
    if (camMode === 'photo') {
      const canvas = document.createElement('canvas');
      canvas.width = preview.videoWidth; canvas.height = preview.videoHeight;
      canvas.getContext('2d').drawImage(preview, 0, 0);
      camPhotoBlob = await new Promise((r) => canvas.toBlob(r, pickPhotoMime(), 0.78));
      camVideoBlob = null;
      const rev = $('#camReview'); rev.src = URL.createObjectURL(camPhotoBlob); rev.hidden = false;
      preview.hidden = true; $('#camSave').hidden = false; $('#camRetake').hidden = false;
    } else {
      if (camRecorder && camRecorder.state === 'recording') { camRecorder.stop(); return; }
      camChunks = [];
      const mime = pickVideoMime();
      camRecorder = new MediaRecorder(camStream, mime ? { mimeType: mime } : undefined);
      camRecorder.ondataavailable = (ev) => { if (ev.data.size) camChunks.push(ev.data); };
      camRecorder.onstop = () => {
        camVideoBlob = new Blob(camChunks, { type: camRecorder.mimeType || 'video/webm' });
        const rev = $('#camReview'); rev.src = URL.createObjectURL(camVideoBlob); rev.hidden = false;
        preview.hidden = true; $('#camSave').hidden = false; $('#camRetake').hidden = false;
        $('#camShutter').classList.remove('recording');
      };
      camRecorder.start();
      $('#camShutter').classList.add('recording');
      setTimeout(() => { if (camRecorder?.state === 'recording') camRecorder.stop(); }, 30000);
    }
  });

  function showVoiceArea() {
    if (voiceArea) voiceArea.hidden = false;
  }
  function closeVoiceArea() {
    try { voiceRecorder?.state !== 'inactive' && voiceRecorder.stop(); } catch {}
    try { voiceStream?.getTracks().forEach((t) => t.stop()); } catch {}
    voiceStream = null; voiceBlob = null;
    clearInterval(voiceTimer); voiceSec = 0;
    const t = $('#voiceTimer'); if (t) t.textContent = '0:00';
    const a = $('#voiceAudio'); if (a) { a.hidden = true; a.src = ''; }
    $('#voiceSave').hidden = true; $('#voicePlay').hidden = true; $('#voiceStop').hidden = true;
    if (voiceArea) voiceArea.hidden = true;
  }

  document.querySelectorAll('[data-capture]').forEach((button) => {
    button.addEventListener('click', () => {
      const type = button.dataset.capture;
      if (type === 'photo') { openCamera('photo'); return; }
      if (type === 'voice') { showVoiceArea(); return; }
      if (type === 'session') {
        const snap = engine.getSnapshot();
        if (!snap.outing) {
          engine.startOuting();
          const here = mapView.getUserLocation();
          engine.dwell(cellAt(here.lat, here.lng), 0);
          button.querySelector('b').textContent = 'End outing';
          const sm = button.querySelector('small'); if (sm) sm.textContent = 'Close session and boost touched tiles';
          toast('Outing started. Tiles you enter now will all receive the Activity boost.');
          renderHud();
          return;
        }
        openDialog('session');
        return;
      }
      openDialog(type);
    });
  });

  $('#voiceClose')?.addEventListener('click', closeVoiceArea);

  // Voice recorder
  $('#voiceRec')?.addEventListener('click', async () => {
    try {
      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceChunks = [];
      const mime = pickAudioMime();
      voiceRecorder = new MediaRecorder(voiceStream, mime ? { mimeType: mime } : undefined);
      voiceRecorder.ondataavailable = (e) => { if (e.data.size) voiceChunks.push(e.data); };
      voiceRecorder.onstop = () => {
        voiceBlob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || 'audio/webm' });
        const a = $('#voiceAudio'); a.src = URL.createObjectURL(voiceBlob); a.hidden = false;
        $('#voiceSave').hidden = false; $('#voicePlay').hidden = false;
        clearInterval(voiceTimer); 
      };
      voiceRecorder.start();
      $('#voiceRec').hidden = true; $('#voiceStop').hidden = false;
      voiceSec = 0; const timer = $('#voiceTimer');
      voiceTimer = setInterval(() => { voiceSec++; if (timer) timer.textContent = `${Math.floor(voiceSec/60)}:${String(voiceSec%60).padStart(2,'0')}`; if (voiceSec >= 120) voiceRecorder.stop(); }, 1000);
    } catch (e) { console.warn('[voice] mic denied', e?.message || e); }
  });
  $('#voiceStop')?.addEventListener('click', () => { try { voiceRecorder.stop(); } catch {} $('#voiceStop').hidden = true; $('#voiceRec').hidden = false; voiceStream?.getTracks().forEach((t) => t.stop()); clearInterval(voiceTimer); });
  $('#voicePlay')?.addEventListener('click', () => { const a = $('#voiceAudio'); if (a) a.play(); });
  $('#voiceSave')?.addEventListener('click', async () => {
    if (!voiceBlob) return;
    const { lat, lng } = mapView.getUserLocation();
    const cell = cellAt(lat, lng);
    const activity = engine.logActivity({ title: 'Voice memory', category: selectedCategory, captureType: 'voice', lat, lng, cell });
    try {
      const uid = (await import('./auth.js').then((m) => m.supabase.auth.getUser())).data.user?.id;
      const ext = voiceBlob.type.includes('mp4') ? 'm4a' : 'webm';
      const path = `${uid}/${activity.id}.${ext}`;
      const url = await uploadMedia(path, voiceBlob, voiceBlob.type);
      const idx = engine.getSnapshot().store.activities.findIndex((a) => a.id === activity.id);
      if (idx !== -1) engine.getSnapshot().store.activities[idx].media_url = url;
      try { localStorage.setItem('tourtle.v0.hex-progress', JSON.stringify(engine.getSnapshot().store)); } catch {}
    } catch (e) { console.warn('[media] voice upload failed', e?.message || e); }
    closeVoiceArea(); renderHud();
  });

  document.querySelectorAll('[data-category]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-category]').forEach((item) => item.classList.remove('selected'));
      button.classList.add('selected');
      selectedCategory = button.dataset.category;
    });
  });

  $('#activityForm').addEventListener('submit', (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    const title = $('#activityTitle').value.trim() || 'Untitled outing';
    const { lat, lng } = mapView.getUserLocation();
    const cell = cellAt(lat, lng);
    if (captureType === 'session') {
      engine.endOuting();
      const outingBtn = document.querySelector('[data-capture="session"]');
      outingBtn.querySelector('b').textContent = 'Start outing';
      outingBtn.querySelector('small').textContent = 'Track multiple tiles live';
    }
    engine.logActivity({
      title,
      category: selectedCategory,
      captureType,
      lat,
      lng,
      cell,
    });
    $('#activityDialog').close();
    $('#activityTitle').value = '';
    renderHud();
    toast('Activity saved — every touched tile received a boost.');
  });
}

function tick() {
  engine.expireOutingIfNeeded();
  if (tracking && !locationFilter.frozen) {
    const now = performance.now();
    const dt = now - lastDwellAt;
    lastDwellAt = now;
    const { lat, lng } = mapView.getUserLocation();
    engine.dwell(cellAt(lat, lng), dt);
    renderHud();
  } else {
    lastDwellAt = performance.now();
  }
}

// Location gate: no implicit Hyderabad. Force prompt unless explicit ?region=
// or a prior explicit choice exists. Persists as tourtle.v0.locationChoice.
const LOCATION_CHOICE_KEY = 'tourtle.v0.locationChoice';
function getLocationChoice() {
  try { return localStorage.getItem(LOCATION_CHOICE_KEY); } catch { return null; }
}
function setLocationChoice(v) {
  try { localStorage.setItem(LOCATION_CHOICE_KEY, v); } catch {}
}
function needsGate() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('region')) return false;
  if (getLocationChoice()) return false;
  // Legacy: users who got the Hyderabad default with no explicit choice
  const base = engine.getSnapshot().store.baseCell;
  const dCell = cellAt(CONFIG.defaultCenter[1], CONFIG.defaultCenter[0]);
  if (base === dCell && !savedRegion()) return true;
  // No choice at all → gate
  if (!getLocationChoice() && !savedRegion()) return true;
  // If savedRegion exists but no locationChoice (old user), still gate per spec
  if (savedRegion() && !getLocationChoice()) return true;
  return false;
}
function guessCountry() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (tz.includes('Kolkata') || tz.includes('Asia/')) return 'IN';
    if (tz.includes('New_York') || tz.includes('America/')) return 'US';
  } catch {}
  return null;
}
function renderCityCards(filter) {
  const wrap = $('#gateCards');
  if (!wrap) return;
  wrap.innerHTML = '';
  const regions = filter === 'IN' ? ['hyd'] : filter === 'US' ? ['nyc'] : ['hyd', 'nyc'];
  for (const r of regions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'city-card';
    btn.dataset.region = r;
    const label = areasDbg.regionLabel(r);
    const count = r === 'nyc' ? '262 NTAs' : '145 wards';
    btn.innerHTML = `<span><b>${label}</b><small>${count} · ${r === 'nyc' ? 'USA' : 'India'}</small></span><span>→</span>`;
    btn.addEventListener('click', async () => {
      setLocationChoice(`city:${r}`);
      setRegion(r, { persist: true });
      activeRegion = r;
      hideGate();
      await postGateSetup(r);
    });
    wrap.appendChild(btn);
  }
}
function showGateState(which) {
  $('#gatePrompt').hidden = which !== 'prompt';
  $('#gatePicker').hidden = which !== 'picker';
  $('#gateLoading').hidden = which !== 'loading';
}
function hideGate() {
  const dlg = $('#locationGate');
  try { dlg.close(); } catch {}
  dlg.hidden = true;
}
async function showLocationGate() {
  const dlg = $('#locationGate');
  if (!dlg) return;
  dlg.hidden = false;
  showGateState('prompt');
  try { dlg.showModal(); } catch { dlg.setAttribute('open',''); }
  // Bind once
  if (!dlg.dataset.bound) {
    dlg.dataset.bound = '1';
    $('#gateShareBtn')?.addEventListener('click', async () => {
      showGateState('loading');
      if (!navigator.geolocation) {
        renderCityCards(guessCountry());
        showGateState('picker');
        return;
      }
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = pos.coords.latitude, lng = pos.coords.longitude;
          const region = regionForPoint(lat, lng);
          setLocationChoice('granted');
          setRegion(region, { persist: true });
          activeRegion = region;
          engine.setBase(lat, lng);
          locationFilter.lastGood = { lat, lng };
          hideGate();
          await postGateSetup(region, { lat, lng, fly: true });
          setTracking(true);
        },
        () => {
          renderCityCards(guessCountry());
          showGateState('picker');
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
      );
    });
    $('#gatePickBtn')?.addEventListener('click', () => {
      renderCityCards(guessCountry());
      showGateState('picker');
    });
    $('#gateBackBtn')?.addEventListener('click', () => showGateState('prompt'));
  }
}
let activeRegion = 'hyd';
let gatePending = null;
{
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('region');
  if (explicit) {
    activeRegion = explicit;
    setRegion(activeRegion, { persist: true });
    setLocationChoice(`city:${explicit}`);
  } else if (getLocationChoice()?.startsWith('city:')) {
    activeRegion = getLocationChoice().split(':')[1];
    setRegion(activeRegion, { persist: false });
  } else if (getLocationChoice() === 'granted' && savedRegion()) {
    activeRegion = savedRegion();
    setRegion(activeRegion, { persist: false });
  } else if (savedRegion() && !needsGate()) {
    activeRegion = savedRegion();
    setRegion(activeRegion, { persist: false });
  } else if (!needsGate()) {
    const base = cellCenter(engine.getSnapshot().store.baseCell);
    activeRegion = regionForPoint(base.lat, base.lng);
    setRegion(activeRegion, { persist: false });
  } else {
    // Gate will decide; keep hyd as placeholder for map init (not shown as user loc)
    setRegion('hyd', { persist: false });
    gatePending = showLocationGate();
  }
  console.log(`[region] active=${activeRegion} gatePending=${!!gatePending} saved=${savedRegion()} choice=${getLocationChoice()}`);
}
async function postGateSetup(region, opts = {}) {
  await areasDbg.loadCore();
  if (opts.lat != null) {
    mapView.setUserLocation(opts.lng, opts.lat, { fly: !!opts.fly });
    if (opts.fly) mapView.map.setCenter([opts.lng, opts.lat]);
  } else {
    const [lng, lat] = regionCenter();
    mapView.setUserLocation(lng, lat);
    mapView.map.setCenter([lng, lat]);
    mapView.map.setZoom(region === 'nyc' ? 10 : 12);
    engine.setBase(lat, lng);
  }
  mapView.paint(engine.getSnapshot().store);
  selectCell(mapView.cellUnderUser());
  const credit = $('#dataCredit');
  if (credit) credit.textContent = areasDbg.regionCredit();
}
/** Swap the active region's packs and repaint. Districts lazy-load on zoom. */
let regionSwitching = false;
async function switchRegion(next) {
  if (regionSwitching || areasDbg.getRegion() === next) return;
  regionSwitching = true;
  try {
    areasDbg.setRegion(next);
    await areasDbg.loadCore();
    activeRegion = next;
    updateCityTitle();
    mapView.paint(engine.getSnapshot().store);
    selectCell(mapView.cellUnderUser());
    const credit = $('#dataCredit');
    if (credit) credit.textContent = areasDbg.regionCredit();
    console.log(`[region] switched to ${next}`);
  } finally {
    regionSwitching = false;
  }
}

/** GPS-driven region follow (real travel). Sandbox manages its own region. */
function autoRegion(lat, lng) {
  const next = regionForPoint(lat, lng);
  if (next !== areasDbg.getRegion()) {
    switchRegion(next);
    toast(next === 'nyc' ? 'Welcome to New York — loading local tiles.' : 'Welcome home — loading Hyderabad tiles.');
  }
}

await mapView.ready();
if (gatePending) {
  // Gate is blocking — don't seed a Hyderabad default. Picker/share will
  // call postGateSetup which sets the real center and selects the cell.
  engine.subscribe(() => mapView.paint(engine.getSnapshot().store));
} else {
  if (activeRegion === 'nyc') {
    const [lng, lat] = regionCenter();
    mapView.setUserLocation(lng, lat);
    mapView.map.setCenter([lng, lat]);
    mapView.map.setZoom(10);
  } else {
    // No gate: restore last granted base or saved region center
    const base = cellCenter(engine.getSnapshot().store.baseCell);
    const hasRealBase = getLocationChoice() === 'granted' || getLocationChoice()?.startsWith('city:');
    if (hasRealBase) {
      mapView.setUserLocation(base.lng, base.lat);
      mapView.map.setCenter([base.lng, base.lat]);
    } else {
      mapView.setUserLocation(CONFIG.defaultCenter[0], CONFIG.defaultCenter[1]);
    }
  }
  engine.subscribe(() => mapView.paint(engine.getSnapshot().store));
}
// Cloud bootstrap (silent-local on failure): seed local history, push it up,
// pull canonical state — then repaint from merged totals.
await bootstrap(engine);
{
  // Diagnostic snapshot: pack loadout + lookup sanity at map center.
  const c = mapView.map.getCenter();
  const nAreas = areasDbg.getPack('areas')?.length || 0;
  const nDistricts = areasDbg.getPack('districts')?.length || 0;
  const area = areasDbg.areaAt(c.lng, c.lat);
  const dist = areasDbg.districtAt(c.lng, c.lat);
  console.log(
    `[region] packs areas=${nAreas} districts=${nDistricts} ` +
      `zoom=${mapView.map.getZoom().toFixed(2)} center=${c.lng.toFixed(3)},${c.lat.toFixed(3)} ` +
      `area=${area?.id || 'none'} district=${dist?.id || 'none'}`,
  );
}
if (!gatePending) selectCell(mapView.cellUnderUser());
bindUi();
// If gated, re-run select after picker/share picks a city — postGateSetup handles it.
// Add a helper on window to re-trigger gate (for manual city switch later)
window.__tourtleGate = { show: showLocationGate, choice: getLocationChoice };
setupJoystick({
  mapView,
  engine,
  selectCell,
  toast,
  getRegion: areasDbg.getRegion,
  switchRegion,
  enabled: adminUser,
});
{
  const credit = $('#dataCredit');
  if (credit) credit.textContent = regionCredit();
}
renderHud();
mapView.paint(engine.getSnapshot().store);
setInterval(tick, 1000);
// Push the delta outbox on a cadence + whenever the app hides. Pulls stay
// launch-only per V0 scope.
setInterval(() => {
  flush(engine);
}, CONFIG.syncIntervalMs);
window.addEventListener('pagehide', () => {
  flush(engine);
});
toast('Hex fog is H3 resolution 9 — each tile is a real ~174m cell.');
