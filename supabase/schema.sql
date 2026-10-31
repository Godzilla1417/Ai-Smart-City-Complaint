create table if not exists public.complaints (
  id text primary key,
  user_id text not null default 'guest',
  title text not null,
  description text not null,
  category text not null,
  address text not null default '',
  location text not null default '',
  zone text not null default 'Citywide',
  latitude double precision,
  longitude double precision,
  status text not null default 'Submitted',
  department text not null default 'City Services',
  created_at timestamptz not null default now()
);

alter table public.complaints enable row level security;
revoke all on table public.complaints from anon, authenticated;
grant all on table public.complaints to service_role;

create index if not exists complaints_created_at_idx
  on public.complaints (created_at desc);
