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
