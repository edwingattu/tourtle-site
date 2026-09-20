import * as h3 from 'https://esm.sh/h3-js@4.5.0';
import { CONFIG } from './config.js';

const STORAGE_KEY = 'tourtle.v0.hex-progress';

export function cellAt(lat, lng, res = CONFIG.h3Resolution) {
  return h3.latLngToCell(lat, lng, res);
}

export function cellCenter(cell) {
  const [lat, lng] = h3.cellToLatLng(cell);
  return { lat, lng };
}

export function cellBoundary(cell) {
  const ring = h3.cellToBoundary(cell, true);
  if (!ring.length) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  return ring;
}

export function neighbors(cell) {
  return h3.gridDisk(cell, 1).filter((id) => id !== cell);
}

export function coverageUniverse(originCell) {
  return h3.gridDisk(originCell, CONFIG.coverageRingK);
}

export function cellsInBounds(bounds, res = CONFIG.h3Resolution) {
  const pad = 0.002;
  const n = bounds.getNorth() + pad;
  const s = bounds.getSouth() - pad;
  const e = bounds.getEast() + pad;
  const w = bounds.getWest() - pad;
  try {
    return h3.polygonToCells(
      [
        [n, w],
        [n, e],
        [s, e],
        [s, w],
      ],
      res,
    );
  } catch {
    return [];
  }
}

export function destinationPoint(lat, lng, bearingDeg, meters) {
  const r = 6371000;
  const br = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lng * Math.PI) / 180;
  const δ = meters / r;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(br));
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(br) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: (φ2 * 180) / Math.PI, lng: (((λ2 * 180) / Math.PI + 540) % 360) - 180 };
}

export function bearingBetween(aLat, aLng, bLat, bLng) {
  const φ1 = (aLat * Math.PI) / 180;
  const φ2 = (bLat * Math.PI) / 180;
  const Δλ = ((bLng - aLng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function emptyStore() {
  return {
    version: 1,
    tiles: {},
    activities: [],
    streakDays: 0,
    lastActiveDate: null,
    outing: null,
    baseCell: cellAt(CONFIG.defaultCenter[1], CONFIG.defaultCenter[0]),
  };
}

function ensureTile(store, cell) {
  if (!store.tiles[cell]) {
    store.tiles[cell] = { dwellMs: 0, boostMs: 0, firstSeenAt: Date.now(), unlockedAt: null };
  }
  return store.tiles[cell];
}

export function tileProgress(rec) {
  if (!rec) return 0;
  return rec.dwellMs + rec.boostMs;
}

export function isUnlocked(rec) {
  if (!rec) return false;
  if (rec.unlockedAt) return true;
  return tileProgress(rec) >= CONFIG.dwellThresholdMs;
}

export function tileStatus(cell, store, neighborOfUnlocked) {
  const rec = store.tiles[cell];
  if (isUnlocked(rec)) return 'unlocked';
  if (rec || neighborOfUnlocked.has(cell)) return 'activated';
  return 'unclaimed';
}

export function unlockedNeighborSet(store) {
  const set = new Set();
  for (const [cell, rec] of Object.entries(store.tiles)) {
    if (!isUnlocked(rec)) continue;
    for (const n of h3.gridDisk(cell, 1)) set.add(n);
  }
  return set;
}

function maybeUnlock(rec) {
  if (!rec.unlockedAt && tileProgress(rec) >= CONFIG.dwellThresholdMs) {
    rec.unlockedAt = Date.now();
    return true;
  }
  return false;
}

function bumpStreak(store) {
  const today = todayKey();
  if (store.lastActiveDate === today) return;
  const yesterday = todayKey(new Date(Date.now() - 86400000));
  store.streakDays = store.lastActiveDate === yesterday ? store.streakDays + 1 : 1;
  store.lastActiveDate = today;
}

export function createEngine() {
  let store = emptyStore();
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '');
    if (raw?.version === 1 && raw.tiles) store = { ...emptyStore(), ...raw };
  } catch {
    /* first run */
  }

  const listeners = new Set();
  const emit = (extra = {}) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      /* quota */
    }
    const snapshot = getSnapshot();
    listeners.forEach((fn) => fn(snapshot, extra));
  };

  function getSnapshot() {
    const unlocked = Object.entries(store.tiles)
      .filter(([, rec]) => isUnlocked(rec))
      .map(([cell]) => cell);
    const universe = coverageUniverse(store.baseCell);
    const coverage = universe.length
      ? Math.round((unlocked.filter((c) => universe.includes(c)).length / universe.length) * 100)
      : 0;
    return {
      store,
      unlockedCount: unlocked.length,
      coverage,
      streakDays: store.streakDays,
      activities: store.activities,
      outing: store.outing,
      baseCell: store.baseCell,
    };
  }

  function touchCell(cell, { dwellMs = 0, boostMs = 0 } = {}) {
    const rec = ensureTile(store, cell);
    rec.dwellMs += dwellMs;
    rec.boostMs += boostMs;
    const unlockedNow = maybeUnlock(rec);
    if (store.outing) {
      if (!store.outing.touched.includes(cell)) store.outing.touched.push(cell);
      store.outing.lastTouchAt = Date.now();
    }
    bumpStreak(store);
    return { rec, unlockedNow, cell };
  }

  return {
    getSnapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setBase(lat, lng) {
      store.baseCell = cellAt(lat, lng);
      emit();
    },
    dwell(cell, ms) {
      const result = touchCell(cell, { dwellMs: ms });
      emit({ type: 'dwell', ...result });
      return result;
    },
    boostCells(cells, ms = CONFIG.activityBoostMs) {
      const unlocked = [];
      cells.forEach((cell) => {
        const result = touchCell(cell, { boostMs: ms });
        if (result.unlockedNow) unlocked.push(cell);
      });
      emit({ type: 'boost', cells, unlocked });
      return unlocked;
    },
    logActivity({ title, category, captureType, lat, lng, cell }) {
      const activity = {
        id: crypto.randomUUID(),
        title,
        category,
        captureType,
        lat,
        lng,
        cell,
        createdAt: Date.now(),
        tiles: store.outing ? [...store.outing.touched] : [cell],
      };
      store.activities.push(activity);
      const boostTargets = activity.tiles.length ? activity.tiles : [cell];
      this.boostCells(boostTargets);
      return activity;
    },
    startOuting() {
      store.outing = { startedAt: Date.now(), lastTouchAt: Date.now(), touched: [] };
      emit({ type: 'outing-start' });
    },
    endOuting() {
      const outing = store.outing;
      store.outing = null;
      emit({ type: 'outing-end' });
      return outing;
    },
    expireOutingIfNeeded() {
      if (!store.outing) return false;
      if (Date.now() - store.outing.lastTouchAt > CONFIG.outingInactivityMs) {
        store.outing = null;
        emit({ type: 'outing-expire' });
        return true;
      }
      return false;
    },
  };
}

export function remainingLabel(rec) {
  const left = Math.max(0, CONFIG.dwellThresholdMs - tileProgress(rec));
  if (left <= 0 || isUnlocked(rec)) return 'Unlocked';
  const minutes = Math.max(1, Math.ceil(left / 60000));
  return `${minutes} more minute${minutes === 1 ? '' : 's'}`;
}

export function progressPercent(rec) {
  return Math.min(100, Math.round((tileProgress(rec) / CONFIG.dwellThresholdMs) * 100));
}
