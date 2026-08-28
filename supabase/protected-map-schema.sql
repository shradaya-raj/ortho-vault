create table if not exists public.map_tile_access_log (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  client_ip text not null,
  layer text not null,
  requested_at timestamptz not null default now()
);

alter table public.map_tile_access_log enable row level security;
revoke all on public.map_tile_access_log from anon, authenticated;

create index if not exists map_tile_access_recent_idx
  on public.map_tile_access_log (user_id, requested_at desc);

create or replace function public.allow_map_tile_request(
  p_user_id uuid,
  p_client_ip text,
  p_layer text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_requests integer;
begin
  delete from public.map_tile_access_log where requested_at < now() - interval '7 days';
  select count(*) into recent_requests
  from public.map_tile_access_log
  where user_id = p_user_id and requested_at > now() - interval '1 minute';
  if recent_requests >= 240 then return false; end if;
  insert into public.map_tile_access_log(user_id, client_ip, layer)
  values (p_user_id, p_client_ip, p_layer);
  return true;
end;
$$;

revoke all on function public.allow_map_tile_request(uuid, text, text) from public, anon, authenticated;
grant execute on function public.allow_map_tile_request(uuid, text, text) to service_role;
