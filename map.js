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
// Construct the complete GeoJSON FeatureCollection grid
function generateHexGridData() {
  const features = [];
  let index = 0;
  
  // Explicitly match your original UI design prototype parameters
  const activatedTiles =;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      // Calculate centers matching your exact honeycomb geometry offset
      const lngOffset = c * (hexRadius * Math.sqrt(3)) + ((r % 2) * (hexRadius * Math.sqrt(3) / 2));
      const latOffset = r * (hexRadius * 1.5);
      
      // Center the matrix grid visually over your home location coordinates in Hyderabad
      const finalLng = centerLng + (lngOffset - (columns * hexRadius * Math.sqrt(3)) / 2.3);
      const finalLat = centerLat + (latOffset - (rows * hexRadius * 1.5) / 2);

      // Determine the structural tile state configuration
      let status = 'unclaimed';
      if (window.initialUnlocked.has(index)) {
        status = 'unlocked';
      } else if (activatedTiles.includes(index)) {
        status = 'activated';
      }

      features.push({
        type: 'Feature',
        id: index,
        properties: { 
          index, 
          status, 
          isCurrent: index === window.state.selectedHex 
        },
        geometry: {
          type: 'Polygon',
          coordinates: getHexPolygon(finalLng, finalLat, hexRadius)
        }
      });
      index++;
    }
  }
  return { type: 'FeatureCollection', features };
}
