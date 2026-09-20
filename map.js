import * as maplibregl from 'https://unpkg.com/maplibre-gl@^6.10.0/dist/maplibre-gl.mjs';

const hyderabad = [78.4867, 17.4375];

const osmStyle = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{
    id: 'osm',
    type: 'raster',
    source: 'osm',
    paint: {
      'raster-saturation': -0.52,
      'raster-brightness-min': 0.46,
      'raster-brightness-max': 0.94,
    },
  }],
};

try {
  const map = new maplibregl.Map({
    container: 'liveMap',
    style: osmStyle,
    center: hyderabad,
    zoom: 13.3,
    bearing: -9,
    pitch: 0,
  });

  window.addEventListener('tourtle:recenter', () => {
    map.easeTo({ center: hyderabad, zoom: 13.3, duration: 750 });
  });
} catch (error) {
  console.warn('The live map could not be initialized; the prototype background remains available.', error);
}
