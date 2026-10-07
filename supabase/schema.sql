-- Invader Hunt database setup.
-- Paste this whole file into Supabase › SQL Editor › New query, and press Run.
-- Running it again is safe: it only creates what is missing.
--
-- Security model, on purpose very light:
--  * Players log in with just a name. Anyone can create a player and save finds.
--  * Only admins can add invaders and upload reference photos. In the app you
--    log in with the name "admin" and a password; behind the scenes that signs
--    in to the Supabase user admin@invader-hunt.local, which is listed in the
--    admins table below. Create that user under Authentication › Users.

-- ---------- tables ----------

create table if not exists public.invaders (
  id         text primary key,                 -- e.g. MUC_01
  name       text not null,
  city       text not null,
  lat        double precision not null,
  lng        double precision not null,
  points     integer not null default 10,
  created_at timestamptz not null default now()
);

-- Reference photos. Either a file in the "refs" storage bucket (storage_path)
-- or an image that ships with the app (url, relative to the site).
create table if not exists public.refs (
  id           bigint generated always as identity primary key,
  invader_id   text not null references public.invaders(id) on delete cascade,
  storage_path text,
  url          text,
  created_at   timestamptz not null default now(),
  check (storage_path is not null or url is not null)
);

create table if not exists public.players (
  id           text primary key,               -- lower-case name, used to log in
  display_name text not null check (char_length(display_name) between 2 and 20),
  created_at   timestamptz not null default now()
);

create table if not exists public.finds (
  player_id  text not null references public.players(id) on delete cascade,
  invader_id text not null references public.invaders(id) on delete cascade,
  found_at   timestamptz not null default now(),
  score      real,
  lat        double precision,
  lng        double precision,
  simulated  boolean not null default false,   -- found with a pretend location
  thumb      text,                             -- small JPEG as a data URL
  primary key (player_id, invader_id)
);

create table if not exists public.admins (
  email text primary key
);

-- Leaderboard: test finds made with a pretend location do not count.
create or replace view public.leaderboard
with (security_invoker = true) as
select p.id, p.display_name,
       count(i.id)::int                as found,
       coalesce(sum(i.points), 0)::int as points,
       max(f.found_at)                 as last_find
from public.players p
left join public.finds f on f.player_id = p.id and not f.simulated
left join public.invaders i on i.id = f.invader_id
group by p.id, p.display_name;

-- ---------- access rules ----------

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where email = auth.jwt() ->> 'email');
$$;

alter table public.invaders enable row level security;
alter table public.refs     enable row level security;
alter table public.players  enable row level security;
alter table public.finds    enable row level security;
alter table public.admins   enable row level security;

drop policy if exists "read invaders"   on public.invaders;
drop policy if exists "admins edit invaders" on public.invaders;
create policy "read invaders" on public.invaders for select using (true);
create policy "admins edit invaders" on public.invaders for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read refs"   on public.refs;
drop policy if exists "admins edit refs" on public.refs;
create policy "read refs" on public.refs for select using (true);
create policy "admins edit refs" on public.refs for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read players"   on public.players;
drop policy if exists "anyone joins"   on public.players;
create policy "read players" on public.players for select using (true);
create policy "anyone joins" on public.players for insert with check (true);

drop policy if exists "read finds"   on public.finds;
drop policy if exists "anyone saves finds" on public.finds;
drop policy if exists "anyone updates finds" on public.finds;
drop policy if exists "anyone deletes finds" on public.finds;
create policy "read finds" on public.finds for select using (true);
create policy "anyone saves finds" on public.finds for insert with check (true);
create policy "anyone updates finds" on public.finds for update using (true) with check (true);
create policy "anyone deletes finds" on public.finds for delete using (true);

drop policy if exists "admins see admins" on public.admins;
create policy "admins see admins" on public.admins for select using (public.is_admin());

grant select on public.leaderboard to anon, authenticated;

-- ---------- photo storage ----------

insert into storage.buckets (id, name, public)
values ('refs', 'refs', true)
on conflict (id) do nothing;

drop policy if exists "read ref photos" on storage.objects;
drop policy if exists "admins upload ref photos" on storage.objects;
drop policy if exists "admins delete ref photos" on storage.objects;
create policy "read ref photos" on storage.objects for select
  using (bucket_id = 'refs');
create policy "admins upload ref photos" on storage.objects for insert
  with check (bucket_id = 'refs' and public.is_admin());
create policy "admins delete ref photos" on storage.objects for delete
  using (bucket_id = 'refs' and public.is_admin());

-- ---------- starting data: the five placeholder invaders ----------

insert into public.invaders (id, name, city, lat, lng, points) values
  ('MUC_01', 'MUC_01', 'Munich', 48.137400, 11.575500, 10),
  ('MUC_02', 'MUC_02', 'Munich', 48.139100, 11.580200, 20),
  ('ZH_01',  'ZH_01',  'Zürich', 47.376900,  8.541700, 30),
  ('ZH_02',  'ZH_02',  'Zürich', 47.371800,  8.538900, 40),
  ('BRL_01', 'BRL_01', 'Berlin', 52.520000, 13.405000, 50)
on conflict (id) do nothing;

insert into public.refs (invader_id, url)
select v.invader_id, v.url from (values
  ('MUC_01', 'refs/inv-01.svg'),
  ('MUC_02', 'refs/inv-02.svg'),
  ('ZH_01',  'refs/inv-03.svg'),
  ('ZH_02',  'refs/inv-04.svg'),
  ('BRL_01', 'refs/inv-05.svg')
) as v(invader_id, url)
where not exists (select 1 from public.refs r where r.invader_id = v.invader_id and r.url = v.url);

-- ---------- the in-app "admin" login ----------
-- Matches adminEmail in config.js. The address never receives mail.
insert into public.admins (email) values ('admin@invader-hunt.local')
on conflict (email) do nothing;
