'use client';

import { useEffect, useRef } from 'react';
import type { Ortho } from '../lib/orthos';

const tiffCache = new Map<string, ReturnType<typeof loadTiff>>();

async function loadTiff(url: string) {
  const { fromUrl } = await import('geotiff');
  return fromUrl(url, { cacheSize: 200 });
}

export default function MapView({ ortho, basemap, showOrtho, showBuildings, showDistricts }: { ortho: Ortho; basemap: 'osm' | 'satellite'; showOrtho: boolean; showBuildings: boolean; showDistricts: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const savedView = useRef<{ center: [number, number]; zoom: number } | null>(null);
  useEffect(() => {
    if (!element.current) return;
    let disposed = false;
    let map: import('leaflet').Map | undefined;

    (async () => {
      const [L, proj4Module, toGeoJSON] = await Promise.all([
        import('leaflet'),
        import('proj4'),
        import('@tmcw/togeojson'),
      ]);
      // MarkerCluster's browser bundle expects Leaflet on the global object.
      // Expose it before loading the plugin so production chunk ordering is safe.
      (globalThis as typeof globalThis & { L: typeof L }).L = L;
      await import('leaflet.markercluster');
      if (disposed || !element.current) return;
      const proj4 = proj4Module.default;
      const bounds = L.latLngBounds([ortho.south, ortho.west], [ortho.north, ortho.east]);
      map = L.map(element.current, { zoomControl: false, preferCanvas: true });
      if (savedView.current) {
        map.setView(savedView.current.center, savedView.current.zoom, { animate: false });
      } else {
        map.fitBounds(bounds, { padding: [28, 28], animate: false });
      }
      if (basemap === 'satellite') {
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles © Esri — Sources: Esri, Maxar, Earthstar Geographics, and contributors', maxZoom: 20 }).addTo(map);
      } else {
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 20 }).addTo(map);
      }

      if (showOrtho && ortho.image_url) {
        if (/\.tiff?(?:$|\?)/i.test(ortho.image_url)) {
          const sourceProjection = `+proj=utm +zone=${ortho.epsg - 32600} +datum=WGS84 +units=m +no_defs`;
          const tiffPromise = tiffCache.get(ortho.image_url) ?? loadTiff(ortho.image_url);
          tiffCache.set(ortho.image_url, tiffPromise);
          const tiff = await tiffPromise;
          const image = await tiff.getImage();
          const [minX, minY, maxX, maxY] = image.getBoundingBox();

          const RasterGrid = L.GridLayer.extend({
            createTile(coords: import('leaflet').Coords, done: (error?: Error | null, tile?: HTMLElement) => void) {
              const canvas = document.createElement('canvas');
              canvas.width = 256; canvas.height = 256;
              const tileMap = (this as unknown as { _map: import('leaflet').Map })._map;
              const nw = tileMap.unproject(L.point(coords.x * 256, coords.y * 256), coords.z);
              const se = tileMap.unproject(L.point((coords.x + 1) * 256, (coords.y + 1) * 256), coords.z);
              const [west, north] = proj4('EPSG:4326', sourceProjection, [nw.lng, nw.lat]);
              const [east, south] = proj4('EPSG:4326', sourceProjection, [se.lng, se.lat]);
              const left = Math.max(minX, west), right = Math.min(maxX, east);
              const bottom = Math.max(minY, south), top = Math.min(maxY, north);
              if (left >= right || bottom >= top) { done(null, canvas); return canvas; }

              const destinationX = Math.round(((left - west) / (east - west)) * 256);
              const destinationY = Math.round(((north - top) / (north - south)) * 256);
              const destinationWidth = Math.max(1, Math.round(((right - left) / (east - west)) * 256));
              const destinationHeight = Math.max(1, Math.round(((top - bottom) / (north - south)) * 256));

              tiff.readRasters({ bbox: [left, bottom, right, top], width: destinationWidth, height: destinationHeight, samples: [0, 1, 2, 3], interleave: true, resampleMethod: 'bilinear' })
                .then((result) => {
                  const values = result as unknown as ArrayLike<number>;
                  const rgba = new Uint8ClampedArray(destinationWidth * destinationHeight * 4);
                  for (let i = 0; i < rgba.length; i += 4) {
                    rgba[i] = values[i] ?? 0; rgba[i + 1] = values[i + 1] ?? 0; rgba[i + 2] = values[i + 2] ?? 0; rgba[i + 3] = values[i + 3] ?? 255;
                  }
                  const context = canvas.getContext('2d');
                  context?.putImageData(new ImageData(rgba, destinationWidth, destinationHeight), destinationX, destinationY);
                  done(null, canvas);
                }).catch((error: Error) => done(error, canvas));
              return canvas;
            },
          });
          new RasterGrid({ tileSize: 256, opacity: 0.92, bounds, minZoom: 9, maxZoom: 20 }).addTo(map);
        } else {
          L.imageOverlay(ortho.image_url, bounds, { opacity: 0.9 }).addTo(map);
        }
      }
      const loadKml = async (url: string) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`KML request failed: ${response.status}`);
        return toGeoJSON.kml(new DOMParser().parseFromString(await response.text(), 'text/xml'));
      };

      if (showDistricts && ortho.districts_kml_url) {
        const districts = await loadKml(ortho.districts_kml_url);
        L.geoJSON(districts, {
          style: { color: '#071b2b', weight: 6, opacity: 0.9, fillOpacity: 0 },
          interactive: false,
        }).addTo(map);
        L.geoJSON(districts, {
          style: { color: '#00e5ff', weight: 3, opacity: 1, fillColor: '#00e5ff', fillOpacity: 0.05 },
          onEachFeature(feature, layer) {
            const properties = feature.properties ?? {};
            const name = properties.GaPa_NaPa || properties.DISTRICT || '';
            if (name) layer.bindTooltip(String(name), { permanent: true, direction: 'center', className: 'district-label' });
          },
        }).addTo(map);
      }

      if (showBuildings && ortho.buildings_kml_url) {
        const buildings = await loadKml(ortho.buildings_kml_url);
        const cluster = L.markerClusterGroup({ maxClusterRadius: 42, showCoverageOnHover: false, spiderfyOnMaxZoom: true });
        L.geoJSON(buildings, {
          pointToLayer(feature, latlng) {
            const icon = L.divIcon({ className: 'building-marker', html: '<span aria-hidden="true">▰</span>', iconSize: [20, 20], iconAnchor: [10, 10] });
            return L.marker(latlng, { icon, title: String(feature.properties?.Remarks ?? 'Flood affected building') });
          },
          onEachFeature(feature, layer) { layer.bindTooltip(String(feature.properties?.Remarks ?? 'Flood affected building')); },
        }).eachLayer((layer) => cluster.addLayer(layer));
        cluster.addTo(map);
      }
      L.control.zoom({ position: 'topleft' }).addTo(map);
    })().catch((error) => console.error('Unable to initialize the map', error));
    return () => {
      disposed = true;
      if (map) {
        const center = map.getCenter();
        savedView.current = { center: [center.lat, center.lng], zoom: map.getZoom() };
        map.remove();
      }
    };
  }, [ortho, basemap, showOrtho, showBuildings, showDistricts]);
  return <div ref={element} className="leaflet-map" aria-label={`Interactive map of ${ortho.name}`} />;
}
