import { createClient } from 'jsr:@supabase/supabase-js@2';

const BUCKET = 'Flood-Data-Paid-Version';
const ALLOWED_ORIGINS = new Set(['https://shradaya-raj.github.io', 'http://localhost:5173']);
const LAYERS: Record<string, { extension: string; contentType: string }> = {
  drone: { extension: 'webp', contentType: 'image/webp' },
  buildings: { extension: 'json', contentType: 'application/geo+json' },
  'local-governments': { extension: 'json', contentType: 'application/geo+json' },
  'river-corridor': { extension: 'json', contentType: 'application/geo+json' },
  'trishuli-river': { extension: 'json', contentType: 'application/geo+json' },
};

function headers(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://shradaya-raj.github.io',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin, Authorization',
    'X-Content-Type-Options': 'nosniff',
  };
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const cors = headers(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET' || !origin || !ALLOWED_ORIGINS.has(origin)) return Response.json({ error: 'Forbidden' }, { status: 403, headers: cors });

  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return Response.json({ error: 'Authentication required' }, { status: 401, headers: cors });

  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const functionIndex = parts.indexOf('map-tile');
  const [layer, zText, xText, yText] = parts.slice(functionIndex + 1);
  const definition = LAYERS[layer];
  const z = Number(zText), x = Number(xText), y = Number(yText);
  if (!definition || !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0 || z > 22 || x < 0 || y < 0) {
    return Response.json({ error: 'Invalid tile' }, { status: 400, headers: cors });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return Response.json({ error: 'Invalid session' }, { status: 401, headers: cors });

  const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const { data: permitted, error: rateError } = await admin.rpc('allow_map_tile_request', {
    p_user_id: authData.user.id,
    p_client_ip: clientIp,
    p_layer: layer,
  });
  if (rateError || !permitted) return Response.json({ error: 'Rate limit exceeded' }, { status: 429, headers: { ...cors, 'Retry-After': '60' } });

  const storagePath = `tiles/${layer}/${z}/${x}/${y}.${definition.extension}`;
  const { data, error } = await admin.storage.from(BUCKET).download(storagePath);
  if (error || !data) return new Response(null, { status: 404, headers: cors });
  return new Response(data, {
    headers: {
      ...cors,
      'Content-Type': definition.contentType,
      'Cache-Control': 'private, max-age=300',
      'Content-Disposition': 'inline',
    },
  });
});
