import { CONFIG } from './config.js';
import { cellCenter, cellsForPolygon, isUnlocked } from './engine.js';

/**
 * Semantic tiles: Area > District > City > State > Country > Continent.
 * H9 hexes are the immutable base; every higher tile is a SET of H9 cells
 * (areas) or a set of child tiles (everything above). Status aggregates
 * upward with the same fraction rule at every level.
 *
 * Data packs live in ./data/*.json (built by scripts/build-areas.py).
 * areas.json loads at startup; upper packs lazy-load on first zoom-out.
 */
const packs = { meta: null, areas: null, districts: null, states: null, countries: null };
const loading = {};

let hexToArea = new Map();

function packUrl(name) {
  return new URL(`./data/${name}.json`, import.meta.url);
}

export async function loadCore() {
  if (!packs.meta) {
    const [meta, areas] = await Promise.all([
      fetch(packUrl('meta')).then((r) => r.json()),
      fetch(packUrl('areas')).then((r) => r.json()),
    ]);
    packs.meta = meta;
    packs.areas = areas;
  }
  return packs.meta;
}

const LEVEL_PACKS = {
  district: ['districts'],
  city: ['districts'],
  state: ['states'],
  country: ['countries'],
  continent: ['countries'],
};

export function levelReady(level) {
  if (level === 'area') return !!packs.areas;
  return (LEVEL_PACKS[level] || []).every((n) => !!packs[n]);
}

/** Fetch missing packs for a level. Resolves true if anything was newly loaded. */
export function ensureLevel(level) {
  const need = (LEVEL_PACKS[level] || []).filter((n) => !packs[n]);
  if (!need.length) return Promise.resolve(false);
  const jobs = need.map((n) => {
    if (!loading[n]) {
      loading[n] = fetch(packUrl(n))
        .then((r) => r.json())
        .then((j) => {
          packs[n] = j;
          return true;
        })
        .catch(() => false);
    }
    return loading[n];
  });
  return Promise.all(jobs).then((rs) => rs.some(Boolean));
}

export function getPack(name) {
  return packs[name] || null;
}
export function getMeta() {
  return packs.meta;
}
export function getCity() {
  return packs.meta?.city || null;
}

// ---- geometry helpers (lng/lat, even-odd across rings = holes safe) ----
function bboxOf(polys) {
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1e9;
  let y1 = -1e9;
  for (const poly of polys)
    for (const ring of poly)
      for (const p of ring) {
        if (p[0] < x0) x0 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[0] > x1) x1 = p[0];
        if (p[1] > y1) y1 = p[1];
      }
  return [x0, y0, x1, y1];
}

function pip(lng, lat, polys) {
  for (const poly of polys) {
    let inside = false;
    for (const ring of poly) {
      let j = ring.length - 1;
      for (let i = 0; i < ring.length; i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi) {
          inside = !inside;
        }
        j = i;
      }
    }
    if (inside) return true;
  }
  return false;
}

function findIn(items, lng, lat) {
  if (!items) return null;
  for (const it of items) {
    const b = it._bbox || (it._bbox = bboxOf(it.polys));
    if (lng < b[0] || lat < b[1] || lng > b[2] || lat > b[3]) continue;
    if (pip(lng, lat, it.polys)) return it;
  }
  return null;
}

export function areaAt(lng, lat) {
  return findIn(packs.areas, lng, lat);
}
export function districtAt(lng, lat) {
  return findIn(packs.districts, lng, lat);
}
export function stateAt(lng, lat) {
  return findIn(packs.states, lng, lat);
}
export function countryAt(lng, lat) {
  return findIn(packs.countries, lng, lat);
}

// ---- hex rasterization: hexes as the drawing board ----
// Each area is rasterized once into member H9 cells (polygonToCells per ward
// polygon) plus dissolved outer edge segments for borders. Members are the
// authoritative area contents (complete, not limited to the city disk);
// hexToArea maps every member hex back to its area.
let areaHexMembers = new Map(); // areaId -> [{cell, lat, lng}]
let hexRasterBuilt = false;

export function buildAreaHexes() {
  if (hexRasterBuilt) return;
  hexRasterBuilt = true;
  areaHexMembers = new Map();
  hexToArea = new Map();
  for (const a of packs.areas || []) {
    const set = new Set();
    for (const poly of a.polys) {
      const outer = poly[0].map(([x, y]) => [y, x]); // [lng,lat] -> [lat,lng]
      for (const cell of cellsForPolygon(outer)) set.add(cell);
    }
    const members = [];
    for (const cell of set) {
      const c = cellCenter(cell);
      members.push({ cell, lat: c.lat, lng: c.lng });
      if (!hexToArea.has(cell)) hexToArea.set(cell, a.id);
    }
    areaHexMembers.set(a.id, members);
  }
}

/** Member list for one area (authoritative contents). */
export function areaHexMembersOf(id) {
  return areaHexMembers.get(id) || [];
}

export function areaOfHex(cell) {
  return hexToArea.get(cell) || null;
}

// ---- statuses: locked / activated / unlocked (30%) / mastered (50%) ----
function decideStatus(total, unlocked, active) {
  if (total > 0 && unlocked >= Math.max(CONFIG.areaMasteredMin, Math.ceil(CONFIG.areaMasteredFraction * total))) {
    return 'mastered';
  }
  if (total > 0 && unlocked >= Math.max(CONFIG.areaUnlockMin, Math.ceil(CONFIG.areaUnlockFraction * total))) {
    return 'unlocked';
  }
  return active > 0 ? 'activated' : 'unclaimed';
}

export function computeAreaStats(store) {
  const out = new Map();
  for (const a of packs.areas || []) {
    const members = areaHexMembers.get(a.id) || [];
    let unlocked = 0;
    let touched = 0;
    for (const m of members) {
      const rec = store.tiles[m.cell];
      if (!rec) continue;
      if (isUnlocked(rec)) unlocked += 1;
      else touched += 1;
    }
    out.set(a.id, {
      total: members.length,
      unlocked,
      touched,
      status: decideStatus(members.length, unlocked, unlocked + touched),
    });
  }
  return out;
}

function rollupChildren(childIds, childStats) {
  // Mastered implies unlocked: mastered children count toward both bars.
  let unlocked = 0;
  let active = 0;
  for (const id of childIds) {
    const s = childStats.get(id);
    if (!s) continue;
    if (s.status === 'unlocked' || s.status === 'mastered') {
      unlocked += 1;
      active += 1;
    } else if (s.status === 'activated') {
      active += 1;
    }
  }
  const total = childIds.length;
  return { total, unlocked, active, status: decideStatus(total, unlocked, active) };
}

/** Full hierarchy rollup. Districts/states without children stay unclaimed. */
export function computeRollup(store, areaStats) {
  const areas = packs.areas || [];
  const districts = packs.districts || [];
  const states = packs.states || [];
  const countries = packs.countries || [];
  const city = getCity();

  const areasByDistrict = new Map();
  for (const a of areas) {
    if (!a.parent) continue;
    if (!areasByDistrict.has(a.parent)) areasByDistrict.set(a.parent, []);
    areasByDistrict.get(a.parent).push(a.id);
  }
  const districtStats = new Map();
  for (const d of districts) {
    districtStats.set(d.id, rollupChildren(areasByDistrict.get(d.id) || [], areaStats));
  }

  const districtsByState = new Map();
  for (const d of districts) {
    if (!d.parent) continue;
    if (!districtsByState.has(d.parent)) districtsByState.set(d.parent, []);
    districtsByState.get(d.parent).push(d.id);
  }
  const stateStats = new Map();
  for (const s of states) {
    stateStats.set(s.id, rollupChildren(districtsByState.get(s.id) || [], districtStats));
  }

  const statesByCountry = new Map();
  for (const s of states) {
    if (!s.parent) continue;
    if (!statesByCountry.has(s.parent)) statesByCountry.set(s.parent, []);
    statesByCountry.get(s.parent).push(s.id);
  }
  const countryStats = new Map();
  for (const c of countries) {
    countryStats.set(c.id, rollupChildren(statesByCountry.get(c.id) || [], stateStats));
  }

  const countriesByContinent = new Map();
  for (const c of countries) {
    const cont = c.continent || 'Other';
    if (!countriesByContinent.has(cont)) countriesByContinent.set(cont, []);
    countriesByContinent.get(cont).push(c.id);
  }
  const continentStats = new Map();
  for (const [cont, ids] of countriesByContinent) {
    continentStats.set(cont, rollupChildren(ids, countryStats));
  }

  const cityStats = city
    ? { ...rollupChildren(city.members || [], districtStats), name: city.name }
    : null;

  return { areas: areaStats, districts: districtStats, states: stateStats,
           countries: countryStats, continents: continentStats, city: cityStats };
}

// ---- GeoJSON builders ----
export function levelFeatures(items, statsMap) {
  return {
    type: 'FeatureCollection',
    features: (items || []).map((it) => {
      const st = statsMap.get(it.id);
      const status = st?.status || 'unclaimed';
      const frac = st && st.total > 0 ? Math.round((st.unlocked / st.total) * 100) : 0;
      return {
        type: 'Feature',
        properties: { id: it.id, name: it.name, status, frac },
        // Single polygons unwrap one level; MultiPolygons pass through.
        geometry: it.polys.length > 1
          ? { type: 'MultiPolygon', coordinates: it.polys }
          : { type: 'Polygon', coordinates: it.polys[0] },
      };
    }),
  };
}

export function labelFeatures(items, statsMap) {
  return {
    type: 'FeatureCollection',
    features: (items || [])
      .filter((it) => it.c)
      .map((it) => ({
        type: 'Feature',
        properties: { name: it.name, status: statsMap.get(it.id)?.status || 'unclaimed' },
        geometry: { type: 'Point', coordinates: it.c },
      })),
  };
}
