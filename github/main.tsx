import React from 'react';
import { createRoot } from 'react-dom/client';
import Portal from '../app/components/Portal';
import type { Ortho } from '../app/lib/orthos';
import '../app/globals.css';
import '../app/portal.css';

const rasuwaFlood: Ortho = {
  id: '1',
  slug: 'rasuwa-flood-ortho',
  name: 'Rasuwa Flood Orthomosaic',
  location: 'Rasuwa, Nepal',
  captured_at: '2026-08-24',
  area_hectares: 1677.1,
  resolution_cm: 15.27,
  epsg: 32644,
  status: 'published',
  image_url: 'https://tjjoksmzymtvlnbggkgc.supabase.co/storage/v1/object/public/Flood-Data-Paid-Version/Rasuwa-Flood-Ortho-COG.tif',
  buildings_kml_url: 'https://tjjoksmzymtvlnbggkgc.supabase.co/storage/v1/object/public/Flood-Data-Paid-Version/Flood_afftected_Buildings.kml',
  districts_kml_url: 'https://tjjoksmzymtvlnbggkgc.supabase.co/storage/v1/object/public/Flood-Data-Paid-Version/GaPaNaPa.kml',
  north: 28.26310584597464,
  south: 28.02858569455318,
  east: 85.37858278740433,
  west: 85.18161984474554,
  updated_at: '2026-08-28T12:00:00Z',
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Portal orthos={[rasuwaFlood]} initialSlug={rasuwaFlood.slug} publicView />
  </React.StrictMode>,
);
