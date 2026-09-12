-- Phase 2A/2B/3A: Source Governance Architectural Schema (Revised)
-- This establishes the footprint for domain discovery, evidence collection,
-- immutable policy decisions, and reverification tracking.

create table if not exists source_institutions (
  id bigint generated always as identity primary key,
  slug text unique not null,
  name text not null,
  country text,
  primary_languages text[]
);

create table if not exists source_endpoints (
  id bigint generated always as identity primary key,
  institution_id bigint references source_institutions(id) on delete set null,
  host_pattern text unique not null,
  match_type text not null check (match_type in ('exact', 'suffix')),
  
  -- Lifecycle Status tracks the operational state of the endpoint
  status text not null default 'discovered'
    check (status in ('discovered', 'proposed', 'triaging', 'assessing', 'policy_check', 'active', 'needs_human_review', 'quarantined', 'rejected', 'retired')),
  
  -- Trust Mode dictates how ingestion fetching interacts with this endpoint (decoupled from status, nullable)
  trust_mode text check (trust_mode in ('domain_trusted', 'collection_trusted', 'item_verified', 'link_only')),

  -- Phase 3B.3 Scheduling Metadata
  last_verified_at timestamptz,
  next_reverification_at timestamptz,
  reverification_interval interval not null default interval '7 days',
  reverification_policy text not null default 'normal' check (reverification_policy in ('high', 'normal', 'low'))
);

create table if not exists source_collections (
  id bigint generated always as identity primary key,
  endpoint_id bigint not null references source_endpoints(id) on delete cascade,
  name text not null,
  path_prefix text,
  status text not null default 'discovered'
    check (status in ('discovered', 'proposed', 'triaging', 'assessing', 'policy_check', 'active', 'needs_human_review', 'quarantined', 'rejected', 'retired')),
  trust_mode text check (trust_mode in ('domain_trusted', 'collection_trusted', 'item_verified', 'link_only')),

  -- Phase 3B.3 Scheduling Metadata
  last_verified_at timestamptz,
  next_reverification_at timestamptz,
  reverification_interval interval not null default interval '30 days',
  reverification_policy text not null default 'normal' check (reverification_policy in ('high', 'normal', 'low'))
);

create table if not exists source_access_rules (
  id bigint generated always as identity primary key,
  -- Scope: must attach to exactly an endpoint OR a collection
  endpoint_id bigint references source_endpoints(id) on delete cascade,
  collection_id bigint references source_collections(id) on delete cascade,
  
  allowed_hosts text[],
  path_patterns text[],
  collection_identifiers text[],
  api_endpoints text[],
  verification_strategy text not null default 'none',
  expected_redirect_hosts text[],

  check (
    (endpoint_id is not null and collection_id is null) or
    (endpoint_id is null and collection_id is not null)
  )
);

create table if not exists source_proposals (
  id bigint generated always as identity primary key,
  target_url text not null,
  -- System proposals removed; only humans and Scribe agents propose sources.
  proposed_by_actor_type text not null check (proposed_by_actor_type in ('human', 'agent')),
  proposed_by_actor_id bigint not null, -- references contributors.id or agent_accounts.id polymorphically
  endpoint_id bigint references source_endpoints(id) on delete set null,
  collection_id bigint references source_collections(id) on delete set null,
  status text not null default 'submitted'
);

-- Phase 3A: Source Proposal Intents (Preserves distinct user citation intents, context, and research needs)
create table if not exists source_proposal_intents (
  id bigint generated always as identity primary key,
  proposal_id bigint not null references source_proposals(id) on delete cascade,
  proposed_by_actor_type text not null check (proposed_by_actor_type in ('human', 'agent')),
  proposed_by_actor_id bigint not null, -- references contributors.id or agent_accounts.id polymorphically
  voyage text,
  waypoint bigint,
  region text,
  person text,
  reason text,
  original_target_url text not null,
  timestamp timestamptz default now()
);

-- The Evidence Contract (Authored by LLM Archivist, Verified by Deterministic Engine)
create table if not exists source_assessments (
  id bigint generated always as identity primary key,
  proposal_id bigint not null references source_proposals(id) on delete cascade,
  assessed_by_agent_id bigint not null, -- references agent_accounts.id
  
  -- unresolved scope added as a valid assessment scope (Assessment state only, decisions require endpoint/collection)
  rights_scope_type text not null check (rights_scope_type in ('endpoint', 'collection', 'item', 'unresolved')),
  rights_scope_identifier text,
  
  rights_class text not null check (rights_class in ('public_domain', 'creative_commons', 'mixed', 'in_copyright', 'unknown')),
  rights_identifier text,
  rights_uri text,
  
  machine_readable_rights boolean not null default false,
  rights_statement_url text,
  rights_statement_hash text not null,
  
  created_at timestamptz default now()
);

-- Immutable Decision Record (The actual security authority boundary)
-- Note: Uses ON DELETE RESTRICT to ensure decision provenance survives and prevents cascading deletion of active policy.
create table if not exists source_policy_decisions (
  id bigint generated always as identity primary key,
  endpoint_id bigint references source_endpoints(id) on delete restrict,
  collection_id bigint references source_collections(id) on delete restrict,
  proposal_id bigint references source_proposals(id) on delete restrict,
  
  decision_outcome text not null check (decision_outcome in ('approve', 'reject', 'needs_human_review')),
  trust_mode text check (trust_mode in ('domain_trusted', 'collection_trusted', 'item_verified', 'link_only')),
  rights_class text not null check (rights_class in ('public_domain', 'creative_commons', 'mixed', 'in_copyright', 'unknown')),
  rights_identifier text,
  rights_uri text,
  
  -- Captures the EXACT verified state of the assessment to survive future parent removal/quarantine
  evidence_snapshot jsonb not null,
  
  policy_version text not null,
  verification_version text not null,
  supersedes_decision_id bigint references source_policy_decisions(id) on delete restrict,
  
  carta_version text not null,
  decided_by_actor_type text not null check (decided_by_actor_type in ('human', 'system')),
  decided_by_actor_id bigint, -- references contributors.id or null when decided_by_actor_type is 'system'
  
  reason text not null,
  timestamp timestamptz default now(),

  check (
    (endpoint_id is not null and collection_id is null and proposal_id is null) or
    (endpoint_id is null and collection_id is not null and proposal_id is null) or
    (endpoint_id is null and collection_id is null and proposal_id is not null)
  ),

  check (
    (decided_by_actor_type = 'system' and decided_by_actor_id is null) or
    (decided_by_actor_type = 'human' and decided_by_actor_id is not null)
  ),

  check (
    (decision_outcome = 'approve' and trust_mode is not null) or
    (decision_outcome != 'approve' and trust_mode is null)
  )
);

-- Persisted Verified Evidence Record (Scaffolding for Phase 3B.2)
create table if not exists source_verified_evidence (
  id bigint generated always as identity primary key,
  assessment_id bigint not null references source_assessments(id) on delete cascade,
  proposal_id bigint references source_proposals(id) on delete set null,
  
  subject_type text not null check (subject_type in ('endpoint', 'collection', 'proposal')),
  subject_id bigint not null,
  
  verified_at timestamptz not null default now(),
  verifier_version text not null,
  reverification_generation integer not null default 0, -- Explicit Staleness Generation
  
  institution_identity_verified boolean not null,
  endpoint_identity_verified boolean not null,
  
  rights_statement_retrieved boolean not null,
  rights_statement_hash_matches boolean not null,
  rights_verified boolean not null,
  rights_class text not null check (rights_class in ('public_domain', 'creative_commons', 'mixed', 'in_copyright', 'unknown')),
  rights_identifier text,
  rights_uri text,
  
  scope_verified boolean not null,
  scope_type text not null check (scope_type in ('endpoint', 'collection', 'item', 'unresolved')),
  scope_identifier text,
  
  access_verified boolean not null,
  verification_strategy text not null,
  
  canonical_host text,
  collection_identifier text,
  
  policy_incompatible boolean not null default false,
  incompatibility_codes text[],
  
  conflicts text[],
  evidence_sources text[],
  
  evidence_snapshot jsonb not null,
  evidence_hash text not null,
  
  created_at timestamptz not null default now()
);

-- Persisted Deterministic Policy Evaluations
create table if not exists source_policy_evaluations (
  id bigint generated always as identity primary key,
  verified_evidence_id bigint not null references source_verified_evidence(id) on delete cascade,
  subject_type text not null check (subject_type in ('endpoint', 'collection', 'proposal')),
  subject_id bigint not null,
  reverification_generation integer not null default 0, -- Explicit Staleness Generation
  
  decision_outcome text not null check (decision_outcome in ('approve', 'reject', 'needs_human_review')),
  trust_mode text check (trust_mode in ('domain_trusted', 'collection_trusted', 'item_verified', 'link_only')),
  rule_id text not null,
  reason_codes text[],
  blocking_conditions text[],
  
  policy_version text not null,
  verification_version text not null,
  
  evidence_hash text not null,
  evaluation_snapshot jsonb not null,
  evaluation_hash text not null unique,
  
  created_at timestamptz not null default now(),
  
  check (
    (decision_outcome = 'approve' and trust_mode is not null) or
    (decision_outcome != 'approve' and trust_mode is null)
  )
);

create table if not exists source_reverifications (
  id bigint generated always as identity primary key,
  subject_type text not null check (subject_type in ('endpoint', 'collection')),
  subject_id bigint not null,
  
  previous_decision_id bigint not null references source_policy_decisions(id) on delete restrict,
  previous_verified_evidence_id bigint not null references source_verified_evidence(id) on delete restrict,
  
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  
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
  
  new_verified_evidence_id bigint references source_verified_evidence(id) on delete restrict,
  new_policy_evaluation_id bigint references source_policy_evaluations(id) on delete restrict,
  new_policy_decision_id bigint references source_policy_decisions(id) on delete restrict,
  
  status text not null check (status in ('pending', 'completed', 'failed')),
  created_at timestamptz not null default now()
);

-- Phase 3B.3: Reverification Events (Append-only operational progress)
create table if not exists source_reverification_events (
  id bigint generated always as identity primary key,
  reverification_id bigint not null references source_reverifications(id) on delete cascade,
  event_type text not null check (event_type in ('started', 'completed', 'failed', 'quarantined', 'reevaluated')),
  metadata jsonb,
  timestamp timestamptz not null default now()
);

-- Phase 3B.3: Immutable Drift Evaluations
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

-- Phase 2B: Shadow Mode Comparison Audit Table
create table if not exists source_governance_comparisons (
  id bigint generated always as identity primary key,
  timestamp timestamptz not null default now(),
  canonical_url text not null,
  legacy_outcome jsonb not null,
  registry_outcome jsonb not null,
  equivalent boolean not null,
  difference_class text check (difference_class in (
    'HOST_MATCH_MISMATCH',
    'TRUST_MODE_MISMATCH',
    'VERIFIER_MISMATCH',
    'ALLOW_DENY_MISMATCH',
    'LICENCE_CLASS_MISMATCH'
  ))
);

-- DB-Side Generation Binding trigger (Autoritative, ignores/rejects caller values)
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

-- ----------------------------------------------------------------------------
-- Public views for secure REST exposure (replaces direct table access for anon)
-- ----------------------------------------------------------------------------

create or replace view public_source_endpoints as
  select id, host_pattern, match_type, status, trust_mode
  from source_endpoints;

create or replace view public_source_policy_decisions as
  select id, endpoint_id, collection_id, proposal_id, decision_outcome, trust_mode, rights_class, rights_identifier, rights_uri, policy_version, verification_version, supersedes_decision_id, carta_version, reason, timestamp
  from source_policy_decisions;

create or replace view public_source_proposals as
  select id, target_url, status
  from source_proposals;

-- ----------------------------------------------------------------------------
-- Privileges and Access Control
-- ----------------------------------------------------------------------------

-- Revoke direct select on internal schema tables from anonymous clients to prevent PII leakage
revoke select on
  source_institutions,
  source_endpoints,
  source_collections,
  source_access_rules,
  source_proposals,
  source_proposal_intents,
  source_assessments,
  source_policy_decisions,
  source_verified_evidence,
  source_policy_evaluations,
  source_reverifications,
  source_reverification_events,
  source_drift_evaluations,
  source_governance_comparisons
from public, terraveler_anon;

-- Grant select only on safe, public-sanitized views to anonymous clients (exposing resource IDs as safe public identifiers)
grant select on public_source_endpoints, public_source_policy_decisions, public_source_proposals to terraveler_anon;

-- generic terraveler_service only has SELECT/INSERT on evidence, and SELECT-only on evaluations (No UPDATE/DELETE/TRUNCATE!)
grant select, insert, update, delete on
  source_institutions,
  source_endpoints,
  source_collections,
  source_access_rules,
  source_proposals,
  source_proposal_intents,
  source_assessments,
  source_policy_decisions,
  source_reverifications,
  source_governance_comparisons
to terraveler_service;

grant select, insert on source_verified_evidence to terraveler_service;
grant select on source_policy_evaluations to terraveler_service;

-- Grant selective append privileges to service role
grant select, insert on source_reverification_events to terraveler_service;
grant select on source_drift_evaluations to terraveler_service;

-- Create evaluator and trusted writer roles (PostgreSQL Role Separation)
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'terraveler_evaluator') then
    create role terraveler_evaluator;
  end if;
end $$;

-- dedicated trusted evaluator writer role has full select/insert capability
grant select, insert on source_verified_evidence to terraveler_evaluator;
grant select, insert on source_policy_evaluations to terraveler_evaluator;
grant select, insert on source_reverifications to terraveler_evaluator;
grant select, insert on source_reverification_events to terraveler_evaluator;
grant select, insert on source_drift_evaluations to terraveler_evaluator;

-- Grant minimal sequence usage safely after roles and tables exist
grant usage, select on sequence 
  source_verified_evidence_id_seq, 
  source_policy_evaluations_id_seq, 
  source_reverifications_id_seq,
  source_reverification_events_id_seq,
  source_drift_evaluations_id_seq
to terraveler_evaluator, terraveler_service;
