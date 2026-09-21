import * as maplibreNs from 'https://esm.sh/maplibre-gl@5.6.0';
const maplibregl = maplibreNs.default ?? maplibreNs;
import { CONFIG, CATEGORY_COLORS } from './config.js';
import {
  cellAt,
  cellBoundary,
  cellCenter,
  cellResolution,
  cellsInBounds,
  childrenOf,
  diskCells,
  gridDistance,
  neighbors,
  parentCell,
  tileStatus,
  unlockedNeighborSet,
  isUnlocked,
} from './engine.js';

export function createMap({ onHexSelect, onMove }) {
  const map = new maplibregl.Map({
    container: 'liveMap',
    style: CONFIG.mapStyle,
    center: CONFIG.defaultCenter,
    zoom: CONFIG.defaultZoom,
    attributionControl: true,
  });

  const userMarker = new maplibregl.Marker({ element: userPuck(), anchor: 'center' });
  let selectedCell = null;
  let userLngLat = CONFIG.defaultCenter;

  // ---- Paint scheduler + caches (perf) ----
  // paint() is called up to twice per second (dwell tick + HUD) plus on every
  // pan/zoom. Rebuilding 2800 H3 polygons + setData each time blocks the main
  // thread and janks panning. So: coalesce calls into one rAF, reuse cached
  // geometry for an unchanged viewport, and skip setData entirely when no
  // tile status actually changed.
  let paintQueued = false;
  let pendingStore = null;
  let lastFogKey = null;
  let lastStatusSig = null;
  let lastActSig = null;
  let cachedCellsKey = null;
  let cachedCells = [];
  const boundaryCache = new Map();
  const BOUNDARY_CACHE_MAX = 20000;

  // ---- City-core grid cache ----
  // One gridDisk(k=45) around the base cell ≈ 6.2k cells / GHMC core.
  // Centers are precomputed once (cheap, synchronous); per-pan rendering
  // filters this list by viewport bounds instead of re-running the H3
  // polygon polyfill. Rebuilt only when the base moves >15 rings (~4.5km).
  // Viewports outside the cached disk fall back to polygonToCells below.
  let cityCenter = null;
  let cityList = [];

  function ensureCityCache(baseCell) {
    if (cityCenter && gridDistance(baseCell, cityCenter) <= 15) return;
    const ids = diskCells(baseCell, CONFIG.cityCacheK);
    const list = new Array(ids.length);
    for (let i = 0; i < ids.length; i++) {
      const center = cellCenter(ids[i]);
      list[i] = { cell: ids[i], lat: center.lat, lng: center.lng };
    }
    cityCenter = baseCell;
    cityList = list;
  }

  function cityCovers(centerCell) {
    if (!cityCenter || cityList.length === 0) return false;
    return gridDistance(centerCell, cityCenter) <= CONFIG.cityCacheK - 15;
  }

  function sliceCityCells(bounds) {
    const pad = 0.002;
    const n = bounds.getNorth() + pad;
    const s = bounds.getSouth() - pad;
    const e = bounds.getEast() + pad;
    const w = bounds.getWest() - pad;
    const out = [];
    for (let i = 0; i < cityList.length; i++) {
      const c = cityList[i];
      if (c.lat <= n && c.lat >= s && c.lng <= e && c.lng >= w) out.push(c.cell);
    }
    return out;
  }

  // ---- Resolution ladder: fog at every zoom ----
  // Res-9 cells for a zoomed-out viewport would be millions of polygons, so
  // coarser parent cells render instead (same 3 tints, statuses aggregated
  // from the res-9 store). An adaptive loop guarantees a render: step down
  // while over budget, one refinement step up via children when it fits.
  function fogResolutionForZoom(zoom) {
    if (zoom >= 13) return 9;
    if (zoom >= 11) return 8;
    if (zoom >= 9) return 7;
    if (zoom >= 7) return 6;
    if (zoom >= 5) return 4;
    if (zoom >= 3) return 3;
    return 2;
  }

  function coarseStatusMaps(store, res) {
    const unlocked = new Set();
    const touched = new Set();
    const entries = Object.entries(store.tiles);
    for (const [cell, rec] of entries) {
      const anc = parentCell(cell, res);
      if (isUnlocked(rec)) unlocked.add(anc);
      else touched.add(anc);
    }
    // Mirror the res-9 rule: an unlocked tile activates its neighbors.
    for (const [cell, rec] of entries) {
      if (!isUnlocked(rec)) continue;
      for (const nb of neighbors(cell)) {
        const a = parentCell(nb, res);
        if (!unlocked.has(a)) touched.add(a);
      }
    }
    return { unlocked, touched };
  }

  function resolveCells(bounds, centerCell, zoom) {
    // Res 9 inside the cached city disk: slice, no polyfill at all.
    if (fogResolutionForZoom(zoom) === CONFIG.h3Resolution && cityCovers(centerCell)) {
      return { res: CONFIG.h3Resolution, cells: sliceCityCells(bounds) };
    }
    const guess = fogResolutionForZoom(zoom);
    const key = `${viewportKey()}#${guess}`;
    if (key === cachedCellsKey) return cachedCells;
    let res = guess;
    let cells = cellsInBounds(bounds, res);
    let guard = 0;
    while (cells.length > CONFIG.maxRenderCells && res > 1 && guard++ < 5) {
      res -= 1;
      cells = cellsInBounds(bounds, res);
    }
    // One refinement step via children (cheap, no polyfill) when it fits.
    if (res < CONFIG.h3Resolution && cells.length * 7 <= CONFIG.maxRenderCells) {
      const kids = [];
      for (const c of cells) {
        const ch = childrenOf(c, res + 1);
        for (const k of ch) kids.push(k);
      }
      res += 1;
      cells = kids;
    }
    const out = { res, cells };
    cachedCellsKey = key;
    cachedCells = out;
    return out;
  }

  function viewportKey() {
    const b = map.getBounds();
    const z = map.getZoom();
    const r = (n) => n.toFixed(4);
    return `${z.toFixed(2)}|${r(b.getNorth())}|${r(b.getSouth())}|${r(b.getEast())}|${r(b.getWest())}`;
  }

  function boundaryFor(cell) {
    let ring = boundaryCache.get(cell);
    if (!ring) {
      ring = cellBoundary(cell);
      if (boundaryCache.size > BOUNDARY_CACHE_MAX) boundaryCache.clear();
      boundaryCache.set(cell, ring);
    }
    return ring;
  }

  const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

  function doPaint(store) {
    const fogSource = map.getSource('hex-fog');
    const pinsSource = map.getSource('activities');

    if (store.baseCell) ensureCityCache(store.baseCell);

    const bounds = map.getBounds();
    const c = map.getCenter();
    const { res, cells } = resolveCells(bounds, cellAt(c.lat, c.lng), map.getZoom());
    if (cells.length > CONFIG.maxRenderCells) {
      if (fogSource && lastFogKey !== 'empty') {
        fogSource.setData(EMPTY_COLLECTION);
        lastFogKey = 'empty';
        lastStatusSig = null;
      }
    } else {
      let statuses;
      if (res === CONFIG.h3Resolution) {
        const neighborSet = unlockedNeighborSet(store);
        statuses = new Array(cells.length);
        for (let i = 0; i < cells.length; i++) {
          statuses[i] = tileStatus(cells[i], store, neighborSet);
        }
      } else {
        const { unlocked, touched } = coarseStatusMaps(store, res);
        statuses = new Array(cells.length);
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i];
          statuses[i] = unlocked.has(cell) ? 'unlocked' : touched.has(cell) ? 'activated' : 'unclaimed';
        }
      }
      const sig = `${res}:${statuses.join(',')}`;
      const key = viewportKey();
      if (fogSource && (sig !== lastStatusSig || key !== lastFogKey)) {
        fogSource.setData({
          type: 'FeatureCollection',
          features: cells.map((cell, i) => ({
            type: 'Feature',
            properties: { h3: cell, status: statuses[i] },
            geometry: { type: 'Polygon', coordinates: [boundaryFor(cell)] },
          })),
        });
        lastStatusSig = sig;
        lastFogKey = key;
      }
    }

    const acts = store.activities || [];
    const actSig = `${acts.length}:${acts.length ? acts[acts.length - 1].createdAt : 0}`;
    if (pinsSource && actSig !== lastActSig) {
      pinsSource.setData(activityCollection(acts));
      lastActSig = actSig;
    }
  }

  function activityCollection(activities) {
    return {
      type: 'FeatureCollection',
      features: activities.map((activity) => ({
        type: 'Feature',
        properties: {
          id: activity.id,
          category: activity.category,
          color: CATEGORY_COLORS[activity.category] || '#173668',
          title: activity.title,
        },
        geometry: { type: 'Point', coordinates: [activity.lng, activity.lat] },
      })),
    };
  }

  map.on('load', () => {
    map.addSource('hex-fog', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('activities', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    // Single seamless fill layer — no border/line layer by design.
    // Adjacent H3 cells share exact edges; antialiasing is off so no
    // hairline seams appear between tiles.
    map.addLayer({
      id: 'hex-fills',
      type: 'fill',
      source: 'hex-fog',
      paint: {
        'fill-antialias': false,
        'fill-color': [
          'match',
          ['get', 'status'],
          'unlocked',
          'rgba(0,0,0,0)',
          'activated',
          '#87c9f5',
          '#3e4a57',
        ],
        'fill-opacity': [
          'match',
          ['get', 'status'],
          'unlocked',
          0,
          'activated',
          0.42,
          0.62,
        ],
      },
    });

    map.addLayer({
      id: 'activity-pins',
      type: 'circle',
      source: 'activities',
      paint: {
        'circle-radius': 7,
        'circle-color': ['get', 'color'],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    });

    map.on('click', 'hex-fills', (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      selectedCell = feature.properties.h3;
      onHexSelect?.(selectedCell, feature.properties.status);
    });

    map.on('mouseenter', 'hex-fills', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'hex-fills', () => {
      map.getCanvas().style.cursor = '';
    });

    let moveTimer = 0;
    const refreshViewport = () => {
      onMove?.({ zoom: map.getZoom(), cellCountHint: 1 });
    };
    map.on('moveend', () => {
      window.clearTimeout(moveTimer);
      moveTimer = window.setTimeout(refreshViewport, 80);
    });
    map.on('zoomend', refreshViewport);
    // Track gestures live: paints are rAF-coalesced and status-skipped, so
    // per-frame cost is one small polyfill (or a cache slice) at most.
    map.on('move', refreshViewport);
  });

  return {
    map,
    ready() {
      return map.loaded() ? Promise.resolve() : new Promise((resolve) => map.once('load', resolve));
    },
    paint(store) {
      // Coalesce bursts (tick + HUD paint in the same second, pan + tick,
      // select + HUD) into a single repaint on the next animation frame.
      pendingStore = store;
      if (paintQueued) return;
      paintQueued = true;
      requestAnimationFrame(() => {
        paintQueued = false;
        const next = pendingStore;
        pendingStore = null;
        if (next) doPaint(next);
      });
    },
    setSelected(cell) {
      selectedCell = cell;
    },
    setUserLocation(lng, lat, { fly = false } = {}) {
      userLngLat = [lng, lat];
      userMarker.setLngLat(userLngLat).addTo(map);
      if (fly) map.easeTo({ center: userLngLat, zoom: Math.max(map.getZoom(), 14), duration: 700 });
    },
    getUserLocation() {
      return { lng: userLngLat[0], lat: userLngLat[1] };
    },
    cellUnderUser() {
      return cellAt(userLngLat[1], userLngLat[0]);
    },
    recenter(target = userLngLat) {
      map.easeTo({ center: target, zoom: Math.max(map.getZoom(), CONFIG.defaultZoom), duration: 750 });
    },
    currentCellCenter(cell) {
      return cellCenter(cell);
    },
    inspectCell(store, cell) {
      if (cellResolution(cell) === CONFIG.h3Resolution) {
        const rec = store.tiles[cell];
        const neighborSet = unlockedNeighborSet(store);
        return {
          cell,
          status: tileStatus(cell, store, neighborSet),
          rec,
          unlocked: isUnlocked(rec),
          center: cellCenter(cell),
        };
      }
      // Coarse fog cell tapped while zoomed out: aggregate from the res-9 store.
      const { unlocked, touched } = coarseStatusMaps(store, cellResolution(cell));
      const status = unlocked.has(cell) ? 'unlocked' : touched.has(cell) ? 'activated' : 'unclaimed';
      return { cell, status, rec: store.tiles[cell], unlocked: status === 'unlocked', center: cellCenter(cell) };
    },
  };
}

function userPuck() {
  const el = document.createElement('div');
  el.className = 'user-puck';
  el.innerHTML = '<i></i>';
  return el;
}
