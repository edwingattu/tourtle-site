import * as maplibreNs from 'https://esm.sh/maplibre-gl@5.6.0';
const maplibregl = maplibreNs.default ?? maplibreNs;
import { CONFIG, CATEGORY_COLORS } from './config.js';
import * as areas from './areas.js';
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

export function createMap({ onHexSelect, onMove, onLevelSelect }) {
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
  let lastStoreRef = null;
  let lastFogKey = null;
  let lastStatusSig = null;
  let lastActSig = null;
  let cachedCellsKey = null;
  let cachedCells = null;
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
    if (cityCenter && gridDistance(baseCell, cityCenter) <= 15) return false;
    const ids = diskCells(baseCell, CONFIG.cityCacheK);
    const list = new Array(ids.length);
    for (let i = 0; i < ids.length; i++) {
      const center = cellCenter(ids[i]);
      list[i] = { cell: ids[i], lat: center.lat, lng: center.lng };
    }
    cityCenter = baseCell;
    cityList = list;
    return true;
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
  const semSig = {};

  function schedulePaint(store) {
    pendingStore = store;
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      const next = pendingStore;
      pendingStore = null;
      if (next) doPaint(next);
    });
  }

  // ---- Semantic bands ----
  // Above the street band the map shows Area > District > City > State >
  // Country > Continent tiles. Free continuous zoom lives only at street
  // level (z >= 12.5); everything above snaps to anchors (see load block).
  function bandForZoom(zoom) {
    if (zoom >= 12.5) return 'street';
    if (zoom >= 11.5) return 'area';
    if (zoom >= 9.5) return 'district';
    if (zoom >= 7.5) return 'city';
    if (zoom >= 5.5) return 'state';
    if (zoom >= 3.5) return 'country';
    return 'continent';
  }

  function bandCovers(band, lng, lat) {
    switch (band) {
      case 'area':
        return !!areas.areaAt(lng, lat);
      case 'district':
      case 'city':
        return !!areas.districtAt(lng, lat);
      case 'state':
        return !!areas.stateAt(lng, lat);
      default:
        return true; // country + continent packs are global
    }
  }

  function statusSigOf(items, stats) {
    if (!items) return '0';
    const parts = new Array(items.length);
    for (let i = 0; i < items.length; i++) parts[i] = stats.get(items[i].id)?.status || 'u';
    return parts.join(',');
  }

  function updateBandSources(band, items, stats, labels, labelStats, extraLabel) {
    const tileSource = map.getSource(`${band}-tiles`);
    if (tileSource) {
      const sig = `${band}:${statusSigOf(items, stats)}`;
      if (sig !== semSig[band]) {
        tileSource.setData(areas.levelFeatures(items, stats));
        semSig[band] = sig;
      }
    }
    const labelSource = map.getSource(`${band}-labels`);
    if (labelSource) {
      const lsig = `${band}-labels:${statusSigOf(labels, labelStats)}`;
      if (lsig !== semSig[`${band}-labels`]) {
        const feats = areas.labelFeatures(labels, labelStats);
        if (extraLabel) feats.features.push(extraLabel);
        labelSource.setData(feats);
        semSig[`${band}-labels`] = lsig;
      }
    }
  }

  function paintHexFog(store, areaStats, { forceRes9 = false } = {}) {
    const fogSource = map.getSource('hex-fog');
    const bounds = map.getBounds();
    const c = map.getCenter();
    let res;
    let cells;
    if (forceRes9) {
      // Street band always renders true H9 cells, never the ladder.
      res = CONFIG.h3Resolution;
      const centerCell = cellAt(c.lat, c.lng);
      if (cityCovers(centerCell)) {
        cells = sliceCityCells(bounds);
      } else {
        const key = `${viewportKey()}#9`;
        if (key === cachedCellsKey) {
          cells = cachedCells.cells;
        } else {
          cells = cellsInBounds(bounds, CONFIG.h3Resolution);
          cachedCellsKey = key;
          cachedCells = { res, cells };
        }
      }
    } else {
      ({ res, cells } = resolveCells(bounds, cellAt(c.lat, c.lng), map.getZoom()));
    }
    if (cells.length > CONFIG.maxRenderCells) {
      if (fogSource && lastFogKey !== 'empty') {
        fogSource.setData(EMPTY_COLLECTION);
        lastFogKey = 'empty';
        lastStatusSig = null;
      }
      return;
    }
    let statuses;
    if (res === CONFIG.h3Resolution) {
      const neighborSet = unlockedNeighborSet(store);
      let activeAreas = null;
      if (areaStats) {
        activeAreas = new Set();
        for (const [id, s] of areaStats) if (s.status !== 'unclaimed') activeAreas.add(id);
      }
      statuses = new Array(cells.length);
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const rec = store.tiles[cell];
        if (isUnlocked(rec)) statuses[i] = 'unlocked';
        else if (rec || neighborSet.has(cell)) statuses[i] = 'activated';
        // Whole-area activation: one unlocked hex lights its entire area,
        // revealing the area shape. Unlocked hexes stay individually clear.
        else if (activeAreas && activeAreas.has(areas.areaOfHex(cell))) statuses[i] = 'activated';
        else statuses[i] = 'unclaimed';
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

  function paintSemanticBand(store, band) {
    // Packs lazy-load on first zoom-out; the H3 ladder covers the wait and
    // any region without semantic data.
    if (!areas.levelReady(band)) {
      areas.ensureLevel(band).then((loaded) => {
        if (loaded && lastStoreRef) schedulePaint(lastStoreRef);
      });
      paintHexFog(store, null);
      return;
    }
    const ctr = map.getCenter();
    if (!bandCovers(band, ctr.lng, ctr.lat)) {
      paintHexFog(store, null);
      return;
    }
    const areaStats = areas.computeAreaStats(store);
    const rollup = band === 'area' ? null : areas.computeRollup(store, areaStats);
    let items;
    let stats;
    let labels;
    let labelStats;
    let extraLabel = null;
    if (band === 'area') {
      items = areas.getPack('areas');
      stats = areaStats;
      labels = items;
      labelStats = areaStats;
    } else if (band === 'district') {
      items = areas.getPack('districts');
      stats = rollup.districts;
      labels = items;
      labelStats = rollup.districts;
    } else if (band === 'city') {
      // City tile = member districts sharing one aggregated status; other
      // districts keep their own. City label replaces member district labels.
      const city = areas.getCity();
      const districts = areas.getPack('districts');
      items = districts;
      stats = new Map();
      for (const d of districts || []) {
        stats.set(
          d.id,
          city && city.members.includes(d.id)
            ? rollup.city
            : rollup.districts.get(d.id) || { status: 'unclaimed', total: 0, unlocked: 0 },
        );
      }
      labels = (districts || []).filter((d) => !(city && city.members.includes(d.id)));
      labelStats = rollup.districts;
      if (city) {
        extraLabel = {
          type: 'Feature',
          properties: { name: city.name, status: rollup.city?.status || 'unclaimed' },
          geometry: { type: 'Point', coordinates: city.c },
        };
      }
    } else if (band === 'state') {
      items = areas.getPack('states');
      stats = rollup.states;
      labels = items;
      labelStats = rollup.states;
    } else if (band === 'country') {
      items = areas.getPack('countries');
      stats = rollup.countries;
      labels = items;
      labelStats = rollup.countries;
    } else {
      const countries = areas.getPack('countries') || [];
      items = countries;
      stats = new Map();
      for (const cn of countries) {
        stats.set(
          cn.id,
          rollup.continents.get(cn.continent || 'Other') || { status: 'unclaimed', total: 0, unlocked: 0 },
        );
      }
      const meta = areas.getMeta();
      labels = (meta?.continents || []).map((k) => ({ id: k.name, name: k.name, c: k.c }));
      labelStats = rollup.continents;
    }
    updateBandSources(band, items, stats, labels, labelStats, extraLabel);
    // The all-zoom hex layer must not double-render under semantic tiles.
    const fogSource = map.getSource('hex-fog');
    if (fogSource && lastFogKey !== 'semantic') {
      fogSource.setData(EMPTY_COLLECTION);
      lastFogKey = 'semantic';
      lastStatusSig = null;
    }
  }

  function doPaint(store) {
    lastStoreRef = store;
    if (store.baseCell) {
      if (ensureCityCache(store.baseCell)) areas.setCityHexes(cityList);
    }
    const band = bandForZoom(map.getZoom());
    if (band === 'street') {
      const areaStats = areas.levelReady('area') ? areas.computeAreaStats(store) : null;
      paintHexFog(store, areaStats, { forceRes9: true });
      // Area borders + labels overlay the street hexes for orientation.
      if (areaStats) {
        const items = areas.getPack('areas');
        updateBandSources('area', items, areaStats, items, areaStats, null);
      }
    } else {
      paintSemanticBand(store, band);
    }

    const acts = store.activities || [];
    const actSig = `${acts.length}:${acts.length ? acts[acts.length - 1].createdAt : 0}`;
    const pinsSource = map.getSource('activities');
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
    for (const band of ['area', 'district', 'city', 'state', 'country', 'continent']) {
      map.addSource(`${band}-tiles`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource(`${band}-labels`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }

    const TILE_FILL_COLOR = [
      'match',
      ['get', 'status'],
      'unlocked',
      'rgba(0,0,0,0)',
      'activated',
      '#2e7cc2',
      '#3e4a57',
    ];
    const TILE_FILL_OPACITY = [
      'match',
      ['get', 'status'],
      'unlocked',
      0,
      'activated',
      0.55,
      0.62,
    ];

    // One fill + glow border + core border + labels per semantic level.
    // Bands mirror app/data/meta.json; area borders/labels extend into the
    // street band as an orientation overlay.
    const BAND_VIS = {
      area: { min: 11.5, max: 12.5, text: [11.5, 10, 13, 14] },
      district: { min: 9.5, max: 11.5, text: [9.5, 10, 12, 15] },
      city: { min: 7.5, max: 9.5, text: [7.5, 11, 10, 16] },
      state: { min: 5.5, max: 7.5, text: [5.5, 10, 8, 15] },
      country: { min: 3.5, max: 5.5, text: [3.5, 9, 6, 14] },
      continent: { min: 0, max: 3.5, text: [0, 12, 4, 20] },
    };
    for (const [band, vis] of Object.entries(BAND_VIS)) {
      map.addLayer({
        id: `${band}-fill`,
        type: 'fill',
        source: `${band}-tiles`,
        minzoom: vis.min,
        maxzoom: vis.max,
        paint: { 'fill-color': TILE_FILL_COLOR, 'fill-opacity': TILE_FILL_OPACITY },
      });
      map.addLayer({
        id: `${band}-border-glow`,
        type: 'line',
        source: `${band}-tiles`,
        minzoom: vis.min,
        maxzoom: band === 'area' ? 22 : vis.max,
        paint: {
          'line-color': '#7fd4ff',
          'line-opacity': ['match', ['get', 'status'], 'unlocked', 0.55, 'activated', 0.35, 0],
          'line-width': 6,
          'line-blur': 2,
        },
      });
      map.addLayer({
        id: `${band}-border`,
        type: 'line',
        source: `${band}-tiles`,
        minzoom: vis.min,
        maxzoom: band === 'area' ? 22 : vis.max,
        paint: {
          'line-color': ['match', ['get', 'status'], 'unlocked', '#eaf7ff', 'activated', '#7fd4ff', '#42546a'],
          'line-width': ['match', ['get', 'status'], 'unlocked', 2.5, 'activated', 2, 1],
        },
      });
      map.addLayer({
        id: `${band}-labels`,
        type: 'symbol',
        source: `${band}-labels`,
        minzoom: vis.min,
        maxzoom: band === 'area' ? 22 : vis.max,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], vis.text[0], vis.text[1], vis.text[2], vis.text[3]],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: {
          'text-color': ['match', ['get', 'status'], 'unclaimed', '#66788c', '#0e4a7a'],
          'text-halo-color': 'rgba(255,255,255,0.9)',
          'text-halo-width': 2,
        },
      });
    }

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
          '#2e7cc2',
          '#3e4a57',
        ],
        'fill-opacity': [
          'match',
          ['get', 'status'],
          'unlocked',
          0,
          'activated',
          0.55,
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

    for (const band of ['area', 'district', 'city', 'state', 'country', 'continent']) {
      map.on('click', `${band}-tiles`, (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        onLevelSelect?.(band, feature.properties);
      });
      map.on('mouseenter', `${band}-tiles`, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', `${band}-tiles`, () => {
        map.getCanvas().style.cursor = '';
      });
    }

    let moveTimer = 0;
    const refreshViewport = () => {
      onMove?.({ zoom: map.getZoom(), cellCountHint: 1 });
    };
    map.on('moveend', () => {
      window.clearTimeout(moveTimer);
      moveTimer = window.setTimeout(refreshViewport, 80);
    });
    // Snap zoom: above the street band the camera rests only on level
    // anchors (Continent 2.5 → Area 12.5). Free continuous zoom lives at
    // street level. Bands switch at midpoints so camera and tiles agree.
    map.on('zoomend', () => {
      refreshViewport();
      const z = map.getZoom();
      if (z >= 12.5 - 0.06) return;
      const anchors = [2.5, 4.5, 6.5, 8.5, 10.5, 12.5];
      let best = anchors[0];
      for (const a of anchors) if (Math.abs(a - z) < Math.abs(best - z)) best = a;
      if (Math.abs(best - z) > 0.06) map.easeTo({ zoom: best, duration: 350 });
    });
    // Track gestures live: paints are rAF-coalesced and status-skipped, so
    // per-frame cost is one small polyfill (or a cache slice) at most.
    map.on('move', refreshViewport);
  });

  return {
    map,
    async ready() {
      await (map.loaded() ? Promise.resolve() : new Promise((resolve) => map.once('load', resolve)));
      // Area pack powers street-level activation + borders; without it the
      // map still works (H3 + ladder fallback).
      try {
        await areas.loadCore();
      } catch {
        /* offline or missing pack — ladder fallback covers rendering */
      }
    },
    paint(store) {
      schedulePaint(store);
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
        let status = tileStatus(cell, store, neighborSet);
        if (status === 'unclaimed' && areas.levelReady('area')) {
          const areaStats = areas.computeAreaStats(store);
          const aid = areas.areaOfHex(cell);
          if (aid && areaStats.get(aid)?.status !== 'unclaimed') status = 'activated';
        }
        return {
          cell,
          status,
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
