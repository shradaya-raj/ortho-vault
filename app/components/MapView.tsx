'use client';

import { useEffect, useRef } from 'react';
import type { Ortho } from '../lib/orthos';

const tiffCache = new Map<string, ReturnType<typeof loadTiff>>();

async function loadTiff(url: string) {
  const { fromUrl } = await import('geotiff');
  return fromUrl(url, { cacheSize: 200 });
}

export default function MapView({ ortho, showOrtho, showBoundary }: { ortho: Ortho; showOrtho: boolean; showBoundary: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    let disposed = false;
    let map: import('leaflet').Map | undefined;

    Promise.all([import('leaflet'), import('proj4')]).then(async ([L, proj4Module]) => {
      if (disposed || !element.current) return;
      const proj4 = proj4Module.default;
      const bounds = L.latLngBounds([ortho.south, ortho.west], [ortho.north, ortho.east]);
      map = L.map(element.current, { zoomControl: false, preferCanvas: true }).fitBounds(bounds, { padding: [28, 28] });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 20 }).addTo(map);

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
      if (showBoundary) L.rectangle(bounds, { color: '#e1a83f', weight: 2, fill: false }).addTo(map);
      L.control.zoom({ position: 'topleft' }).addTo(map);
    });
    return () => { disposed = true; map?.remove(); };
  }, [ortho, showOrtho, showBoundary]);
  return <div ref={element} className="leaflet-map" aria-label={`Interactive map of ${ortho.name}`} />;
}
