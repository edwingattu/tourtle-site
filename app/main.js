import { CONFIG } from './config.js';
import { getSession, requireSessionOrRedirect, signOut } from './auth.js';
import {
  cellAt,
  cellCenter,
  createEngine,
  progressPercent,
  remainingLabel,
} from './engine.js';
import { createMap } from './map.js';
import { bootstrap, exposeDebug, flush } from './sync.js';
import { setupJoystick } from './joystick.js';
import { regionCenter, regionCredit, regionForPoint, savedRegion, setRegion } from './areas.js';
import * as areasDbg from './areas.js';

const $ = (sel) => document.querySelector(sel);

// Auth gate: unauthenticated visitors go to auth.html (Google + magic link).
// Throws/redirects when signed out, so nothing below runs without a user.
const session = await requireSessionOrRedirect();
const currentUser = session.user;

const engine = createEngine();
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
  $('#tileProgressBar').style.width = `${pct}%`;
  $('#remainingMinutes').textContent = remainingLabel(info.rec);
  $('#hexId').textContent = cell.slice(0, 8);
  placeName(info.center.lat, info.center.lng).then((name) => {
    $('#tileInfoButton').textContent = name;
  });
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
  $('#unlockedCount').textContent = snap.unlockedCount;
  $('#coveragePercent').textContent = `${coverage}%`;
  $('#coverageBar').style.width = `${coverage}%`;
  $('#todayProgress').textContent = `${coverage}%`;
  $('#streakCount').textContent = snap.streakDays;
  const activityCountEl = $('#activityCount');
  if (activityCountEl) activityCountEl.textContent = `${snap.activities.length} activities`;
  $('#tileProgressBar').style.width = `${progressPercent(rec)}%`;
  $('#remainingMinutes').textContent = remainingLabel(rec);
  $('#youTiles').textContent = `${snap.unlockedCount} tiles`;
  $('#outingBadge').hidden = !snap.outing;
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
      $('#signalLabel').textContent = fix.weak ? 'GPS weak — dwell paused' : 'Live GPS';
      applyPosition(fix.lat, fix.lng, { fly: false });
      engine.setBase(fix.lat, fix.lng);
      // Real travel across regions: packs follow the base (sandbox excluded —
      // the joystick manages its own region).
      if (!engine.isSandbox()) autoRegion(fix.lat, fix.lng);
    },
    () => {
      toast('Location permission denied. Simulator still walks real tiles.');
      $('#signalLabel').textContent = 'GPS unavailable';
    },
    { enableHighAccuracy: true, maximumAge: 4000, timeout: 12000 },
  );
}

function stopWatch() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function setTracking(on) {
  tracking = on;
  $('#trackingButton').classList.toggle('live', tracking);
  $('#trackingButton').setAttribute('aria-pressed', String(tracking));
  $('#trackingLabel').textContent = tracking ? 'Fog clearing on' : 'Fog clearing off';
  if (tracking) {
    lastDwellAt = performance.now();
    startWatch();
    toast('Live fog clearing is on. Hexes follow your real coordinates.');
  } else {
    stopWatch();
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

  $('#trackingButton').addEventListener('click', () => setTracking(!tracking));
  $('#recenterButton').addEventListener('click', () => {
    mapView.recenter();
    toast('Centered on your current tile.');
  });
  $('#tileInfoButton').addEventListener('click', (e) => {
    e.stopPropagation();
    const snap = engine.getSnapshot();
    const info = mapView.inspectCell(snap.store, selectedCell);
    toast(`${info.status} · H3 ${info.cell} · ${progressPercent(info.rec)}% dwell`);
  });
  $('#leaderboardButton').addEventListener('click', () => {
    toast('Pilot leaderboard stays private to invited testers.');
  });
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

  document.querySelectorAll('[data-capture]').forEach((button) => {
    button.addEventListener('click', () => {
      const type = button.dataset.capture;
      if (type === 'session') {
        const snap = engine.getSnapshot();
        if (!snap.outing) {
          engine.startOuting();
          const here = mapView.getUserLocation();
          engine.dwell(cellAt(here.lat, here.lng), 0);
          button.querySelector('b').textContent = 'End outing';
          button.querySelector('small').textContent = 'Close session and boost touched tiles';
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

// Region: explicit ?region= wins (persisted), else saved, else GPS detect
// from the base cell. Must precede map ready (packs load per region).
let activeRegion = 'hyd';
{
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('region');
  const base = cellCenter(engine.getSnapshot().store.baseCell);
  activeRegion = explicit || savedRegion() || regionForPoint(base.lat, base.lng);
  setRegion(activeRegion, { persist: !!explicit });
  console.log(`[region] active=${activeRegion} explicit=${explicit} saved=${savedRegion()}`);
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
if (activeRegion === 'nyc') {
  const [lng, lat] = regionCenter();
  mapView.setUserLocation(lng, lat);
  mapView.map.setCenter([lng, lat]);
  mapView.map.setZoom(10);
}
engine.subscribe(() => mapView.paint(engine.getSnapshot().store));
if (activeRegion !== 'nyc') {
  mapView.setUserLocation(CONFIG.defaultCenter[0], CONFIG.defaultCenter[1]);
}
// Cloud bootstrap (silent-local on failure): seed local history, push it up,
// pull canonical state — then repaint from merged totals.
await bootstrap(engine);
exposeDebug(window, engine);
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
selectCell(mapView.cellUnderUser());
bindUi();
setupJoystick({
  mapView,
  engine,
  selectCell,
  toast,
  getRegion: areasDbg.getRegion,
  switchRegion,
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
