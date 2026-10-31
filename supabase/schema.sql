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
  image_path text,
  created_at timestamptz not null default now()
);

alter table public.complaints add column if not exists image_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('civic-complaint-images', 'civic-complaint-images', false, 1572864, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.complaints enable row level security;
revoke all on table public.complaints from anon, authenticated;
grant all on table public.complaints to service_role;

create index if not exists complaints_created_at_idx
  on public.complaints (created_at desc);
