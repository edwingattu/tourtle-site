import * as maplibreNs from 'https://esm.sh/maplibre-gl@5.6.0';
const maplibregl = maplibreNs.default ?? maplibreNs;
import { CONFIG, CATEGORY_COLORS } from './config.js';
import {
  cellAt,
  cellBoundary,
  cellCenter,
  cellsInBounds,
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

    if (map.getZoom() < CONFIG.minFogZoom) {
      if (fogSource && lastFogKey !== 'empty') {
        fogSource.setData(EMPTY_COLLECTION);
        lastFogKey = 'empty';
        lastStatusSig = null;
      }
    } else {
      const key = viewportKey();
      let cells;
      if (key === cachedCellsKey) {
        cells = cachedCells;
      } else {
        cells = cellsInBounds(map.getBounds());
        cachedCellsKey = key;
        cachedCells = cells;
      }
      if (cells.length > CONFIG.maxRenderCells) {
        if (fogSource && lastFogKey !== 'empty') {
          fogSource.setData(EMPTY_COLLECTION);
          lastFogKey = 'empty';
          lastStatusSig = null;
        }
      } else {
        const neighborSet = unlockedNeighborSet(store);
        const statuses = new Array(cells.length);
        for (let i = 0; i < cells.length; i++) {
          statuses[i] = tileStatus(cells[i], store, neighborSet);
        }
        const sig = statuses.join(',');
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
      onMove?.({
        zoom: map.getZoom(),
        cellCountHint: map.getZoom() < CONFIG.minFogZoom ? 0 : 1,
      });
    };
    map.on('moveend', () => {
      window.clearTimeout(moveTimer);
      moveTimer = window.setTimeout(refreshViewport, 80);
    });
    map.on('zoomend', refreshViewport);
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
      const rec = store.tiles[cell];
      const neighborSet = unlockedNeighborSet(store);
      return {
        cell,
        status: tileStatus(cell, store, neighborSet),
        rec,
        unlocked: isUnlocked(rec),
        center: cellCenter(cell),
      };
    },
  };
}

function userPuck() {
  const el = document.createElement('div');
  el.className = 'user-puck';
  el.innerHTML = '<i></i>';
  return el;
}
