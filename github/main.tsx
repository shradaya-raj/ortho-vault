import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
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

const SUPABASE_URL = 'https://tjjoksmzymtvlnbggkgc.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const TILE_ENDPOINT = `${SUPABASE_URL}/functions/v1/map-tile`;

function SecurePortal() {
  const [securedOrtho, setSecuredOrtho] = useState<Ortho | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    if (!SUPABASE_PUBLISHABLE_KEY) {
      setError(true);
      return;
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    (async () => {
      let { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        const result = await supabase.auth.signInAnonymously();
        if (result.error) throw result.error;
        session = result.data.session;
      }
      if (!session) throw new Error('Unable to create map session');
      if (active) setSecuredOrtho({
        ...rasuwaFlood,
        protected_tile_url: TILE_ENDPOINT,
        protected_access_token: session.access_token,
      });
    })().catch(() => active && setError(true));
    return () => { active = false; };
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
