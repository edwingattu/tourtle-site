import { cellAt } from './engine.js';

// Sandbox joystick (diagnostics): a floating nub that walks the user pointer
// around the map. Enabling flips the engine into sandbox mode and drops the
// pointer in Manhattan; all movement accrues through the normal dwell path
// but is ledgered for rollback and excluded from every cloud upload.
// Disabling (or relaunching) wipes the temporary exploration.

const NYC = { lng: -73.9855, lat: 40.758 };
const RADIUS_PX = 44;
const STEP_PX = 60;
const STEP_MS = 120;
const DEADZONE = 0.15;
const SELECT_THROTTLE_MS = 2000;

export function setupJoystick({ mapView, engine, selectCell, toast }) {
  const btn = document.getElementById('joystickButton');
  const pad = document.getElementById('joystick');
  const base = pad?.querySelector('.joy-base');
  const nub = pad?.querySelector('.joy-nub');
  if (!btn || !pad || !base || !nub) return { isActive: () => false };

  let active = false;
  let vec = { x: 0, y: 0 };
  let timer = 0;
  let lastCell = null;
  let lastSelectAt = 0;

  function setNub(dx, dy) {
    nub.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function step() {
    if (Math.hypot(vec.x, vec.y) < DEADZONE) return;
    const map = mapView.map;
    // Advance from the marker's own position (not a fixed screen point) and
    // carry the camera with it — motion continues until the nub is released.
    const cur = mapView.getUserLocation();
    const pt = map.project([cur.lng, cur.lat]);
    const ll = map.unproject([pt.x + vec.x * STEP_PX, pt.y + vec.y * STEP_PX]);
    mapView.setUserLocation(ll.lng, ll.lat);
    map.jumpTo({ center: [ll.lng, ll.lat] });
    const cell = cellAt(ll.lat, ll.lng);
    engine.dwell(cell, STEP_MS);
    // Refresh the summary panel on new cells, throttled (each select can
    // reverse-geocode — never per-tick).
    const now = Date.now();
    if (cell !== lastCell && now - lastSelectAt > SELECT_THROTTLE_MS) {
      lastCell = cell;
      lastSelectAt = now;
      selectCell?.(cell);
    }
  }

  function enable() {
    active = true;
    lastCell = null;
    lastSelectAt = 0;
    engine.setSandbox(true);
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
    pad.hidden = false;
    mapView.setUserLocation(NYC.lng, NYC.lat);
    mapView.map.easeTo({
      center: [NYC.lng, NYC.lat],
      zoom: Math.max(mapView.map.getZoom(), 13),
      duration: 900,
    });
    selectCell?.(mapView.cellUnderUser());
    timer = window.setInterval(step, STEP_MS);
    toast?.('Sandbox joystick — exploration is temporary and never syncs.');
  }

  function disable() {
    active = false;
    window.clearInterval(timer);
    vec = { x: 0, y: 0 };
    setNub(0, 0);
    engine.setSandbox(false); // rolls sandbox gains back out
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
    pad.hidden = true;
    toast?.('Sandbox cleared — temporary exploration removed.');
  }

  btn.addEventListener('click', () => (active ? disable() : enable()));

  function pointToVec(e) {
    const r = base.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const m = Math.hypot(dx, dy);
    if (m > RADIUS_PX) {
      dx = (dx / m) * RADIUS_PX;
      dy = (dy / m) * RADIUS_PX;
    }
    setNub(dx, dy);
    vec = { x: dx / RADIUS_PX, y: dy / RADIUS_PX };
  }

  base.addEventListener('pointerdown', (e) => {
    base.setPointerCapture(e.pointerId);
    pointToVec(e);
  });
  base.addEventListener('pointermove', (e) => {
    if (e.buttons) pointToVec(e);
  });
  const release = () => {
    vec = { x: 0, y: 0 };
    setNub(0, 0);
  };
  base.addEventListener('pointerup', release);
  base.addEventListener('pointercancel', release);

  return { isActive: () => active };
}
