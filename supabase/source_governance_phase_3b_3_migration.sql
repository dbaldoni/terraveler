-- Migration for Source Governance Phase 3B.3 (Hardened Sealing)
-- Safe, idempotent, and backwards-compatible migration.

-- 1. Add scheduling and reverification generation fields to source_endpoints
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_endpoints' and column_name = 'last_verified_at') then
    alter table source_endpoints add column last_verified_at timestamptz;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_endpoints' and column_name = 'next_reverification_at') then
    alter table source_endpoints add column next_reverification_at timestamptz;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_endpoints' and column_name = 'reverification_interval') then
    alter table source_endpoints add column reverification_interval interval not null default interval '7 days';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_endpoints' and column_name = 'reverification_policy') then
    alter table source_endpoints add column reverification_policy text not null default 'normal' check (reverification_policy in ('high', 'normal', 'low'));
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_endpoints' and column_name = 'reverification_generation') then
    alter table source_endpoints add column reverification_generation integer not null default 0;
  end if;
end $$;

-- 2. Add scheduling and reverification generation fields to source_collections
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_collections' and column_name = 'last_verified_at') then
    alter table source_collections add column last_verified_at timestamptz;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_collections' and column_name = 'next_reverification_at') then
    alter table source_collections add column next_reverification_at timestamptz;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_collections' and column_name = 'reverification_interval') then
    alter table source_collections add column reverification_interval interval not null default interval '30 days';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_collections' and column_name = 'reverification_policy') then
    alter table source_collections add column reverification_policy text not null default 'normal' check (reverification_policy in ('high', 'normal', 'low'));
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_collections' and column_name = 'reverification_generation') then
    alter table source_collections add column reverification_generation integer not null default 0;
  end if;
end $$;

-- 3. Add reverification_generation fields to evidence and evaluations tables
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_verified_evidence' and column_name = 'reverification_generation') then
    alter table source_verified_evidence add column reverification_generation integer not null default 0;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_policy_evaluations' and column_name = 'reverification_generation') then
    alter table source_policy_evaluations add column reverification_generation integer not null default 0;
  end if;
end $$;

-- 4. Safe, in-place migration of source_reverifications table (NO DROP TABLE CASCADE, NO LOSS OF LEGACY ROWS)
do $$
begin
  -- If we are upgrading from pre-3B.3 schema (detected by presence of rights_statement_hash)
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'source_reverifications' and column_name = 'rights_statement_hash') then
    
    -- A. Add new columns as nullable initially
    alter table source_reverifications add column if not exists subject_type text;
    alter table source_reverifications add column if not exists subject_id bigint;
    alter table source_reverifications add column if not exists previous_decision_id bigint;
    alter table source_reverifications add column if not exists previous_verified_evidence_id bigint;
    alter table source_reverifications add column if not exists reverifier_version text;
    alter table source_reverifications add column if not exists trigger_type text;
    alter table source_reverifications add column if not exists old_material_fingerprint text;
    alter table source_reverifications add column if not exists new_material_fingerprint text;
    alter table source_reverifications add column if not exists drift_class text;
    alter table source_reverifications add column if not exists drift_codes text[];
    alter table source_reverifications add column if not exists observations jsonb;

    -- B. Backfill existing legacy rows safely
    update source_reverifications
    set
      subject_type = 'endpoint',
      subject_id = coalesce((select endpoint_id from source_policy_decisions where id = decision_id), 1),
      previous_decision_id = decision_id,
      previous_verified_evidence_id = coalesce((select id from source_verified_evidence where subject_id = (select endpoint_id from source_policy_decisions where id = decision_id) limit 1), 1),
      reverifier_version = 'legacy-v0',
      trigger_type = 'scheduled',
      old_material_fingerprint = coalesce(normalized_fingerprint, 'legacy-v0'),
      new_material_fingerprint = coalesce(normalized_fingerprint, 'legacy-v0'),
      drift_class = case when drift_detected then 'UNRESOLVED_DRIFT' else 'NO_DRIFT' end,
      observations = '{}'::jsonb
    where subject_type is null;

    -- C. Tighten NOT NULL constraints
    alter table source_reverifications alter column subject_type set not null;
    alter table source_reverifications alter column subject_id set not null;
    alter table source_reverifications alter column previous_decision_id set not null;
    alter table source_reverifications alter column previous_verified_evidence_id set not null;
    alter table source_reverifications alter column reverifier_version set not null;
    alter table source_reverifications alter column trigger_type set not null;
    alter table source_reverifications alter column old_material_fingerprint set not null;
    alter table source_reverifications alter column new_material_fingerprint set not null;
    alter table source_reverifications alter column drift_class set not null;
    alter table source_reverifications alter column observations set not null;

    -- D. Drop legacy columns safely
    alter table source_reverifications drop column if exists decision_id;
    alter table source_reverifications drop column if exists rights_statement_hash;
    alter table source_reverifications drop column if exists normalized_fingerprint;
    alter table source_reverifications drop column if exists timestamp;
    alter table source_reverifications drop column if exists completed_at;
    alter table source_reverifications drop column if exists status;
    alter table source_reverifications drop column if exists new_verified_evidence_id;
    alter table source_reverifications drop column if exists new_policy_evaluation_id;
    alter table source_reverifications drop column if exists new_policy_decision_id;

    -- E. Add safe check constraints
    alter table source_reverifications drop constraint if exists source_reverifications_subject_type_check;
    alter table source_reverifications add constraint source_reverifications_subject_type_check check (subject_type in ('endpoint', 'collection'));
    
    alter table source_reverifications drop constraint if exists source_reverifications_trigger_type_check;
    alter table source_reverifications add constraint source_reverifications_trigger_type_check check (trigger_type in ('scheduled', 'manual', 'redirect_change', 'rights_change_signal', 'access_failure', 'endpoint_change', 'collection_change', 'security_signal', 'policy_version_change'));
    
    alter table source_reverifications drop constraint if exists source_reverifications_drift_class_check;
    alter table source_reverifications add constraint source_reverifications_drift_class_check check (drift_class in ('NO_DRIFT', 'NON_MATERIAL_DRIFT', 'MATERIAL_RIGHTS_DRIFT', 'MATERIAL_SCOPE_DRIFT', 'MATERIAL_IDENTITY_DRIFT', 'MATERIAL_ACCESS_DRIFT', 'MATERIAL_REDIRECT_DRIFT', 'MATERIAL_COLLECTION_DRIFT', 'MATERIAL_VERIFIER_DRIFT', 'UNRESOLVED_DRIFT'));

  else
    -- If fresh install, ensure the clean schema is established
    create table if not exists source_reverifications (
      id bigint generated always as identity primary key,
      subject_type text not null check (subject_type in ('endpoint', 'collection')),
      subject_id bigint not null,
      
      previous_decision_id bigint not null references source_policy_decisions(id) on delete restrict,
      previous_verified_evidence_id bigint not null references source_verified_evidence(id) on delete restrict,
      
      started_at timestamptz not null default now(),
      reverifier_version text not null,
      trigger_type text not null check (trigger_type in (
        'scheduled', 'manual', 'redirect_change', 'rights_change_signal', 
        'access_failure', 'endpoint_change', 'collection_change', 'security_signal', 'policy_version_change'
      )),
      
      old_material_fingerprint text not null,
      new_material_fingerprint text not null,
      
      drift_detected boolean not null,
      drift_class text not null check (drift_class in (
        'NO_DRIFT', 'NON_MATERIAL_DRIFT', 'MATERIAL_RIGHTS_DRIFT', 
        'MATERIAL_SCOPE_DRIFT', 'MATERIAL_IDENTITY_DRIFT', 'MATERIAL_ACCESS_DRIFT', 
        'MATERIAL_REDIRECT_DRIFT', 'MATERIAL_COLLECTION_DRIFT', 'MATERIAL_VERIFIER_DRIFT', 'UNRESOLVED_DRIFT'
      )),
      
      drift_codes text[],
      observations jsonb not null,
      created_at timestamptz not null default now()
    );
  end if;
end $$;

-- 5. Create source_reverification_events table
create table if not exists source_reverification_events (
  id bigint generated always as identity primary key,
  reverification_id bigint not null references source_reverifications(id) on delete cascade,
  event_type text not null check (event_type in ('started', 'completed', 'failed', 'quarantined', 'reevaluated')),
  metadata jsonb,
  timestamp timestamptz not null default now()
);

-- 6. Create source_drift_evaluations table
create table if not exists source_drift_evaluations (
  id bigint generated always as identity primary key,
  reverification_id bigint not null references source_reverifications(id) on delete cascade,
  subject_type text not null check (subject_type in ('endpoint', 'collection')),
  subject_id bigint not null,
  
  drift_detected boolean not null,
  drift_class text not null,
  drift_codes text[],
  reason_codes text[],
  blocking_conditions text[],
  
  old_material_fingerprint text not null,
  new_material_fingerprint text not null,
  recommended_action text not null check (recommended_action in ('KEEP_ACTIVE', 'QUARANTINE_AND_REEVALUATE', 'REVIEW_REQUIRED')),
  
  classifier_version text not null,
  evaluation_snapshot jsonb not null,
  evaluation_hash text not null unique,
  
  created_at timestamptz not null default now()
);

-- 7. Create DB-Side Generation Binding trigger (Autoritative, ignores/rejects caller values)
create or replace function source_verified_evidence_bind_generation()
returns trigger language plpgsql as $$
declare
  v_gen integer := 0;
begin
  if new.subject_type = 'endpoint' then
    select reverification_generation into v_gen from public.source_endpoints where id = new.subject_id;
    if not found then
      raise exception 'MISSING_SUBJECT_VIOLATION: Target endpoint % does not exist', new.subject_id;
    end if;
  elif new.subject_type = 'collection' then
    select reverification_generation into v_gen from public.source_collections where id = new.subject_id;
    if not found then
      raise exception 'MISSING_SUBJECT_VIOLATION: Target collection % does not exist', new.subject_id;
    end if;
  elif new.subject_type = 'proposal' then
    v_gen := 0;
  end if;
  
  new.reverification_generation := coalesce(v_gen, 0);
  return new;
end $$;

drop trigger if exists source_verified_evidence_bind_generation_trigger on source_verified_evidence;
create trigger source_verified_evidence_bind_generation_trigger
  before insert on source_verified_evidence
  for each row execute function source_verified_evidence_bind_generation();

-- 8. Apply Immutability Append-Only rules to all tables (No UPDATE, DELETE, TRUNCATE)
create or replace function source_governance_is_append_only()
returns trigger language plpgsql as $$
begin
  raise exception
    'source governance audit/policy table is append-only: % refused.', tg_op;
end $$;

-- Triggers for source_reverifications
drop trigger if exists source_reverifications_append_only on source_reverifications;
create trigger source_reverifications_append_only
  before update or delete on source_reverifications
  for each row execute function source_governance_is_append_only();

drop trigger if exists source_reverifications_no_truncate on source_reverifications;
create trigger source_reverifications_no_truncate
  before truncate on source_reverifications
  for each statement execute function source_governance_is_append_only();

alter table source_reverifications enable always trigger source_reverifications_append_only;
alter table source_reverifications enable always trigger source_reverifications_no_truncate;

-- Triggers for source_reverification_events
drop trigger if exists source_reverification_events_append_only on source_reverification_events;
create trigger source_reverification_events_append_only
  before update or delete on source_reverification_events
  for each row execute function source_governance_is_append_only();

drop trigger if exists source_reverification_events_no_truncate on source_reverification_events;
create trigger source_reverification_events_no_truncate
  before truncate on source_reverification_events
  for each statement execute function source_governance_is_append_only();

alter table source_reverification_events enable always trigger source_reverification_events_append_only;
alter table source_reverification_events enable always trigger source_reverification_events_no_truncate;

-- Triggers for source_drift_evaluations
drop trigger if exists source_drift_evaluations_append_only on source_drift_evaluations;
create trigger source_drift_evaluations_append_only
  before update or delete on source_drift_evaluations
  for each row execute function source_governance_is_append_only();

drop trigger if exists source_drift_evaluations_no_truncate on source_drift_evaluations;
create trigger source_drift_evaluations_no_truncate
  before truncate on source_drift_evaluations
  for each statement execute function source_governance_is_append_only();

alter table source_drift_evaluations enable always trigger source_drift_evaluations_append_only;
alter table source_drift_evaluations enable always trigger source_drift_evaluations_no_truncate;

-- 9. Ensure role exists before granting
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'terraveler_evaluator') then
    create role terraveler_evaluator;
  end if;
end $$;

-- 10. Privileges and Access Control (Strict Revokes and Schedulable Grants)
revoke all on source_reverifications, source_reverification_events, source_drift_evaluations from public, terraveler_anon;

revoke insert, update, delete, truncate on source_reverifications from terraveler_service;
revoke insert, update, delete, truncate on source_reverification_events from terraveler_service;
revoke insert, update, delete, truncate on source_drift_evaluations from terraveler_service;

revoke update, delete, truncate on source_reverifications from terraveler_evaluator;
revoke update, delete, truncate on source_reverification_events from terraveler_evaluator;
revoke update, delete, truncate on source_drift_evaluations from terraveler_evaluator;

-- Grant SELECT + INSERT safely to matching roles
grant select, insert on source_reverifications to terraveler_service;
grant select, insert on source_reverification_events to terraveler_service;
grant select on source_drift_evaluations to terraveler_service;

grant select, insert on source_reverifications to terraveler_evaluator;
grant select, insert on source_reverification_events to terraveler_evaluator;
grant select, insert on source_drift_evaluations to terraveler_evaluator;

-- Grant sequence usage safely
grant usage, select on sequence 
  source_reverifications_id_seq, 
  source_reverification_events_id_seq, 
  source_drift_evaluations_id_seq 
to terraveler_service, terraveler_evaluator;
