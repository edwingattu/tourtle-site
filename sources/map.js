import * as maplibregl from 'https://unpkg.com@^6.10.0/dist/maplibre-gl.mjs';

const hyderabad = [78.4867, 17.4375];

// High-resolution vector street tile system mapping stylesheet
const highDefStreetStyle = 'https://openfreemap.org';

// Hexagon layout constraints projected onto geographic coordinates
const hexRadius = 0.0035; 
const columns = 9;
const rows = 7;
const centerLng = hyderabad[0];
const centerLat = hyderabad[1];

// Calculates map node vertices points for point-top honeycomb geometries
function getHexPolygon(lng, lat, radius) {
  const coordinates = [];
  for (let i = 0; i < 6; i++) {
    const angleRad = (Math.PI / 180) * (60 * i - 30); 
    const pLng = lng + radius * Math.cos(angleRad) * 1.05; 
    const pLat = lat + radius * Math.sin(angleRad);
    coordinates.push([pLng, pLat]);
  }
  coordinates.push(coordinates[0]); 
  return [coordinates];
}

// Packages the honeycomb positions array structures inside standard GeoJSON feature structures
function generateHexGridData() {
  const features = [];
  let index = 0;
  
  // Restored full parameters matching the core state data definitions
  const activatedTiles =;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const lngOffset = c * (hexRadius * Math.sqrt(3)) + ((r % 2) * (hexRadius * Math.sqrt(3) / 2));
      const latOffset = r * (hexRadius * 1.5);
      
      const finalLng = centerLng + (lngOffset - (columns * hexRadius * Math.sqrt(3)) / 2.1);
      const finalLat = centerLat + (latOffset - (rows * hexRadius * 1.5) / 2);

      let status = 'unclaimed';
      if (window.initialUnlocked && window.initialUnlocked.has(index)) {
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
          isCurrent: window.state ? (index === window.state.selectedHex) : (index === 32)
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

try {
  const map = new maplibregl.Map({
    container: 'liveMap',
    style: highDefStreetStyle,
    center: hyderabad,
    zoom: 13.2,
    bearing: -9,
    pitch: 0,
  });

  window.tourtleMap = map; 

  map.on('load', () => {
    const gridData = generateHexGridData();

    map.addSource('hex-grid', {
      type: 'geojson',
      data: gridData,
      promoteId: 'index'
    });

    map.addLayer({
      id: 'hex-fills',
      type: 'fill',
      source: 'hex-grid',
      paint: {
        'fill-color': [
          'case',
          ['==', ['get', 'status'], 'unlocked'], 'rgba(0,0,0,0)',
          ['==', ['get', 'status'], 'activated'], '#9bdaff',
          '#55616e'
        ],
        'fill-opacity': [
          'case',
          ['==', ['get', 'status'], 'unlocked'], 0,
          ['==', ['get', 'status'], 'activated'], 0.55,
          0.32
        ]
      }
    });

    map.addLayer({
      id: 'hex-borders',
      type: 'line',
      source: 'hex-grid',
      paint: {
        'line-color': [
          'case',
          ['boolean', ['get', 'isCurrent'], false], '#ff836b',
          ['==', ['get', 'status'], 'unlocked'], '#2465a7',
          'rgba(36, 101, 167, 0.2)'
        ],
        'line-width': [
          'case',
          ['boolean', ['get', 'isCurrent'], false], 4.5,
          ['==', ['get', 'status'], 'unlocked'], 3.5,
          1.0
        ]
      }
    });

    map.on('click', 'hex-fills', (e) => {
      if (e.features && e.features.length > 0) {
        const clickedIndex = e.features[0].properties.index;
        if (typeof window.selectHex === 'function') {
          window.selectHex(clickedIndex);
        }
      }
    });

    map.on('mouseenter', 'hex-fills', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'hex-fills', () => { map.getCanvas().style.cursor = ''; });
  });

  window.addEventListener('tourtle:recenter', () => {
    map.easeTo({ center: hyderabad, zoom: 13.2, duration: 750 });
  });
} catch (error) {
  console.warn('The live map could not be initialized.', error);
}
