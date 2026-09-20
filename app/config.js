/** Server-shaped V0 config. Thresholds stay in one place so they can later move to Supabase. */
export const CONFIG = {
  h3Resolution: 9,
  dwellThresholdMs: 10 * 60 * 1000,
  activityBoostMs: 5 * 60 * 1000,
  outingInactivityMs: 2 * 60 * 60 * 1000,
  maxRenderCells: 2800,
  minFogZoom: 11.2,
  implausibleSpeedMps: 55,
  weakAccuracyM: 85,
  smoothWindow: 5,
  simulateStepMeters: 95,
  mapStyle: 'https://tiles.openfreemap.org/styles/liberty',
  defaultCenter: [78.4867, 17.4375],
  defaultZoom: 14.1,
  coverageRingK: 12,
  nominatimUrl: 'https://nominatim.openstreetmap.org/reverse',
};

export const CATEGORIES = [
  { id: 'sightseeing', label: 'Sightseeing & Heritage', short: 'Heritage', icon: '🏛️' },
  { id: 'dining', label: 'Dining', short: 'Dining', icon: '🍲' },
  { id: 'nature', label: 'Nature & Outdoors', short: 'Nature', icon: '🌿' },
  { id: 'sports', label: 'Sports & Adventure', short: 'Sports', icon: '🏃' },
  { id: 'events', label: 'Events', short: 'Events', icon: '🎟️' },
  { id: 'nightlife', label: 'Nightlife', short: 'Nightlife', icon: '🌙' },
  { id: 'wellness', label: 'Wellness', short: 'Wellness', icon: '🧖' },
  { id: 'travel', label: 'Travel', short: 'Travel', icon: '🚶' },
];

export const CATEGORY_COLORS = {
  sightseeing: '#c9853a',
  dining: '#d85a3a',
  nature: '#2f8f62',
  sports: '#2a69aa',
  events: '#6e66a9',
  nightlife: '#3d2f6b',
  wellness: '#4aa3a8',
  travel: '#173668',
};

/** Real street-level walk through Begumpet → Necklace Road for the + simulator. */
export const DEMO_WALK = [
  [78.4867, 17.4375],
  [78.4841, 17.4358],
  [78.4812, 17.4341],
  [78.4784, 17.4322],
  [78.4758, 17.4301],
  [78.4739, 17.4278],
  [78.4732, 17.4254],
  [78.4736, 17.4234],
  [78.4755, 17.4222],
  [78.4782, 17.4216],
  [78.4810, 17.4219],
  [78.4836, 17.4233],
  [78.4858, 17.4256],
  [78.4874, 17.4284],
  [78.4879, 17.4314],
  [78.4869, 17.4346],
];
