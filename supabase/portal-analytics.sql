-- Run once in Supabase Dashboard > SQL Editor.
-- Only the service role can insert/read these records; portal visitors cannot.

create table if not exists public.portal_visit_events (
  id bigint generated always as identity primary key,
  visited_at timestamptz not null default now(),
  visitor_day_hash text not null,
  device_type text not null check (device_type in ('mobile', 'desktop', 'other'))
);

alter table public.portal_visit_events enable row level security;
revoke all on public.portal_visit_events from anon, authenticated;

create index if not exists portal_visit_events_visited_at_idx
  on public.portal_visit_events (visited_at desc);

create or replace view public.portal_visit_summary
with (security_invoker = true)
as
select
  visited_at::date as visit_date,
  count(*)::bigint as total_visits,
  count(distinct visitor_day_hash)::bigint as approximate_unique_visitors,
  count(*) filter (where device_type = 'mobile')::bigint as mobile_visits,
  count(*) filter (where device_type = 'desktop')::bigint as desktop_visits
from public.portal_visit_events
group by visited_at::date
order by visit_date desc;

revoke all on public.portal_visit_summary from anon, authenticated;

-- Private totals you can run in SQL Editor:
-- select count(*) as all_time_visits from public.portal_visit_events;
-- select * from public.portal_visit_summary;
