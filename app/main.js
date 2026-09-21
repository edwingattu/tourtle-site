import { CONFIG, DEMO_WALK } from './config.js';
import { getSession, requireSessionOrRedirect, signOut } from './auth.js';
import {
  bearingBetween,
  cellAt,
  createEngine,
  destinationPoint,
  progressPercent,
  remainingLabel,
} from './engine.js';
import { createMap } from './map.js';

const $ = (sel) => document.querySelector(sel);

// Auth gate: unauthenticated visitors go to auth.html (Google + magic link).
// Throws/redirects when signed out, so nothing below runs without a user.
const session = await requireSessionOrRedirect();
const currentUser = session.user;

const engine = createEngine();
const mapView = createMap({
  onHexSelect: (cell) => selectCell(cell, { toastOnSelect: true }),
  onMove: () => mapView.paint(engine.getSnapshot().store),
});

const locationFilter = {
  samples: [],
  lastGood: { lat: CONFIG.defaultCenter[1], lng: CONFIG.defaultCenter[0] },
  frozen: false,
};

let tracking = false;
let watchId = null;
let selectedCell = engine.getSnapshot().store.baseCell;
let walkIndex = 0;
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

function simulateStep() {
  const here = mapView.getUserLocation();
  const target = DEMO_WALK[walkIndex % DEMO_WALK.length];
  const nextTarget = DEMO_WALK[(walkIndex + 1) % DEMO_WALK.length];
  const distToTarget = Math.hypot(target[0] - here.lng, target[1] - here.lat);
  if (distToTarget < 0.0004) walkIndex += 1;
  const heading = bearingBetween(here.lat, here.lng, nextTarget[1], nextTarget[0]);
  const next = destinationPoint(here.lat, here.lng, heading, CONFIG.simulateStepMeters);
  applyPosition(next.lat, next.lng, { dwellMs: 90_000, fly: true });
  toast('Moved ~95m onto the next real H3 cell. Ten minutes of dwell (or an Activity) unlocks it.');
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
  $('#quickProgressButton').addEventListener('click', simulateStep);
  $('#refreshButton').addEventListener('click', () => {
    $('#refreshButton').animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
      duration: 500,
    });
    if (!tracking) {
      toast('Turn on fog clearing to catch up your map.');
      return;
    }
    const { lat, lng } = mapView.getUserLocation();
    engine.dwell(cellAt(lat, lng), 60_000);
    renderHud();
    toast('Foreground refresh — fog caught up from the last batch.');
  });
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

await mapView.ready();
engine.subscribe(() => mapView.paint(engine.getSnapshot().store));
mapView.setUserLocation(CONFIG.defaultCenter[0], CONFIG.defaultCenter[1]);
selectCell(mapView.cellUnderUser());
bindUi();
renderHud();
setInterval(tick, 1000);
toast('Hex fog is H3 resolution 9 — each tile is a real ~174m cell.');
