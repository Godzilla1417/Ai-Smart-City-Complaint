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
alter table public.complaints add column if not exists before_image_path text;
alter table public.complaints add column if not exists after_image_paths jsonb not null default '[]'::jsonb;
alter table public.complaints add column if not exists resolution_description text;
alter table public.complaints add column if not exists resolution_completed_at timestamptz;
alter table public.complaints add column if not exists resolution_department text;
alter table public.complaints add column if not exists resolution_status text not null default 'Awaiting Resolution Evidence';
alter table public.complaints add column if not exists submitted_by_admin_id text;
alter table public.complaints add column if not exists submitted_at timestamptz;
alter table public.complaints add column if not exists verified_by_admin_id text;
alter table public.complaints add column if not exists verified_at timestamptz;

create table if not exists public.complaint_resolution_audit (
  id bigint generated always as identity primary key,
  complaint_id text not null references public.complaints(id) on delete cascade,
  action text not null check (action in ('evidence_submitted', 'verified', 'returned_for_work')),
  actor_admin_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.complaint_resolution_audit enable row level security;
revoke all on table public.complaint_resolution_audit from anon, authenticated;
grant all on table public.complaint_resolution_audit to service_role;
grant usage, select on sequence public.complaint_resolution_audit_id_seq to service_role;
create index if not exists complaint_resolution_audit_complaint_idx
  on public.complaint_resolution_audit (complaint_id, created_at desc);

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
