-- Phase 3B.2/3B.3: Atomic Policy Application and Lifecycle Engine RPC (Hardened Sealing)
-- Enforces strict TOCTOU checks, database consistency checks,
-- generation-binding staleness prevention, and atomic database-side lifecycle mutations.

create or replace function apply_source_policy_decision(
  p_evaluation_id bigint,
  p_expected_evaluation_hash text,
  p_decider_type text,
  p_decider_id bigint,
  p_supersedes_decision_id bigint default null,
  p_reason text default null
)
returns bigint language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_evaluation_hash text;
  v_verified_evidence_id bigint;
  v_subject_type text;
  v_subject_id bigint;
  v_decision_outcome text;
  v_trust_mode text;
  v_rule_id text;
  v_policy_version text;
  v_verification_version text;
  v_evaluation_snapshot jsonb;
  v_evidence_hash text;
  v_rights_class text;
  v_rights_identifier text;
  
  v_evaluation_generation integer;
  v_evidence_generation integer;
  v_subject_generation integer := 0;
  
  v_old_endpoint_id bigint := null;
  v_old_collection_id bigint := null;
  v_old_proposal_id bigint := null;
  v_decision_id bigint;
  v_endpoint_id bigint := null;
  v_collection_id bigint := null;
  v_proposal_id bigint := null;
begin
  -- --------------------------------------------------------------------------
  -- 1. Read Persisted Policy Evaluation and Enforce TOCTOU Checks
  -- --------------------------------------------------------------------------
  select 
    evaluation_hash, verified_evidence_id, subject_type, subject_id,
    decision_outcome, trust_mode, rule_id, policy_version, verification_version,
    evaluation_snapshot, evidence_hash, reverification_generation
  into 
    v_evaluation_hash, v_verified_evidence_id, v_subject_type, v_subject_id,
    v_decision_outcome, v_trust_mode, v_rule_id, v_policy_version, v_verification_version,
    v_evaluation_snapshot, v_evidence_hash, v_evaluation_generation
  from public.source_policy_evaluations
  where id = p_evaluation_id;
  
  if not found then
    raise exception 'TOCTOU_VIOLATION: PolicyEvaluation % not found', p_evaluation_id;
  end if;
  
  if v_evaluation_hash != p_expected_evaluation_hash then
    raise exception 'TOCTOU_VIOLATION: Evaluation hash mismatch. Expected %, stored %', p_expected_evaluation_hash, v_evaluation_hash;
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Verify Subject Binding and Generation-Binding Staleness Prevention
  -- --------------------------------------------------------------------------
  declare
    v_evidence_subject_type text;
    v_evidence_subject_id bigint;
    v_evidence_stored_hash text;
  begin
    select subject_type, subject_id, evidence_hash, reverification_generation
    into v_evidence_subject_type, v_evidence_subject_id, v_evidence_stored_hash, v_evidence_generation
    from public.source_verified_evidence
    where id = v_verified_evidence_id;
    
    if not found then
      raise exception 'TOCTOU_VIOLATION: Associated VerifiedEvidence % not found', v_verified_evidence_id;
    end if;
    
    if v_evidence_stored_hash != v_evidence_hash then
      raise exception 'TOCTOU_VIOLATION: Evidence hash mismatch between evaluation and fact store';
    end if;
    
    if v_evidence_subject_type != v_subject_type or v_evidence_subject_id != v_subject_id then
      raise exception 'SUBJECT_BINDING_VIOLATION: Evidence subject (%, %) does not match evaluation subject (%, %)', 
        v_evidence_subject_type, v_evidence_subject_id, v_subject_type, v_subject_id;
    end if;

    -- Require that evidence generation matches the evaluation generation
    if v_evidence_generation != v_evaluation_generation then
      raise exception 'STALE_EVALUATION_VIOLATION: Associated VerifiedEvidence % generation % does not match evaluation generation %', 
        v_verified_evidence_id, v_evidence_generation, v_evaluation_generation;
    end if;
  end;

  -- Read current subject's generation (Staleness Authority)
  if v_subject_type = 'endpoint' then
    select reverification_generation into v_subject_generation from public.source_endpoints where id = v_subject_id;
  elif v_subject_type = 'collection' then
    select reverification_generation into v_subject_generation from public.source_collections where id = v_subject_id;
  else
    v_subject_generation := 0;
  end if;

  -- Require exact match of the subject generation
  if v_subject_generation != v_evaluation_generation then
    raise exception 'STALE_EVALUATION_VIOLATION: Evaluation generation % does not match current subject generation %', 
      v_evaluation_generation, v_subject_generation;
  end if;

  -- --------------------------------------------------------------------------
  -- 3. Proposal Ingestion Rule (No Proposal APPROVE)
  -- --------------------------------------------------------------------------
  if v_subject_type = 'proposal' and v_decision_outcome = 'approve' then
    raise exception 'PROPOSAL_APPROVAL_VIOLATION: Proposal subjects may only receive REVIEW or REJECT decisions before materialization';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. DB-level Consistency & Actor Checks
  -- --------------------------------------------------------------------------
  if v_decision_outcome = 'approve' and v_trust_mode is null then
    raise exception 'CONSISTENCY_VIOLATION: APPROVE requires a non-null trust_mode';
  end if;
  
  if v_decision_outcome != 'approve' and v_trust_mode is not null then
    raise exception 'CONSISTENCY_VIOLATION: % outcome requires a NULL trust_mode', v_decision_outcome;
  end if;
  
  if p_decider_type = 'system' and p_decider_id is not null then
    raise exception 'CONSISTENCY_VIOLATION: System decider must have NULL decider_id';
  end if;
  
  if p_decider_type = 'human' and p_decider_id is null then
    raise exception 'CONSISTENCY_VIOLATION: Human decider requires a non-null decider_id';
  end if;

  if p_decider_type not in ('human', 'system') then
    raise exception 'CONSISTENCY_VIOLATION: Invalid decider type %', p_decider_type;
  end if;

  -- Map subjects
  if v_subject_type = 'endpoint' then
    v_endpoint_id := v_subject_id;
  elif v_subject_type = 'collection' then
    v_collection_id := v_subject_id;
  elif v_subject_type = 'proposal' then
    v_proposal_id := v_subject_id;
  end if;

  -- --------------------------------------------------------------------------
  -- 5. Supersession Checks
  -- --------------------------------------------------------------------------
  if p_supersedes_decision_id is not null then
    select endpoint_id, collection_id, proposal_id 
    into v_old_endpoint_id, v_old_collection_id, v_old_proposal_id
    from public.source_policy_decisions
    where id = p_supersedes_decision_id;
    
    if not found then
      raise exception 'SUPERSESSION_VIOLATION: Superseded decision % does not exist', p_supersedes_decision_id;
    end if;
    
    -- Verify same subject target
    if coalesce(v_old_endpoint_id, -1) != coalesce(v_endpoint_id, -1) or
       coalesce(v_old_collection_id, -1) != coalesce(v_collection_id, -1) or
       coalesce(v_old_proposal_id, -1) != coalesce(v_proposal_id, -1) then
      raise exception 'SUPERSESSION_VIOLATION: Superseded subject mismatch';
    end if;
  end if;

  -- Extract snapshot fields for decisions
  v_rights_class := coalesce(v_evaluation_snapshot->'evidence_snapshot'->>'rights_class', 'unknown');
  v_rights_identifier := coalesce(v_evaluation_snapshot->'evidence_snapshot'->>'rights_identifier', null);

  -- --------------------------------------------------------------------------
  -- 6. Persist the New Immutable SourcePolicyDecision
  -- --------------------------------------------------------------------------
  insert into public.source_policy_decisions (
    endpoint_id, collection_id, proposal_id,
    decision_outcome, trust_mode, rights_class, rights_identifier,
    evidence_snapshot, policy_version, verification_version,
    supersedes_decision_id, carta_version, decided_by_actor_type,
    decided_by_actor_id, reason
  ) values (
    v_endpoint_id, v_collection_id, v_proposal_id,
    v_decision_outcome, v_trust_mode, v_rights_class, v_rights_identifier,
    v_evaluation_snapshot, v_policy_version, v_verification_version,
    p_supersedes_decision_id, '0.7', p_decider_type, p_decider_id, coalesce(p_reason, v_evaluation_snapshot->>'rule_id')
  ) returning id into v_decision_id;

  -- --------------------------------------------------------------------------
  -- 7. Atomic Lifecycle State Mutations & Trust Clearing Invariants
  -- --------------------------------------------------------------------------
  if v_decision_outcome = 'approve' then
    if v_subject_type = 'endpoint' then
      update public.source_endpoints 
      set status = 'active', trust_mode = v_trust_mode
      where id = v_subject_id;
    elif v_subject_type = 'collection' then
      update public.source_collections 
      set status = 'active', trust_mode = v_trust_mode
      where id = v_subject_id;
    end if;
    
  elif v_decision_outcome = 'needs_human_review' then
    if v_subject_type = 'endpoint' then
      update public.source_endpoints 
      -- Clear stale trust_mode when status is set to review/rejected/quarantined
      set status = 'needs_human_review', trust_mode = null
      where id = v_subject_id;
    elif v_subject_type = 'collection' then
      update public.source_collections 
      set status = 'needs_human_review', trust_mode = null
      where id = v_subject_id;
    elif v_subject_type = 'proposal' then
      update public.source_proposals 
      set status = 'needs_policy_review'
      where id = v_subject_id;
    end if;
    
  elif v_decision_outcome = 'reject' then
    if v_subject_type = 'endpoint' then
      update public.source_endpoints 
      set status = 'rejected', trust_mode = null
      where id = v_subject_id;
    elif v_subject_type = 'collection' then
      update public.source_collections 
      set status = 'rejected', trust_mode = null
      where id = v_subject_id;
    elif v_subject_type = 'proposal' then
      update public.source_proposals 
      set status = 'rejected'
      where id = v_subject_id;
    end if;
  end if;

  return v_decision_id;
end $$;

-- Restrict execution to the backend service role
revoke execute on function apply_source_policy_decision from public, terraveler_anon;
grant execute on function apply_source_policy_decision to terraveler_service;
