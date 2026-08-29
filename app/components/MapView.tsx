'use client';

import { useEffect, useRef } from 'react';
import type { Ortho } from '../lib/orthos';

type BaseMap = 'osm' | 'satellite';
type OverlayKey = 'ortho' | 'buildings' | 'districts' | 'river' | 'riverCenterline' | 'trisuliCenterline';
type OverlayLayers = Partial<Record<OverlayKey, import('leaflet').Layer>>;
const tiffCache = new Map<string, ReturnType<typeof loadTiff>>();

async function loadTiff(url: string) {
  const { fromUrl } = await import('geotiff');
  return fromUrl(url, { cacheSize: 200 });
}

function makeBaseLayer(L: typeof import('leaflet'), basemap: BaseMap) {
  return basemap === 'satellite'
    ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles © Esri — Sources: Esri, Maxar, Earthstar Geographics, and contributors', maxZoom: 20 })
    : L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 20 });
}

export default function MapView({ ortho, basemap, showOrtho, showBuildings, showDistricts, showRiver, showRiverCenterline, showTrisuliCenterline }: { ortho: Ortho; basemap: BaseMap; showOrtho: boolean; showBuildings: boolean; showDistricts: boolean; showRiver: boolean; showRiverCenterline: boolean; showTrisuliCenterline: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const leafletRef = useRef<typeof import('leaflet') | null>(null);
  const baseLayerRef = useRef<import('leaflet').TileLayer | null>(null);
  const overlaysRef = useRef<OverlayLayers>({});
  const currentState = useRef({ basemap, showOrtho, showBuildings, showDistricts, showRiver, showRiverCenterline, showTrisuliCenterline });
  currentState.current = { basemap, showOrtho, showBuildings, showDistricts, showRiver, showRiverCenterline, showTrisuliCenterline };

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
    const desired: Record<OverlayKey, boolean> = { ortho: showOrtho, buildings: showBuildings, districts: showDistricts, river: showRiver, riverCenterline: showRiverCenterline, trisuliCenterline: showTrisuliCenterline };
    (Object.keys(desired) as OverlayKey[]).forEach((key) => {
      const layer = overlaysRef.current[key];
      if (!layer) return;
      if (desired[key] && !map.hasLayer(layer)) layer.addTo(map);
      if (!desired[key] && map.hasLayer(layer)) map.removeLayer(layer);
    });
  }, [showOrtho, showBuildings, showDistricts, showRiver, showRiverCenterline, showTrisuliCenterline]);

  useEffect(() => {
    if (!element.current) return;
    let disposed = false;
    let mapGestureHandler: ((event: WheelEvent) => void) | undefined;
    let lastGestureZoom = 0;

    (async () => {
      const [L, proj4Module, toGeoJSON] = await Promise.all([import('leaflet'), import('proj4'), import('@tmcw/togeojson')]);
      (globalThis as typeof globalThis & { L: typeof L }).L = L;
      await import('leaflet.markercluster');
      if (disposed || !element.current) return;
      leafletRef.current = L;
      const proj4 = proj4Module.default;
      const bounds = L.latLngBounds([ortho.south, ortho.west], [ortho.north, ortho.east]);
      const map = L.map(element.current, { zoomControl: false, preferCanvas: true, fadeAnimation: false }).fitBounds(bounds, { padding: [28, 28], animate: false });
      mapRef.current = map;
      mapGestureHandler = (event: WheelEvent) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        event.stopPropagation();
        const now = performance.now();
        if (now - lastGestureZoom < 140) return;
        lastGestureZoom = now;
        const direction = event.deltaY < 0 ? 1 : -1;
        const nextZoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), map.getZoom() + direction));
        map.setZoomAround(map.mouseEventToContainerPoint(event), nextZoom);
      };
      element.current.addEventListener('wheel', mapGestureHandler, { passive: false, capture: true });
      baseLayerRef.current = makeBaseLayer(L, currentState.current.basemap).addTo(map);

      const setOverlay = (key: OverlayKey, layer: import('leaflet').Layer) => {
        overlaysRef.current[key] = layer;
        const visible = key === 'ortho' ? currentState.current.showOrtho : key === 'buildings' ? currentState.current.showBuildings : key === 'districts' ? currentState.current.showDistricts : key === 'river' ? currentState.current.showRiver : key === 'riverCenterline' ? currentState.current.showRiverCenterline : currentState.current.showTrisuliCenterline;
        if (visible && !disposed) layer.addTo(map);
      };

      if (ortho.image_url) {
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
          const rasterLayer = new RasterGrid({
            tileSize: 256,
            opacity: 0.92,
            bounds,
            minZoom: 9,
            maxZoom: 20,
            updateWhenZooming: false,
            updateWhenIdle: true,
            updateInterval: 250,
            keepBuffer: 4,
          });
          const loadingIndicator = document.createElement('div');
          loadingIndicator.className = 'drone-loading-indicator';
          loadingIndicator.setAttribute('role', 'status');
          loadingIndicator.setAttribute('aria-live', 'polite');
          loadingIndicator.innerHTML = '<span aria-hidden="true"></span>Drone imagery loading…';
          element.current.appendChild(loadingIndicator);
          const showLoadingIndicator = () => loadingIndicator.classList.add('is-visible');
          const hideLoadingIndicator = () => loadingIndicator.classList.remove('is-visible');
          rasterLayer.on('loading', showLoadingIndicator);
          rasterLayer.on('remove', hideLoadingIndicator);
          let rasterPreview: HTMLCanvasElement | null = null;
          let previewFallbackTimer: ReturnType<typeof setTimeout> | undefined;
          const clearRasterPreview = () => {
            if (!rasterPreview) return;
            const preview = rasterPreview;
            rasterPreview = null;
            preview.classList.add('is-ready');
            setTimeout(() => preview.remove(), 260);
          };
          const preserveVisibleRaster = () => {
            if (rasterPreview || !element.current || !currentState.current.showOrtho) return;
            const container = element.current;
            const containerRect = container.getBoundingClientRect();
            const tiles = Array.from(container.querySelectorAll<HTMLCanvasElement>('.leaflet-tile-pane canvas.leaflet-tile'))
              .filter((tile) => {
                const rect = tile.getBoundingClientRect();
                return rect.right > containerRect.left && rect.left < containerRect.right && rect.bottom > containerRect.top && rect.top < containerRect.bottom;
              });
            if (!tiles.length) return;
            const scale = window.devicePixelRatio || 1;
            const preview = document.createElement('canvas');
            preview.width = Math.max(1, Math.round(containerRect.width * scale));
            preview.height = Math.max(1, Math.round(containerRect.height * scale));
            preview.style.width = `${containerRect.width}px`;
            preview.style.height = `${containerRect.height}px`;
            preview.className = 'raster-zoom-preview';
            const context = preview.getContext('2d');
            if (!context) return;
            context.scale(scale, scale);
            tiles.forEach((tile) => {
              const rect = tile.getBoundingClientRect();
              context.drawImage(tile, rect.left - containerRect.left, rect.top - containerRect.top, rect.width, rect.height);
            });
            container.appendChild(preview);
            rasterPreview = preview;
            clearTimeout(previewFallbackTimer);
            previewFallbackTimer = setTimeout(clearRasterPreview, 20000);
          };
          let redrawTimer: ReturnType<typeof setTimeout> | undefined;
          map.on('zoomstart', preserveVisibleRaster);
          map.on('zoomend', () => {
            clearTimeout(redrawTimer);
            redrawTimer = setTimeout(() => {
              if (!disposed && currentState.current.showOrtho) rasterLayer.redraw();
            }, 180);
          });
          rasterLayer.on('load', () => {
            hideLoadingIndicator();
            clearTimeout(previewFallbackTimer);
            clearRasterPreview();
          });
          setOverlay('ortho', rasterLayer);
        } else setOverlay('ortho', L.imageOverlay(ortho.image_url, bounds, { opacity: 0.9 }));
      }

      const loadKml = async (url: string) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`KML request failed: ${response.status}`);
        return toGeoJSON.kml(new DOMParser().parseFromString(await response.text(), 'text/xml'));
      };

      if (ortho.districts_kml_url) {
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

      if (ortho.river_buffer_kml_url) {
        const riverBuffer = await loadKml(ortho.river_buffer_kml_url);
        if (disposed) return;
        setOverlay('river', L.geoJSON(riverBuffer, {
          style: { color: '#d97706', weight: 1.75, opacity: 1, dashArray: '7 4', fillOpacity: 0 },
        }));
      }

      if (ortho.river_centerline_kml_url) {
        const riverCenterline = await loadKml(ortho.river_centerline_kml_url);
        if (disposed) return;
        setOverlay('riverCenterline', L.geoJSON(riverCenterline, {
          style: { color: '#1479b8', weight: 2.25, opacity: 0.98, lineCap: 'round', lineJoin: 'round', fillOpacity: 0 },
          onEachFeature(_feature, layer) {
            layer.bindTooltip('Trishuli River', { sticky: true, direction: 'top', className: 'river-label' });
          },
        }));
      }

      if (ortho.trisuli_centerline_kml_url) {
        const trisuliCenterline = await loadKml(ortho.trisuli_centerline_kml_url);
        if (disposed) return;
        const centerlineGroup = L.layerGroup();
        L.geoJSON(trisuliCenterline, {
          style: { color: '#ffffff', weight: 5, opacity: 0.92, lineCap: 'round', lineJoin: 'round', fillOpacity: 0 },
          interactive: false,
        }).addTo(centerlineGroup);
        L.geoJSON(trisuliCenterline, {
          style: { color: '#0b2f6b', weight: 2.4, opacity: 1, lineCap: 'round', lineJoin: 'round', fillOpacity: 0 },
          onEachFeature(_feature, layer) {
            layer.bindTooltip('Trishuli River Centerline', { sticky: true, direction: 'top', className: 'river-label' });
          },
        }).addTo(centerlineGroup);
        setOverlay('trisuliCenterline', centerlineGroup);
      }

      if (ortho.buildings_kml_url) {
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
      if (mapGestureHandler && element.current) element.current.removeEventListener('wheel', mapGestureHandler, { capture: true });
      mapRef.current?.remove();
      mapRef.current = null; leafletRef.current = null; baseLayerRef.current = null; overlaysRef.current = {};
    };
  }, [ortho]);

  return <div ref={element} className="leaflet-map" aria-label={`Interactive map of ${ortho.name}`} />;
}
