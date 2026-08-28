'use client';

import { useEffect, useRef } from 'react';
import type { Ortho } from '../lib/orthos';

type BaseMap = 'osm' | 'satellite';
type OverlayKey = 'ortho' | 'buildings' | 'districts' | 'river';
type OverlayLayers = Partial<Record<OverlayKey, import('leaflet').Layer>>;
const tiffCache = new Map<string, ReturnType<typeof loadTiff>>();

async function loadTiff(url: string) {
  const { fromUrl } = await import('geotiff');
  return fromUrl(url, { cacheSize: 200 } as Parameters<typeof fromUrl>[1]);
}

function makeBaseLayer(L: typeof import('leaflet'), basemap: BaseMap) {
  return basemap === 'satellite'
    ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles © Esri — Sources: Esri, Maxar, Earthstar Geographics, and contributors', maxZoom: 20 })
    : L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 20 });
}

export default function MapView({ ortho, basemap, showOrtho, showBuildings, showDistricts, showRiver }: { ortho: Ortho; basemap: BaseMap; showOrtho: boolean; showBuildings: boolean; showDistricts: boolean; showRiver: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const leafletRef = useRef<typeof import('leaflet') | null>(null);
  const baseLayerRef = useRef<import('leaflet').TileLayer | null>(null);
  const overlaysRef = useRef<OverlayLayers>({});
  const currentState = useRef({ basemap, showOrtho, showBuildings, showDistricts, showRiver });
  currentState.current = { basemap, showOrtho, showBuildings, showDistricts, showRiver };

  useEffect(() => {
    if (!element.current) return;
    const observer = new ResizeObserver(() => mapRef.current?.invalidateSize({ pan: false }));
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const map = mapRef.current, L = leafletRef.current;
    if (!map || !L) return;
    if (baseLayerRef.current) map.removeLayer(baseLayerRef.current);
    baseLayerRef.current = makeBaseLayer(L, basemap).addTo(map);
    baseLayerRef.current.bringToBack();
  }, [basemap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const desired: Record<OverlayKey, boolean> = { ortho: showOrtho, buildings: showBuildings, districts: showDistricts, river: showRiver };
    (Object.keys(desired) as OverlayKey[]).forEach((key) => {
      const layer = overlaysRef.current[key];
      if (!layer) return;
      if (desired[key] && !map.hasLayer(layer)) layer.addTo(map);
      if (!desired[key] && map.hasLayer(layer)) map.removeLayer(layer);
    });
  }, [showOrtho, showBuildings, showDistricts, showRiver]);

  useEffect(() => {
    if (!element.current) return;
    let disposed = false;

    (async () => {
      const [L, proj4Module, toGeoJSON] = await Promise.all([import('leaflet'), import('proj4'), import('@tmcw/togeojson')]);
      (globalThis as typeof globalThis & { L: typeof L }).L = L;
      await import('leaflet.markercluster');
      if (disposed || !element.current) return;
      leafletRef.current = L;
      const proj4 = proj4Module.default;
      const bounds = L.latLngBounds([ortho.south, ortho.west], [ortho.north, ortho.east]);
      const map = L.map(element.current, { zoomControl: false, preferCanvas: true }).fitBounds(bounds, { padding: [28, 28], animate: false });
      mapRef.current = map;
      baseLayerRef.current = makeBaseLayer(L, currentState.current.basemap).addTo(map);

      const setOverlay = (key: OverlayKey, layer: import('leaflet').Layer) => {
        overlaysRef.current[key] = layer;
        const visible = key === 'ortho' ? currentState.current.showOrtho : key === 'buildings' ? currentState.current.showBuildings : key === 'districts' ? currentState.current.showDistricts : currentState.current.showRiver;
        if (visible && !disposed) layer.addTo(map);
      };

      const protectedTileUrl = ortho.protected_tile_url;
      const protectedToken = ortho.protected_access_token;
      const fetchProtectedTile = async (layer: string, z: number, x: number, y: number, signal?: AbortSignal) => {
        if (!protectedTileUrl || !protectedToken) throw new Error('Protected map session is unavailable');
        const response = await fetch(`${protectedTileUrl}/${layer}/${z}/${x}/${y}`, {
          headers: { Authorization: `Bearer ${protectedToken}` },
          signal,
        });
        if (!response.ok) throw new Error(`Tile request failed: ${response.status}`);
        return response;
      };

      if (protectedTileUrl && protectedToken) {
        const ProtectedRaster = L.GridLayer.extend({
          createTile(coords: import('leaflet').Coords, done: (error?: Error | null, tile?: HTMLElement) => void) {
            const image = document.createElement('img');
            image.alt = '';
            image.width = 256;
            image.height = 256;
            const controller = new AbortController();
            fetchProtectedTile('drone', coords.z, coords.x, coords.y, controller.signal)
              .then((response) => response.blob())
              .then((blob) => {
                const objectUrl = URL.createObjectURL(blob);
                image.onload = () => { URL.revokeObjectURL(objectUrl); done(null, image); };
                image.onerror = () => { URL.revokeObjectURL(objectUrl); done(new Error('Unable to display imagery tile'), image); };
                image.src = objectUrl;
              })
              .catch((error: Error) => done(error, image));
            return image;
          },
        });
        const ProtectedRasterLayer = ProtectedRaster as unknown as new (options: import('leaflet').GridLayerOptions) => import('leaflet').GridLayer;
        setOverlay('ortho', new ProtectedRasterLayer({ tileSize: 256, opacity: 0.92, bounds, minZoom: 10, maxZoom: 20 }));

        const createProtectedVectorLayer = (layerName: string, options: import('leaflet').GeoJSONOptions, clustered = false) => {
          const container = clustered
            ? L.markerClusterGroup({ maxClusterRadius: 42, showCoverageOnHover: false, spiderfyOnMaxZoom: true })
            : L.layerGroup();
          let requests: AbortController[] = [];
          const refresh = async () => {
            requests.forEach((request) => request.abort());
            requests = [];
            container.clearLayers();
            const zoom = Math.max(8, Math.min(20, map.getZoom()));
            const pixelBounds = map.getPixelBounds();
            if (!pixelBounds.min || !pixelBounds.max) return;
            const min = pixelBounds.min.divideBy(256).floor();
            const max = pixelBounds.max.divideBy(256).floor();
            const seen = new Set<string>();
            for (let x = min.x; x <= max.x; x += 1) for (let y = min.y; y <= max.y; y += 1) {
              const controller = new AbortController();
              requests.push(controller);
              fetchProtectedTile(layerName, zoom, x, y, controller.signal).then((response) => response.json()).then((value: unknown) => {
                const geojson = value as { features?: import('geojson').Feature[] };
                const uniqueFeatures = (geojson.features ?? []).filter((feature: unknown) => {
                  const key = JSON.stringify(feature);
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });
                L.geoJSON({ type: 'FeatureCollection', features: uniqueFeatures } as import('geojson').FeatureCollection, options).eachLayer((featureLayer) => container.addLayer(featureLayer));
              }).catch((error: Error) => { if (error.name !== 'AbortError') console.warn(`Unable to load ${layerName} tile`, error); });
            }
          };
          map.on('moveend zoomend', refresh);
          container.on('add', refresh);
          container.on('remove', () => requests.forEach((request) => request.abort()));
          return container;
        };

        setOverlay('districts', createProtectedVectorLayer('local-governments', {
          style: { color: '#7b3fa1', weight: 1.25, opacity: 0.95, fillOpacity: 0 },
          onEachFeature(feature, layer) { const name = feature.properties?.label; if (name) layer.bindTooltip(String(name), { sticky: true, direction: 'top', className: 'district-label' }); },
        }));
        setOverlay('river', createProtectedVectorLayer('river-corridor', {
          style: { color: '#d97706', weight: 1.75, opacity: 1, dashArray: '7 4', fillOpacity: 0 },
        }));
        const buildingOptions: import('leaflet').GeoJSONOptions = {
          pointToLayer(_feature, latlng) {
            const icon = L.divIcon({ className: 'building-marker', html: '<span aria-hidden="true">▰</span>', iconSize: [20, 20], iconAnchor: [10, 10] });
            return L.marker(latlng, { icon, title: 'Possible flood affected' });
          },
          onEachFeature(_feature, layer) { layer.bindTooltip('Possible flood affected'); layer.bindPopup('Possible flood affected'); },
        };
        setOverlay('buildings', createProtectedVectorLayer('buildings', buildingOptions, true));
      }

      if (!protectedTileUrl && ortho.image_url) {
        if (/\.tiff?(?:$|\?)/i.test(ortho.image_url)) {
          const sourceProjection = `+proj=utm +zone=${ortho.epsg - 32600} +datum=WGS84 +units=m +no_defs`;
          const tiffPromise = tiffCache.get(ortho.image_url) ?? loadTiff(ortho.image_url);
          tiffCache.set(ortho.image_url, tiffPromise);
          const tiff = await tiffPromise;
          if (disposed) return;
          const image = await tiff.getImage();
          const [minX, minY, maxX, maxY] = image.getBoundingBox();
          const RasterGrid = L.GridLayer.extend({
            createTile(coords: import('leaflet').Coords, done: (error?: Error | null, tile?: HTMLElement) => void) {
              const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
              const tileMap = (this as unknown as { _map: import('leaflet').Map })._map;
              const nw = tileMap.unproject(L.point(coords.x * 256, coords.y * 256), coords.z);
              const se = tileMap.unproject(L.point((coords.x + 1) * 256, (coords.y + 1) * 256), coords.z);
              const [west, north] = proj4('EPSG:4326', sourceProjection, [nw.lng, nw.lat]);
              const [east, south] = proj4('EPSG:4326', sourceProjection, [se.lng, se.lat]);
              const left = Math.max(minX, west), right = Math.min(maxX, east), bottom = Math.max(minY, south), top = Math.min(maxY, north);
              if (left >= right || bottom >= top) { done(null, canvas); return canvas; }
              const destinationX = Math.round(((left - west) / (east - west)) * 256);
              const destinationY = Math.round(((north - top) / (north - south)) * 256);
              const destinationWidth = Math.max(1, Math.round(((right - left) / (east - west)) * 256));
              const destinationHeight = Math.max(1, Math.round(((top - bottom) / (north - south)) * 256));
              tiff.readRasters({ bbox: [left, bottom, right, top], width: destinationWidth, height: destinationHeight, samples: [0, 1, 2, 3], interleave: true, resampleMethod: 'bilinear' }).then((result) => {
                const values = result as unknown as ArrayLike<number>;
                const rgba = new Uint8ClampedArray(destinationWidth * destinationHeight * 4);
                for (let i = 0; i < rgba.length; i += 4) { rgba[i] = values[i] ?? 0; rgba[i + 1] = values[i + 1] ?? 0; rgba[i + 2] = values[i + 2] ?? 0; rgba[i + 3] = values[i + 3] ?? 255; }
                canvas.getContext('2d')?.putImageData(new ImageData(rgba, destinationWidth, destinationHeight), destinationX, destinationY);
                done(null, canvas);
              }).catch((error: Error) => done(error, canvas));
              return canvas;
            },
          });
          const RasterGridLayer = RasterGrid as unknown as new (options: import('leaflet').GridLayerOptions) => import('leaflet').GridLayer;
          setOverlay('ortho', new RasterGridLayer({ tileSize: 256, opacity: 0.92, bounds, minZoom: 9, maxZoom: 20 }));
        } else setOverlay('ortho', L.imageOverlay(ortho.image_url, bounds, { opacity: 0.9 }));
      }

      const loadKml = async (url: string) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`KML request failed: ${response.status}`);
        return toGeoJSON.kml(new DOMParser().parseFromString(await response.text(), 'text/xml'));
      };

      if (!protectedTileUrl && ortho.districts_kml_url) {
        const districts = await loadKml(ortho.districts_kml_url);
        if (disposed) return;
        const line = L.geoJSON(districts, {
          style: { color: '#7b3fa1', weight: 1.25, opacity: 0.95, fillOpacity: 0 },
          onEachFeature(feature, layer) {
            const properties = feature.properties ?? {};
            const name = properties.GaPa_NaPa || properties.DISTRICT || '';
            if (name) layer.bindTooltip(String(name), { sticky: true, direction: 'top', className: 'district-label' });
          },
        });
        setOverlay('districts', line);
      }

      if (!protectedTileUrl && ortho.river_buffer_kml_url) {
        const riverBuffer = await loadKml(ortho.river_buffer_kml_url);
        if (disposed) return;
        setOverlay('river', L.geoJSON(riverBuffer, {
          style: { color: '#d97706', weight: 1.75, opacity: 1, dashArray: '7 4', fillOpacity: 0 },
        }));
      }

      if (!protectedTileUrl && ortho.buildings_kml_url) {
        const buildings = await loadKml(ortho.buildings_kml_url);
        if (disposed) return;
        const cluster = L.markerClusterGroup({ maxClusterRadius: 42, showCoverageOnHover: false, spiderfyOnMaxZoom: true });
        L.geoJSON(buildings, {
          pointToLayer(feature, latlng) {
            const icon = L.divIcon({ className: 'building-marker', html: '<span aria-hidden="true">▰</span>', iconSize: [20, 20], iconAnchor: [10, 10] });
            return L.marker(latlng, { icon, title: 'Possible flood affected' });
          },
          onEachFeature(_feature, layer) {
            layer.bindTooltip('Possible flood affected');
            layer.bindPopup('Possible flood affected');
          },
        }).eachLayer((layer) => cluster.addLayer(layer));
        setOverlay('buildings', cluster);
      }
      L.control.zoom({ position: 'topleft' }).addTo(map);
    })().catch((error) => console.error('Unable to initialize the map', error));

    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null; leafletRef.current = null; baseLayerRef.current = null; overlaysRef.current = {};
    };
  }, [ortho]);

  return <div ref={element} className="leaflet-map" aria-label={`Interactive map of ${ortho.name}`} />;
}
