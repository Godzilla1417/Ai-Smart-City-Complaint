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
alter table public.complaints add column if not exists priority_level text;
alter table public.complaints add column if not exists ai_priority_level text;
alter table public.complaints add column if not exists priority_reason text;
alter table public.complaints add column if not exists priority_confidence text;
alter table public.complaints add column if not exists priority_department text;
alter table public.complaints add column if not exists priority_response_time text;
alter table public.complaints add column if not exists manually_updated_by text;
alter table public.complaints add column if not exists manually_updated_at timestamptz;
alter table public.complaints add column if not exists citizen_access_token_hash text;

create index if not exists complaints_priority_status_idx
  on public.complaints (priority_level, status, created_at desc);

create table if not exists public.complaint_resolution_audit (
  id bigint generated always as identity primary key,
  complaint_id text not null references public.complaints(id) on delete cascade,
  action text not null check (action in ('evidence_submitted', 'verified', 'returned_for_work')),
  actor_admin_id text,
  actor_type text not null default 'admin' check (actor_type in ('admin', 'citizen', 'system')),
  actor_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.complaint_resolution_audit alter column actor_admin_id drop not null;
alter table public.complaint_resolution_audit add column if not exists actor_type text not null default 'admin';
alter table public.complaint_resolution_audit add column if not exists actor_id text;
alter table public.complaint_resolution_audit drop constraint if exists complaint_resolution_audit_action_check;
alter table public.complaint_resolution_audit add constraint complaint_resolution_audit_action_check
  check (action in ('evidence_submitted', 'verified', 'returned_for_work', 'priority_changed', 'citizen_deletion_requested', 'deletion_reviewed', 'evidence_replaced'));

create table if not exists public.complaint_evidence (
  evidence_id uuid primary key default gen_random_uuid(),
  complaint_id text not null references public.complaints(id) on delete cascade,
  evidence_owner_type text not null check (evidence_owner_type in ('citizen', 'admin')),
  evidence_owner_id text not null,
  evidence_image_path text not null,
  evidence_description text,
  evidence_submitted_at timestamptz not null default now(),
  evidence_status text not null default 'Active' check (evidence_status in ('Active', 'Deletion Requested', 'Replaced', 'Privacy Review')),
  deletion_request_status text not null default 'None' check (deletion_request_status in ('None', 'Pending', 'In Review', 'Retained', 'Escalated for Privacy Review')),
  deletion_requested_at timestamptz,
  replaced_by_evidence_id uuid references public.complaint_evidence(evidence_id),
  created_at timestamptz not null default now(),
  unique (complaint_id, evidence_image_path)
);

insert into public.complaint_evidence (complaint_id, evidence_owner_type, evidence_owner_id, evidence_image_path, evidence_submitted_at)
select c.id, 'citizen', coalesce(c.user_id, 'guest'), c.image_path, c.created_at
from public.complaints c where c.image_path is not null
on conflict (complaint_id, evidence_image_path) do nothing;

insert into public.complaint_evidence (complaint_id, evidence_owner_type, evidence_owner_id, evidence_image_path, evidence_description, evidence_submitted_at)
select c.id, 'admin', coalesce(c.submitted_by_admin_id, 'shared-admin'), path.value,
       c.resolution_description, coalesce(c.submitted_at, c.created_at)
from public.complaints c
cross join lateral jsonb_array_elements_text(coalesce(c.after_image_paths, '[]'::jsonb)) as path(value)
on conflict (complaint_id, evidence_image_path) do nothing;

alter table public.complaint_resolution_audit enable row level security;
alter table public.complaint_evidence enable row level security;
revoke all on table public.complaint_resolution_audit from anon, authenticated;
revoke all on table public.complaint_evidence from anon, authenticated;
grant all on table public.complaint_resolution_audit to service_role;
grant all on table public.complaint_evidence to service_role;
grant usage, select on sequence public.complaint_resolution_audit_id_seq to service_role;
create index if not exists complaint_resolution_audit_complaint_idx
  on public.complaint_resolution_audit (complaint_id, created_at desc);
create index if not exists complaint_evidence_complaint_idx
  on public.complaint_evidence (complaint_id, evidence_submitted_at desc);
create index if not exists complaint_evidence_deletion_requests_idx
  on public.complaint_evidence (deletion_request_status, created_at desc)
  where deletion_request_status in ('Pending', 'In Review', 'Escalated for Privacy Review');

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
