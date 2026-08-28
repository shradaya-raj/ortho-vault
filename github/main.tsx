import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Portal from '../app/components/Portal';
import type { Ortho } from '../app/lib/orthos';
import '../app/globals.css';
import '../app/portal.css';

const rasuwaFlood: Ortho = {
  id: '1',
  slug: 'rasuwa-flood-ortho',
  name: 'Rasuwa Flood Impact Data Portal',
  location: 'Rasuwa, Nepal',
  captured_at: '2026-08-24',
  area_hectares: 1677.1,
  resolution_cm: 15.27,
  epsg: 32644,
  status: 'published',
  image_url: null,
  north: 28.26310584597464,
  south: 28.02858569455318,
  east: 85.37858278740433,
  west: 85.18161984474554,
  updated_at: '2026-08-28T12:00:00Z',
};

const SIGNING_ENDPOINT = 'https://tjjoksmzymtvlnbggkgc.supabase.co/functions/v1/map-data-url';

async function getAssetUrl(asset: string, signal: AbortSignal) {
  const response = await fetch(SIGNING_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset }),
    signal,
  });
  if (!response.ok) throw new Error(`Map service returned ${response.status}`);
  const data = await response.json() as { url?: string };
  if (!data.url) throw new Error('Map service did not return a URL');
  return data.url;
}

function SecurePortal() {
  const [securedOrtho, setSecuredOrtho] = useState<Ortho | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      getAssetUrl('ortho', controller.signal),
      getAssetUrl('buildings', controller.signal),
      getAssetUrl('local_governments', controller.signal),
      getAssetUrl('river_corridor', controller.signal),
      getAssetUrl('river_centerline', controller.signal),
    ]).then(([image_url, buildings_kml_url, districts_kml_url, river_buffer_kml_url, river_centerline_kml_url]) => {
      setSecuredOrtho({ ...rasuwaFlood, image_url, buildings_kml_url, districts_kml_url, river_buffer_kml_url, river_centerline_kml_url });
    }).catch((requestError) => {
      if (requestError.name !== 'AbortError') setError(true);
    });
    return () => controller.abort();
  }, []);

  if (error) return <main className="empty-state"><h1>Map data is temporarily unavailable</h1><p>Please refresh the page to try again.</p></main>;
  if (!securedOrtho) return <main className="empty-state"><h1>Opening secure map</h1><p>Preparing protected map layers…</p></main>;
  return <Portal orthos={[securedOrtho]} initialSlug={securedOrtho.slug} publicView />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SecurePortal />
  </React.StrictMode>,
);
