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
  // True while the painted band shows an activated or mastered tile — drives
  // the border pulse interval below. Reset every paint, set by notePulseStats.
  let pulseNeeded = false;
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

  function notePulseStats(stats) {
    if (!stats || pulseNeeded) return;
    for (const s of stats.values()) {
      if (s?.status === 'activated' || s?.status === 'mastered') {
        pulseNeeded = true;
        return;
      }
    }
  }

  function statusSigOf(items, stats) {
    if (!items) return '0';
    const parts = new Array(items.length);
    for (let i = 0; i < items.length; i++) parts[i] = stats.get(items[i].id)?.status || 'u';
    return parts.join(',');
  }

  function updateBandLabels(band, labels, labelStats, extraLabel) {
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

  function updateBandSources(band, items, stats, labels, labelStats, extraLabel) {
    const tileSource = map.getSource(`${band}-tiles`);
    if (tileSource) {
      const sig = `${band}:${statusSigOf(items, stats)}`;
      if (sig !== semSig[band]) {
        tileSource.setData(areas.levelFeatures(items, stats));
        semSig[band] = sig;
      }
    }
    updateBandLabels(band, labels, labelStats, extraLabel);
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
          id: cell,
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
    notePulseStats(areaStats);
    let items;
    let stats;
    let labels;
    let labelStats;
    let extraLabel = null;
    if (band === 'area') {
      // Areas render as their member hexes (hexes as the drawing board),
      // tinted by area status — never as raw ward polygons.
      const bounds = map.getBounds();
      const pad = 0.002;
      const n = bounds.getNorth() + pad;
      const s = bounds.getSouth() - pad;
      const e = bounds.getEast() + pad;
      const w = bounds.getWest() - pad;
      const cells = [];
      const statuses = [];
      const seen = new Set();
      for (const a of areas.getPack('areas') || []) {
        const st = areaStats.get(a.id)?.status || 'unclaimed';
        for (const m of areas.areaHexMembersOf(a.id)) {
          if (seen.has(m.cell)) continue;
          if (m.lat <= n && m.lat >= s && m.lng <= e && m.lng >= w) {
            seen.add(m.cell);
            cells.push(m.cell);
            statuses.push(st);
          }
        }
      }
      const fogSource = map.getSource('hex-fog');
      if (cells.length > CONFIG.maxRenderCells) {
        if (fogSource && lastFogKey !== 'empty') {
          fogSource.setData(EMPTY_COLLECTION);
          lastFogKey = 'empty';
          lastStatusSig = null;
        }
      } else {
        const sig = `area-hex:${statuses.join(',')}`;
        const key = viewportKey();
        if (fogSource && (sig !== lastStatusSig || key !== lastFogKey)) {
          fogSource.setData({
            type: 'FeatureCollection',
            features: cells.map((cell, i) => ({
              type: 'Feature',
              id: cell,
              properties: { h3: cell, status: statuses[i] },
              geometry: { type: 'Polygon', coordinates: [boundaryFor(cell)] },
            })),
          });
          lastStatusSig = sig;
          lastFogKey = key;
        }
      }
      const areaItems = areas.getPack('areas');
      updateBandSources('area', areaItems, areaStats, areaItems, areaStats, null);
      return;
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
    pulseNeeded = false;
    if (store.baseCell) ensureCityCache(store.baseCell);
    if (areas.levelReady('area')) areas.buildAreaHexes();
    const band = bandForZoom(map.getZoom());
    if (band === 'street') {
      const areaStats = areas.levelReady('area') ? areas.computeAreaStats(store) : null;
      paintHexFog(store, areaStats, { forceRes9: true });
      // Area borders + labels overlay the street hexes for orientation.
      if (areaStats) {
        notePulseStats(areaStats);
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
    // Ward borders are the true OSM ward polygons (area-tiles); the hex fog
    // underneath stays hexes. No dissolved hex-edge overlay anymore.
      // (area-edges source retired: ward outlines now come from area-tiles.)

    // Polygon states: locked + activated share the dark-grey fill (the border
    // carries activation); unlocked goes hex-activated blue; mastered gold.
    const TILE_FILL_COLOR = [
      'match',
      ['get', 'status'],
      'unlocked',
      '#2e7cc2',
      'mastered',
      '#d9a13b',
      '#3e4a57',
    ];
    const TILE_FILL_OPACITY = [
      'match',
      ['get', 'status'],
      'unlocked',
      0.55,
      'mastered',
      0.45,
      0.62,
    ];

    // One fill + glow border + core border + labels per semantic level.
    // Bands mirror app/data/meta.json; area borders/labels extend into the
    // street band as an orientation overlay. Adjacent bands overlap by FADE
    // on each side with a zoom-ramped opacity, so levels crossfade instead
    // of popping. Hex features carry stable H3 ids so status changes and
    // band swaps animate through paint transitions.
    const FADE = 0.4;
    const BAND_VIS = {
      area: { min: 11.5, max: 12.5, text: [11.5, 10, 13, 14] },
      district: { min: 9.5, max: 11.5, text: [9.5, 10, 12, 15] },
      city: { min: 7.5, max: 9.5, text: [7.5, 11, 10, 16] },
      state: { min: 5.5, max: 7.5, text: [5.5, 10, 8, 15] },
      country: { min: 3.5, max: 5.5, text: [3.5, 9, 6, 14] },
      continent: { min: 0, max: 3.5, text: [0, 12, 4, 20] },
    };
    // 0→1 ramp across the overlap below the band, 1→0 above (unless open).
    // NOTE: zoom must feed a top-level interpolate (style-spec rule), so the
    // status match sits inside the output stops — never multiplied outside.
    function faded(matchExpr, lo, hi, topOpen) {
      const stops = [];
      if (lo > FADE) stops.push(lo - FADE, 0, lo, matchExpr);
      else stops.push(0, matchExpr);
      if (topOpen) stops.push(Math.max(hi, 22), matchExpr);
      else stops.push(hi, matchExpr, hi + FADE, 0);
      return ['interpolate', ['linear'], ['zoom'], ...stops];
    }
    function bandRamp(lo, hi, topOpen) {
      const stops = [];
      if (lo > FADE) stops.push(lo - FADE, 0, lo, 1);
      else stops.push(0, 1);
      if (topOpen) stops.push(Math.max(hi, 22), 1);
      else stops.push(hi, 1, hi + FADE, 0);
      return ['interpolate', ['linear'], ['zoom'], ...stops];
    }
    // Borders: locked darker grey; activated glowing blue; unlocked solid
    // blue; mastered gold. Pulse (separate layer below) is reserved for
    // activated (blue) and mastered (gold).
    const GLOW_OPACITY = ['match', ['get', 'status'], 'activated', 0.35, 'mastered', 0.35, 0];
    const CORE_COLOR = [
      'match',
      ['get', 'status'],
      'activated',
      '#7fd4ff',
      'unlocked',
      '#2e7cc2',
      'mastered',
      '#d9a13b',
      '#2b343f',
    ];
    const CORE_WIDTH = ['match', ['get', 'status'], 'mastered', 2.5, 'activated', 2, 'unlocked', 2, 1];
    const LABEL_COLOR = [
      'match',
      ['get', 'status'],
      'unclaimed',
      '#66788c',
      'mastered',
      '#8a6d1f',
      '#0e4a7a',
    ];
    for (const [band, vis] of Object.entries(BAND_VIS)) {
      const openTop = band === 'area';
      const ramp = bandRamp(vis.min, vis.max, openTop);
      const visMin = Math.max(0, vis.min - FADE);
      const visMax = openTop ? 22 : vis.max + FADE;
      map.addLayer({
        id: `${band}-fill`,
        type: 'fill',
        source: `${band}-tiles`,
        minzoom: visMin,
        maxzoom: vis.max,
        paint: {
          'fill-color': TILE_FILL_COLOR,
          'fill-opacity': faded(TILE_FILL_OPACITY, vis.min, vis.max, openTop),
          'fill-opacity-transition': { duration: 300, delay: 0 },
        },
      });
      map.addLayer({
        id: `${band}-border-glow`,
        type: 'line',
        source: `${band}-tiles`,
        minzoom: visMin,
        maxzoom: visMax,
        paint: {
          'line-color': '#7fd4ff',
          'line-opacity': faded(GLOW_OPACITY, vis.min, vis.max, openTop),
          'line-opacity-transition': { duration: 300, delay: 0 },
          'line-width': 6,
          'line-blur': 2,
        },
      });
      map.addLayer({
        id: `${band}-border`,
        type: 'line',
        source: `${band}-tiles`,
        minzoom: visMin,
        maxzoom: visMax,
        paint: {
          'line-color': CORE_COLOR,
          'line-opacity': ramp,
          'line-opacity-transition': { duration: 300, delay: 0 },
          'line-width': CORE_WIDTH,
        },
      });
      // Pulse overlay: activated breathes blue, mastered breathes gold.
      // Opacity is driven by the interval below (static number + transition),
      // so the data expressions above are never touched.
      map.addLayer({
        id: `${band}-pulse`,
        type: 'line',
        source: `${band}-tiles`,
        minzoom: visMin,
        maxzoom: visMax,
        filter: ['in', ['get', 'status'], ['literal', ['activated', 'mastered']]],
        paint: {
          'line-color': ['match', ['get', 'status'], 'mastered', '#e8b93e', '#7fd4ff'],
          'line-opacity': 0,
          'line-opacity-transition': { duration: 700, delay: 0 },
          'line-width': 8,
          'line-blur': 3,
        },
      });
      map.addLayer({
        id: `${band}-labels`,
        type: 'symbol',
        source: `${band}-labels`,
        minzoom: visMin,
        maxzoom: visMax,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], vis.text[0], vis.text[1], vis.text[2], vis.text[3]],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: {
          'text-color': LABEL_COLOR,
          'text-opacity': ramp,
          'text-opacity-transition': { duration: 300, delay: 0 },
          'text-halo-color': 'rgba(255,255,255,0.9)',
          'text-halo-width': 2,
        },
      });
    }
    // Our tile labels replace the basemap's: hide every base symbol layer.
    for (const l of map.getStyle().layers) {
      if (l.type === 'symbol' && !/^(area|district|city|state|country|continent)-labels$/.test(l.id)) {
        map.setLayoutProperty(l.id, 'visibility', 'none');
      }
    }

    // Border pulse: activated breathes blue, mastered breathes gold. One
    // shared breath via static opacity + transition — data expressions
    // untouched. Idle (opacity 0) unless a live tile is painted.
    const PULSE_BANDS = ['area', 'district', 'city', 'state', 'country', 'continent'];
    let pulseHigh = false;
    setInterval(() => {
      if (!pulseNeeded) {
        if (pulseHigh) {
          pulseHigh = false;
          for (const band of PULSE_BANDS) {
            if (map.getLayer(`${band}-pulse`)) map.setPaintProperty(`${band}-pulse`, 'line-opacity', 0);
          }
        }
        return;
      }
      pulseHigh = !pulseHigh;
      const v = pulseHigh ? 0.5 : 0.08;
      for (const band of PULSE_BANDS) {
        if (map.getLayer(`${band}-pulse`)) map.setPaintProperty(`${band}-pulse`, 'line-opacity', v);
      }
    }, 750);

    // Single seamless fill layer — no border/line layer by design.
    // Adjacent H3 cells share exact edges; antialiasing is off so no
    // hairline seams appear between tiles.
    // Hex tiles stay seamless and borderless. Unlocked hexes glow golden —
    // the same terminal color mastered polygons use.
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
          '#d9a13b',
          'activated',
          '#2e7cc2',
          '#3e4a57',
        ],
        'fill-opacity': [
          'match',
          ['get', 'status'],
          'unlocked',
          0.45,
          'activated',
          0.55,
          0.62,
        ],
        'fill-opacity-transition': { duration: 300, delay: 0 },
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
    // Free zoom everywhere: tile appearance transitions at band edges via
    // layer min/maxzoom. No snapping — the camera stays where the user puts it.
    map.on('zoomend', refreshViewport);
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
