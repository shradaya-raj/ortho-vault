import { createClient } from 'jsr:@supabase/supabase-js@2';

const BUCKET = 'Flood-Data-Paid-Version';
const URL_LIFETIME_SECONDS = 600;
const ALLOWED_ORIGINS = new Set([
  'https://shradaya-raj.github.io',
  'http://localhost:5173',
  'http://localhost:3000',
]);

const ASSETS = {
  ortho: 'Rasuwa-Flood-Ortho-COG.tif',
  buildings: 'Flood_afftected_Buildings.kml',
  local_governments: 'GaPaNaPa.kml',
  river_corridor: 'Updated-1km-River-Boundary.kml',
  river_centerline: 'Trishuli-River.kml',
  trisuli_centerline: 'Trishuli-Centerline.kml',
} as const;

type AssetName = keyof typeof ASSETS;

async function recordPortalVisit(
  supabase: ReturnType<typeof createClient>,
  request: Request,
) {
  const userAgent = request.headers.get('user-agent') ?? '';
  const forwardedIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = request.headers.get('cf-connecting-ip') ?? forwardedIp ?? 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const bytes = new TextEncoder().encode(`${day}|${ip}|${userAgent}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const visitorDayHash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const deviceType = /mobile|android|iphone|ipad/i.test(userAgent)
    ? 'mobile'
    : userAgent ? 'desktop' : 'other';

  const { error } = await supabase.from('portal_visit_events').insert({
    visitor_day_hash: visitorDayHash,
    device_type: deviceType,
  });
  if (error) console.error('Unable to record portal visit', error);
}

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin)
    ? origin
    : 'https://shradaya-raj.github.io';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const headers = corsHeaders(origin);

  if (request.method === 'OPTIONS') return new Response('ok', { headers });
  if (request.method !== 'POST' || !origin || !ALLOWED_ORIGINS.has(origin)) {
    return Response.json({ error: 'Request not allowed' }, { status: 403, headers });
  }

  try {
    const { asset } = await request.json() as { asset?: AssetName };
    if (!asset || !(asset in ASSETS)) {
      return Response.json({ error: 'Unknown map asset' }, { status: 400, headers });
    }

    const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    const serverKey = secretKeys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serverKey || !supabaseUrl) throw new Error('Supabase server secrets are unavailable');

    const supabase = createClient(supabaseUrl, serverKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    if (asset === 'ortho') await recordPortalVisit(supabase, request);
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(ASSETS[asset], URL_LIFETIME_SECONDS);
    if (error) throw error;

    return Response.json(
      { url: data.signedUrl, expiresIn: URL_LIFETIME_SECONDS },
      { headers },
    );
  } catch (error) {
    console.error('Unable to sign map asset', error);
    return Response.json({ error: 'Unable to open map asset' }, { status: 500, headers });
  }
});
