from dataclasses import dataclass, field
from typing import Optional, List, Dict
import datetime
import hashlib
import json

APPROVED_VERIFIERS = {
    "SG-INC-001_EXPLICIT_USE_PROHIBITION": {
        "rights_scanner/1.0",
        "license_scanner/1.0"
    },
    "SG-INC-002_FORBIDDEN_ACCESS_MODE": {
        "network_analyzer/1.0",
        "access_policy_verifier/1.0"
    },
    "SG-INC-003_INVALID_SOURCE_IDENTITY": {
        "dns_resolver/1.0",
        "identity_verifier/1.0"
    }
}


@dataclass
class VerifierAssertion:
    """
    Formal, typed verifier assertion representing a verified fact or incompatibility.
    A plain caller boolean is never sufficient authority.
    """
    code: str
    verifier_id_version: str
    basis: str
    source_evidence: str
    timestamp: datetime.datetime
    artifact_hash: Optional[str] = None


@dataclass
class VerifiedEvidence:
    """
    VerifiedEvidence contract.
    Contains strictly observed/verified facts, independent of LLM/Archivist recommendation.
    """
    assessment_id: int
    verified_at: datetime.datetime
    verifier_version: str
    
    subject_type: str
    subject_id: int
    
    institution_identity_verified: bool
    endpoint_identity_verified: bool
    
    rights_statement_retrieved: bool
    rights_statement_hash_matches: bool
    
    rights_verified: bool
    rights_class: str
    rights_identifier: Optional[str]
    rights_uri: Optional[str]
    
    scope_verified: bool
    scope_type: str
    scope_identifier: Optional[str]
    
    access_verified: bool
    verification_strategy: str
    
    conflicts: List[str]
    evidence_sources: List[str]
    
    # Phase 3B.3 Extended Fields for Redirect & Collection boundaries
    canonical_host: str = ""
    collection_identifier: str = ""
    
    reverification_generation: int = 0 # Explicit Staleness Generation
    
    # Explicit deterministic policy facts for REJECT/incompatibility
    policy_incompatible: bool = False
    incompatibility_codes: List[str] = field(default_factory=list)


@dataclass
class PolicyEvaluation:
    """
    The deterministic output of evaluating policy rules against VerifiedEvidence.
    """
    decision_outcome: str
    trust_mode: Optional[str]
    rule_id: str
    reason_codes: List[str]
    blocking_conditions: List[str]
    policy_version: str
    verification_version: str
    evidence_snapshot: Dict


@dataclass
class DriftEvaluation:
    """
    Deterministic output of classifying material drift.
    """
    drift_detected: bool
    drift_class: str
    drift_codes: List[str]
    reason_codes: List[str]
    blocking_conditions: List[str]
    old_material_fingerprint: str
    new_material_fingerprint: str
    recommended_action: str # "KEEP_ACTIVE", "QUARANTINE_AND_REEVALUATE", "REVIEW_REQUIRED"


POLICY_VERSION = "SG-P1"
SUPPORTED_POLICY_VERSIONS = {POLICY_VERSION}
REVERIFIER_VERSION = "SGR-V1"

def canonicalize_evidence(evidence: VerifiedEvidence) -> str:
    """
    Produces a deterministic, stable, and platform-independent JSON string representation
    of VerifiedEvidence. Timestamps, dynamic fields, and model-dependent formatting are omitted
    to guarantee absolute reproducibility of the hash.
    """
    stable_dict = {
        "subject_type": str(evidence.subject_type),
        "subject_id": int(evidence.subject_id),
        "institution_identity_verified": bool(evidence.institution_identity_verified),
        "endpoint_identity_verified": bool(evidence.endpoint_identity_verified),
        "rights_statement_retrieved": bool(evidence.rights_statement_retrieved),
        "rights_statement_hash_matches": bool(evidence.rights_statement_hash_matches),
        "rights_verified": bool(evidence.rights_verified),
        "rights_class": str(evidence.rights_class),
        "rights_identifier": str(evidence.rights_identifier) if evidence.rights_identifier is not None else None,
        "rights_uri": str(evidence.rights_uri) if evidence.rights_uri is not None else None,
        "scope_verified": bool(evidence.scope_verified),
        "scope_type": str(evidence.scope_type),
        "scope_identifier": str(evidence.scope_identifier) if evidence.scope_identifier is not None else None,
        "access_verified": bool(evidence.access_verified),
        "verification_strategy": str(evidence.verification_strategy),
        "canonical_host": str(evidence.canonical_host),
        "collection_identifier": str(evidence.collection_identifier),
        "policy_incompatible": bool(evidence.policy_incompatible),
        "incompatibility_codes": sorted(list(evidence.incompatibility_codes)) if evidence.incompatibility_codes else [],
        "conflicts": sorted(list(evidence.conflicts)) if evidence.conflicts else [],
        "evidence_sources": sorted(list(evidence.evidence_sources)) if evidence.evidence_sources else []
    }
    return json.dumps(stable_dict, sort_keys=True, separators=(",", ":"))

def compute_evidence_hash(evidence: VerifiedEvidence) -> str:
    """Computes SHA256 of canonicalized verified evidence facts."""
    canonical = canonicalize_evidence(evidence)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

def canonicalize_policy_evaluation(evaluation: PolicyEvaluation, subject_type: str, subject_id: int, verified_evidence_id: int) -> str:
    """
    Produces a deterministic, stable, and platform-independent JSON string representation
    of PolicyEvaluation. Timestamps and dynamic fields are omitted to guarantee absolute reproducibility.
    """
    stable_dict = {
        "verified_evidence_id": int(verified_evidence_id),
        "subject_type": str(subject_type),
        "subject_id": int(subject_id),
        "decision_outcome": str(evaluation.decision_outcome),
        "trust_mode": str(evaluation.trust_mode) if evaluation.trust_mode is not None else None,
        "rule_id": str(evaluation.rule_id),
        "reason_codes": sorted(list(evaluation.reason_codes)) if evaluation.reason_codes else [],
        "blocking_conditions": sorted(list(evaluation.blocking_conditions)) if evaluation.blocking_conditions else [],
        "policy_version": str(evaluation.policy_version),
        "verification_version": str(evaluation.verification_version),
        "evidence_snapshot": evaluation.evidence_snapshot
    }
    if isinstance(stable_dict["evidence_snapshot"], dict):
        stable_dict["evidence_snapshot"] = json.loads(json.dumps(stable_dict["evidence_snapshot"], sort_keys=True))
        
    return json.dumps(stable_dict, sort_keys=True, separators=(",", ":"))

def compute_policy_evaluation_hash(evaluation: PolicyEvaluation, subject_type: str, subject_id: int, verified_evidence_id: int) -> str:
    """Computes SHA256 of canonicalized policy evaluation."""
    canonical = canonicalize_policy_evaluation(evaluation, subject_type, subject_id, verified_evidence_id)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

def canonicalize_drift_evaluation(evaluation: DriftEvaluation, subject_type: str, subject_id: int, reverification_id: int) -> str:
    """
    Produces a deterministic, stable string representation of DriftEvaluation for hashing.
    """
    stable_dict = {
        "reverification_id": int(reverification_id),
        "subject_type": str(subject_type),
        "subject_id": int(subject_id),
        "drift_detected": bool(evaluation.drift_detected),
        "drift_class": str(evaluation.drift_class),
        "drift_codes": sorted(list(evaluation.drift_codes)) if evaluation.drift_codes else [],
        "reason_codes": sorted(list(evaluation.reason_codes)) if evaluation.reason_codes else [],
        "blocking_conditions": sorted(list(evaluation.blocking_conditions)) if evaluation.blocking_conditions else [],
        "old_material_fingerprint": str(evaluation.old_material_fingerprint),
        "new_material_fingerprint": str(evaluation.new_material_fingerprint),
        "recommended_action": str(evaluation.recommended_action)
    }
    return json.dumps(stable_dict, sort_keys=True, separators=(",", ":"))

def compute_drift_evaluation_hash(evaluation: DriftEvaluation, subject_type: str, subject_id: int, reverification_id: int) -> str:
    """Computes SHA256 of canonicalized drift evaluation."""
    canonical = canonicalize_drift_evaluation(evaluation, subject_type, subject_id, reverification_id)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

def produce_verified_evidence(assessment_dict: dict, assertions: List[VerifierAssertion] = None) -> VerifiedEvidence:
    """
    Deterministic verifier boundary converting an assessment and formal verifier assertions
    into VerifiedEvidence. Combines independent facts and enforces incompatibility rules.
    """
    rights_class = assessment_dict.get("rights_class", "unknown")
    rights_verified = assessment_dict.get("rights_verified", False) # Default to FALSE for fail-closed security
    scope_type = assessment_dict.get("rights_scope_type", "unresolved")
    
    conflicts = list(assessment_dict.get("conflicts", []))
    incompatibility_codes = []
    policy_incompatible = False
    
    # Process and authorize formal, typed verifier assertions
    if assertions:
        for ast in assertions:
            if not isinstance(ast, VerifierAssertion):
                continue
            # Authorize assertion code and matching verifier version
            allowed_verifiers = APPROVED_VERIFIERS.get(ast.code)
            if allowed_verifiers and ast.verifier_id_version in allowed_verifiers:
                policy_incompatible = True
                incompatibility_codes.append(ast.code)
                
    strategy = assessment_dict.get("verification_strategy", "none")
    host = assessment_dict.get("rights_scope_identifier", "")
    
    evidence = VerifiedEvidence(
        assessment_id=assessment_dict.get("id", 0),
        verified_at=datetime.datetime.now(datetime.timezone.utc),
        verifier_version="1.0",
        reverification_generation=assessment_dict.get("reverification_generation", 0),
        
        subject_type=assessment_dict.get("subject_type", "proposal"),
        subject_id=assessment_dict.get("subject_id", 0),
        
        # All independent verification facts default to FALSE for fail-closed security
        institution_identity_verified=assessment_dict.get("institution_identity_verified", False),
        endpoint_identity_verified=assessment_dict.get("endpoint_identity_verified", False),
        
        rights_statement_retrieved=assessment_dict.get("rights_statement_retrieved", False),
        rights_statement_hash_matches=assessment_dict.get("rights_statement_hash_matches", False),
        rights_verified=rights_verified,
        rights_class=rights_class,
        rights_identifier=assessment_dict.get("rights_identifier"),
        rights_uri=assessment_dict.get("rights_uri"),
        
        scope_verified=assessment_dict.get("scope_verified", False),
        scope_type=scope_type,
        scope_identifier=host,
        
        access_verified=assessment_dict.get("access_verified", False),
        verification_strategy=strategy,
        
        canonical_host=assessment_dict.get("canonical_host", ""),
        collection_identifier=assessment_dict.get("collection_identifier", ""),
        
        conflicts=conflicts,
        evidence_sources=list(assessment_dict.get("evidence_sources", [])),
        policy_incompatible=policy_incompatible,
        incompatibility_codes=incompatibility_codes
    )
    return evidence

def evaluate_source_policy(evidence: VerifiedEvidence, policy_version: str = POLICY_VERSION) -> PolicyEvaluation:
    """
    Pure deterministic policy evaluator.
    No database writes, no network calls, no LLM inference.
    Maps verified evidence to an authoritative policy decision.
    """
    if policy_version not in SUPPORTED_POLICY_VERSIONS:
        raise ValueError(f"Unsupported policy version: {policy_version}")
        
    blocking_conditions = []
    reason_codes = []
    
    # Check absolute invariants (Failure conditions)
    if evidence.rights_class == "unknown":
        blocking_conditions.append("UNKNOWN_RIGHTS")
    
    if not evidence.rights_verified:
        blocking_conditions.append("RIGHTS_NOT_VERIFIED")
        
    if evidence.scope_type == "unresolved":
        blocking_conditions.append("SCOPE_UNRESOLVED")
        
    if evidence.conflicts:
        blocking_conditions.append("CONFLICTING_EVIDENCE")
        
    if not evidence.institution_identity_verified or not evidence.endpoint_identity_verified:
        blocking_conditions.append("IDENTITY_UNVERIFIED")
        
    if evidence.policy_incompatible:
        blocking_conditions.append("POLICY_INCOMPATIBLE")
        
    # Evaluate Rules
    
    # 0. REJECT (SG-P1-099_POLICY_INCOMPATIBLE)
    if "POLICY_INCOMPATIBLE" in blocking_conditions or evidence.policy_incompatible:
        rule = "SG-P1-099_POLICY_INCOMPATIBLE"
        return _build_eval("reject", None, rule, reason_codes, blocking_conditions, evidence, policy_version)
        
    # 1. DOMAIN_TRUSTED (SG-P1-010_ENDPOINT_SCOPE_AND_RIGHTS_VERIFIED)
    if not blocking_conditions and evidence.scope_type == "endpoint" and evidence.scope_verified:
        if evidence.rights_class in ("public_domain", "creative_commons"):
            reason_codes.append("ENDPOINT_WIDE_VERIFIED")
            return _build_eval("approve", "domain_trusted", "SG-P1-010_ENDPOINT_SCOPE_AND_RIGHTS_VERIFIED", 
                               reason_codes, blocking_conditions, evidence, policy_version)

    # 2. COLLECTION_TRUSTED (SG-P1-011_COLLECTION_SCOPE_AND_RIGHTS_VERIFIED)
    if not blocking_conditions and evidence.scope_type == "collection" and evidence.scope_verified:
         if evidence.rights_class in ("public_domain", "creative_commons"):
            reason_codes.append("COLLECTION_WIDE_VERIFIED")
            return _build_eval("approve", "collection_trusted", "SG-P1-011_COLLECTION_SCOPE_AND_RIGHTS_VERIFIED", 
                               reason_codes, blocking_conditions, evidence, policy_version)
                               
    # 3. ITEM_VERIFIED (SG-P1-020_SUPPORTED_ITEM_VERIFIER / SG-P1-021_MIXED_WITHOUT_SUPPORTED_VERIFIER)
    if evidence.rights_class == "mixed" and evidence.institution_identity_verified and evidence.endpoint_identity_verified:
        if not blocking_conditions:
            if evidence.verification_strategy == "archive_org_metadata":
                 reason_codes.append("SUPPORTED_VERIFIER_FOUND")
                 return _build_eval("approve", "item_verified", "SG-P1-020_SUPPORTED_ITEM_VERIFIER", 
                                   reason_codes, blocking_conditions, evidence, policy_version)
            else:
                 blocking_conditions.append("UNSUPPORTED_VERIFIER")
                 return _build_eval("needs_human_review", None, "SG-P1-021_MIXED_WITHOUT_SUPPORTED_VERIFIER", 
                                   reason_codes, blocking_conditions, evidence, policy_version)
        else:
            pass

    # 4. LINK_ONLY (SG-P1-030_LINK_ONLY_ALLOWED)
    if not blocking_conditions and evidence.institution_identity_verified and evidence.access_verified and evidence.rights_class in ("in_copyright", "mixed", "unknown"):
        reason_codes.append("LINK_ONLY_PERMITTED")
        return _build_eval("approve", "link_only", "SG-P1-030_LINK_ONLY_ALLOWED", 
                           reason_codes, blocking_conditions, evidence, policy_version)

    # Fallback / explicit blockers mapping to rules
    if "UNKNOWN_RIGHTS" in blocking_conditions or "RIGHTS_NOT_VERIFIED" in blocking_conditions:
        rule = "SG-P1-001_INSUFFICIENT_RIGHTS_EVIDENCE"
    elif "SCOPE_UNRESOLVED" in blocking_conditions or not evidence.scope_verified:
        rule = "SG-P1-002_SCOPE_UNRESOLVED"
    elif "IDENTITY_UNVERIFIED" in blocking_conditions:
        rule = "SG-P1-003_IDENTITY_UNVERIFIED"
    elif "CONFLICTING_EVIDENCE" in blocking_conditions:
        rule = "SG-P1-090_CONFLICTING_EVIDENCE"
    else:
        rule = "SG-P1-000_DEFAULT_NEEDS_REVIEW"

    return _build_eval("needs_human_review", None, rule, reason_codes, blocking_conditions, evidence, policy_version)


def _build_eval(decision_outcome: str, trust_mode: Optional[str], rule_id: str, 
                reason_codes: List[str], blocking_conditions: List[str], 
                evidence: VerifiedEvidence, policy_version: str) -> PolicyEvaluation:
    
    snapshot = {
        "assessment_id": evidence.assessment_id,
        "verified_at": evidence.verified_at.isoformat(),
        "verifier_version": evidence.verifier_version,
        "policy_version": policy_version,
        "rule_id": rule_id,
        "reverification_generation": evidence.reverification_generation,
        
        "institution_identity_verified": evidence.institution_identity_verified,
        "endpoint_identity_verified": evidence.endpoint_identity_verified,
        
        "rights_statement_retrieved": evidence.rights_statement_retrieved,
        "rights_statement_hash_matches": evidence.rights_statement_hash_matches,
        "rights_verified": evidence.rights_verified,
        "rights_class": evidence.rights_class,
        "rights_identifier": evidence.rights_identifier,
        "rights_uri": evidence.rights_uri,
        
        "scope_verified": evidence.scope_verified,
        "scope_type": evidence.scope_type,
        "scope_identifier": evidence.scope_identifier,
        
        "access_verified": evidence.access_verified,
        "verification_strategy": evidence.verification_strategy,
        
        "canonical_host": evidence.canonical_host,
        "collection_identifier": evidence.collection_identifier,
        
        "conflicts": evidence.conflicts,
        "evidence_sources": evidence.evidence_sources,
        
        "policy_incompatible": evidence.policy_incompatible,
        "incompatibility_codes": evidence.incompatibility_codes
    }
    
    return PolicyEvaluation(
        decision_outcome=decision_outcome,
        trust_mode=trust_mode,
        rule_id=rule_id,
        reason_codes=reason_codes,
        blocking_conditions=blocking_conditions,
        policy_version=policy_version,
        verification_version=evidence.verifier_version,
        evidence_snapshot=snapshot
    )


def persist_source_policy_evaluation(cur, verified_evidence_id: int) -> int:
    """
    Dedicated trusted evaluation writer boundary.
    Reconstructs VerifiedEvidence from base tables, runs the deterministic policy engine,
    canonicalizes the result, computes the evaluation hash, and inserts the immutable record.
    """
    # 1. Fetch verified evidence facts (including verified_at and reverification_generation!)
    cur.execute(
        "SELECT id, assessment_id, proposal_id, subject_type, subject_id, "
        "       verified_at, verifier_version, institution_identity_verified, endpoint_identity_verified, "
        "       rights_statement_retrieved, rights_statement_hash_matches, rights_verified, "
        "       rights_class, rights_identifier, rights_uri, scope_verified, scope_type, "
        "       scope_identifier, access_verified, verification_strategy, policy_incompatible, "
        "       incompatibility_codes, conflicts, evidence_sources, canonical_host, collection_identifier, "
        "       reverification_generation "
        "FROM source_verified_evidence "
        "WHERE id = %s",
        (verified_evidence_id,)
    )
    row = cur.fetchone()
    if not row:
        raise ValueError(f"VerifiedEvidence record {verified_evidence_id} not found.")
        
    # Reconstruct with the exact persisted timestamp, guaranteeing hash reproducibility!
    evidence = VerifiedEvidence(
        assessment_id=row["assessment_id"],
        verified_at=row["verified_at"],
        verifier_version=row["verifier_version"],
        subject_type=row["subject_type"],
        subject_id=row["subject_id"],
        reverification_generation=row["reverification_generation"],
        institution_identity_verified=row["institution_identity_verified"],
        endpoint_identity_verified=row["endpoint_identity_verified"],
        rights_statement_retrieved=row["rights_statement_retrieved"],
        rights_statement_hash_matches=row["rights_statement_hash_matches"],
        rights_verified=row["rights_verified"],
        rights_class=row["rights_class"],
        rights_identifier=row["rights_identifier"],
        rights_uri=row["rights_uri"],
        scope_verified=row["scope_verified"],
        scope_type=row["scope_type"],
        scope_identifier=row["scope_identifier"],
        access_verified=row["access_verified"],
        verification_strategy=row["verification_strategy"],
        canonical_host=row["canonical_host"] if row["canonical_host"] else "",
        collection_identifier=row["collection_identifier"] if row["collection_identifier"] else "",
        conflicts=row["conflicts"] if row["conflicts"] else [],
        evidence_sources=row["evidence_sources"] if row["evidence_sources"] else [],
        policy_incompatible=row["policy_incompatible"],
        incompatibility_codes=row["incompatibility_codes"] if row["incompatibility_codes"] else []
    )
    
    # 2. Run deterministic policy engine
    evaluation = evaluate_source_policy(evidence, POLICY_VERSION)
    
    # 3. Compute deterministic evaluation hash
    eval_hash = compute_policy_evaluation_hash(evaluation, evidence.subject_type, evidence.subject_id, verified_evidence_id)
    evidence_hash = compute_evidence_hash(evidence)
    
    # 4. Insert into immutable evaluations table
    cur.execute(
        "INSERT INTO source_policy_evaluations "
        "(verified_evidence_id, subject_type, subject_id, reverification_generation, "
        " decision_outcome, trust_mode, rule_id, reason_codes, blocking_conditions, "
        " policy_version, verification_version, evidence_hash, "
        " evaluation_snapshot, evaluation_hash) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
        "RETURNING id",
        (
            verified_evidence_id,
            evidence.subject_type,
            evidence.subject_id,
            evidence.reverification_generation,
            evaluation.decision_outcome,
            evaluation.trust_mode,
            evaluation.rule_id,
            evaluation.reason_codes,
            evaluation.blocking_conditions,
            evaluation.policy_version,
            evaluation.verification_version,
            evidence_hash,
            json.dumps(evaluation.evidence_snapshot),
            eval_hash
        )
    )
    return cur.fetchone()["id"]


def compute_material_fingerprint(evidence: VerifiedEvidence) -> str:
    """
    Computes a canonical, stable SHA256 material fingerprint hash.
    Focuses strictly on trust-relevant facts, excluding retrieval timestamps, metadata,
    and unrelated prose.
    """
    stable_dict = {
        "subject_type": str(evidence.subject_type),
        "subject_id": int(evidence.subject_id),
        "institution_identity_verified": bool(evidence.institution_identity_verified),
        "endpoint_identity_verified": bool(evidence.endpoint_identity_verified),
        "canonical_host": str(evidence.canonical_host),
        "rights_class": str(evidence.rights_class),
        "rights_identifier": str(evidence.rights_identifier) if evidence.rights_identifier else "",
        "rights_uri": str(evidence.rights_uri) if evidence.rights_uri else "",
        "rights_statement_retrieved": bool(evidence.rights_statement_retrieved),
        "rights_statement_hash_matches": bool(evidence.rights_statement_hash_matches),
        "scope_type": str(evidence.scope_type),
        "scope_identifier": str(evidence.scope_identifier) if evidence.scope_identifier else "",
        "access_verified": bool(evidence.access_verified),
        "verification_strategy": str(evidence.verification_strategy),
        "collection_identifier": str(evidence.collection_identifier),
        "policy_incompatible": bool(evidence.policy_incompatible)
    }
    canonical = json.dumps(stable_dict, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def classify_material_drift(
    previous_evidence: VerifiedEvidence,
    new_evidence: VerifiedEvidence,
    previous_decision: dict,
    policy_context: dict = None
) -> DriftEvaluation:
    """
    Pure deterministic drift classifier (Hardened).
    Compares previous and new verified evidence records to categorize change materiality.
    Returns DriftEvaluation. Accumulates ALL matched drift codes.
    """
    old_fingerprint = compute_material_fingerprint(previous_evidence)
    new_fingerprint = compute_material_fingerprint(new_evidence)
    
    drift_detected = (old_fingerprint != new_fingerprint)
    drift_class = "NO_DRIFT"
    drift_codes = []
    reason_codes = []
    blocking_conditions = []
    recommended_action = "KEEP_ACTIVE"
    
    if drift_detected:
        # Accumulate ALL deterministic drift codes
        if previous_evidence.rights_class != new_evidence.rights_class or previous_evidence.rights_identifier != new_evidence.rights_identifier:
            drift_codes.append("SG-DRIFT-001_RIGHTS_IDENTIFIER_CHANGED")
            
        if previous_evidence.rights_uri != new_evidence.rights_uri:
            drift_codes.append("SG-DRIFT-002_RIGHTS_URI_CHANGED")
            
        if previous_evidence.scope_type != new_evidence.scope_type:
            drift_codes.append("SG-DRIFT-003_RIGHTS_SCOPE_CHANGED")
            
        if previous_evidence.rights_statement_retrieved and not new_evidence.rights_statement_retrieved:
            drift_codes.append("SG-DRIFT-004_RIGHTS_STATEMENT_DISAPPEARED")
            
        if previous_evidence.endpoint_identity_verified != new_evidence.endpoint_identity_verified or previous_evidence.institution_identity_verified != new_evidence.institution_identity_verified:
            drift_codes.append("SG-DRIFT-005_ENDPOINT_IDENTITY_CHANGED")
            
        if previous_evidence.canonical_host != new_evidence.canonical_host:
            drift_codes.append("SG-DRIFT-007_UNEXPECTED_REDIRECT_HOST")
            
        if previous_evidence.access_verified != new_evidence.access_verified:
            drift_codes.append("SG-DRIFT-008_ACCESS_MODE_CHANGED")
            
        if previous_evidence.collection_identifier != new_evidence.collection_identifier:
            drift_codes.append("SG-DRIFT-009_COLLECTION_IDENTIFIER_CHANGED")
            
        if previous_evidence.verification_strategy != new_evidence.verification_strategy:
            drift_codes.append("SG-DRIFT-010_SUPPORTED_ITEM_VERIFIER_UNAVAILABLE")
            
        if new_evidence.policy_incompatible:
            drift_codes.append("SG-DRIFT-013_TERMS_PROHIBITION_DETECTED")
            
        # If fingerprint changed but no specific matched branch, it's generic content change
        if not drift_codes:
            drift_class = "NON_MATERIAL_DRIFT"
            drift_codes.append("SG-DRIFT-090_GENERIC_CONTENT_CHANGED")
            recommended_action = "KEEP_ACTIVE"
        else:
            # Map strongest drift class and action deterministically based on drift codes accumulated
            # Prioritize Rights, Scope, and Identity as strongest drift classes
            if "SG-DRIFT-001_RIGHTS_IDENTIFIER_CHANGED" in drift_codes or "SG-DRIFT-002_RIGHTS_URI_CHANGED" in drift_codes or "SG-DRIFT-004_RIGHTS_STATEMENT_DISAPPEARED" in drift_codes or "SG-DRIFT-013_TERMS_PROHIBITION_DETECTED" in drift_codes:
                drift_class = "MATERIAL_RIGHTS_DRIFT"
                recommended_action = "QUARANTINE_AND_REEVALUATE"
            elif "SG-DRIFT-003_RIGHTS_SCOPE_CHANGED" in drift_codes:
                drift_class = "MATERIAL_SCOPE_DRIFT"
                recommended_action = "QUARANTINE_AND_REEVALUATE"
            elif "SG-DRIFT-005_ENDPOINT_IDENTITY_CHANGED" in drift_codes:
                drift_class = "MATERIAL_IDENTITY_DRIFT"
                recommended_action = "QUARANTINE_AND_REEVALUATE"
            elif "SG-DRIFT-007_UNEXPECTED_REDIRECT_HOST" in drift_codes:
                drift_class = "MATERIAL_REDIRECT_DRIFT"
                recommended_action = "QUARANTINE_AND_REEVALUATE"
            elif "SG-DRIFT-009_COLLECTION_IDENTIFIER_CHANGED" in drift_codes:
                drift_class = "MATERIAL_COLLECTION_DRIFT"
                recommended_action = "QUARANTINE_AND_REEVALUATE"
            elif "SG-DRIFT-008_ACCESS_MODE_CHANGED" in drift_codes:
                drift_class = "MATERIAL_ACCESS_DRIFT"
                recommended_action = "QUARANTINE_AND_REEVALUATE"
            else:
                drift_class = "MATERIAL_VERIFIER_DRIFT"
                recommended_action = "QUARANTINE_AND_REEVALUATE"
            
    # Check transient failure window or persistent unreachability
    if not new_evidence.access_verified and previous_evidence.access_verified:
        retries = policy_context.get("access_failure_count", 0) if policy_context else 0
        if retries >= 3:
            drift_detected = True
            drift_class = "UNRESOLVED_DRIFT"
            if "SG-DRIFT-008_ACCESS_MODE_CHANGED" not in drift_codes:
                drift_codes.append("SG-DRIFT-008_ACCESS_MODE_CHANGED")
            recommended_action = "QUARANTINE_AND_REEVALUATE"
        else:
            # First failure is classified as non-material transient observation, remain active
            drift_detected = True
            drift_class = "NON_MATERIAL_DRIFT"
            drift_codes.append("SG-DRIFT-099_UNRESOLVED_CHANGE")
            reason_codes.append("TRANSIENT_OPERATIONAL_FAILURE_OBSERVED")
            recommended_action = "KEEP_ACTIVE"
            
    return DriftEvaluation(
        drift_detected=drift_detected,
        drift_class=drift_class,
        drift_codes=drift_codes,
        reason_codes=reason_codes,
        blocking_conditions=blocking_conditions,
        old_material_fingerprint=old_fingerprint,
        new_material_fingerprint=new_fingerprint,
        recommended_action=recommended_action
    )


def persist_source_drift_evaluation(cur, reverification_id: int, prev_evidence_id: int, new_evidence_id: int) -> int:
    """
    Dedicated trusted drift evaluator writer boundary.
    Reconstructs old and new VerifiedEvidence, runs classify_material_drift(),
    canonicalizes the result, and inserts the immutable source_drift_evaluations record.
    """
    # 1. Fetch old verified evidence facts
    cur.execute(
        "SELECT id, assessment_id, proposal_id, subject_type, subject_id, "
        "       verified_at, verifier_version, institution_identity_verified, endpoint_identity_verified, "
        "       rights_statement_retrieved, rights_statement_hash_matches, rights_verified, "
        "       rights_class, rights_identifier, rights_uri, scope_verified, scope_type, "
        "       scope_identifier, access_verified, verification_strategy, policy_incompatible, "
        "       incompatibility_codes, conflicts, evidence_sources, canonical_host, collection_identifier, "
        "       reverification_generation "
        "FROM source_verified_evidence WHERE id = %s",
        (prev_evidence_id,)
    )
    row_prev = cur.fetchone()
    if not row_prev:
        raise ValueError(f"Previous VerifiedEvidence record {prev_evidence_id} not found.")
        
    prev_ev = VerifiedEvidence(
        assessment_id=row_prev["assessment_id"],
        verified_at=row_prev["verified_at"],
        verifier_version=row_prev["verifier_version"],
        subject_type=row_prev["subject_type"],
        subject_id=row_prev["subject_id"],
        reverification_generation=row_prev["reverification_generation"],
        institution_identity_verified=row_prev["institution_identity_verified"],
        endpoint_identity_verified=row_prev["endpoint_identity_verified"],
        rights_statement_retrieved=row_prev["rights_statement_retrieved"],
        rights_statement_hash_matches=row_prev["rights_statement_hash_matches"],
        rights_verified=row_prev["rights_verified"],
        rights_class=row_prev["rights_class"],
        rights_identifier=row_prev["rights_identifier"],
        rights_uri=row_prev["rights_uri"],
        scope_verified=row_prev["scope_verified"],
        scope_type=row_prev["scope_type"],
        scope_identifier=row_prev["scope_identifier"],
        access_verified=row_prev["access_verified"],
        verification_strategy=row_prev["verification_strategy"],
        canonical_host=row_prev["canonical_host"] if row_prev["canonical_host"] else "",
        collection_identifier=row_prev["collection_identifier"] if row_prev["collection_identifier"] else "",
        conflicts=row_prev["conflicts"] if row_prev["conflicts"] else [],
        evidence_sources=row_prev["evidence_sources"] if row_prev["evidence_sources"] else [],
        policy_incompatible=row_prev["policy_incompatible"],
        incompatibility_codes=row_prev["incompatibility_codes"] if row_prev["incompatibility_codes"] else []
    )
    
    # 2. Fetch new verified evidence facts
    cur.execute(
        "SELECT id, assessment_id, proposal_id, subject_type, subject_id, "
        "       verified_at, verifier_version, institution_identity_verified, endpoint_identity_verified, "
        "       rights_statement_retrieved, rights_statement_hash_matches, rights_verified, "
        "       rights_class, rights_identifier, rights_uri, scope_verified, scope_type, "
        "       scope_identifier, access_verified, verification_strategy, policy_incompatible, "
        "       incompatibility_codes, conflicts, evidence_sources, canonical_host, collection_identifier, "
        "       reverification_generation "
        "FROM source_verified_evidence WHERE id = %s",
        (new_evidence_id,)
    )
    row_new = cur.fetchone()
    if not row_new:
        raise ValueError(f"New VerifiedEvidence record {new_evidence_id} not found.")
        
    new_ev = VerifiedEvidence(
        assessment_id=row_new["assessment_id"],
        verified_at=row_new["verified_at"],
        verifier_version=row_new["verifier_version"],
        subject_type=row_new["subject_type"],
        subject_id=row_new["subject_id"],
        reverification_generation=row_new["reverification_generation"],
        institution_identity_verified=row_new["institution_identity_verified"],
        endpoint_identity_verified=row_new["endpoint_identity_verified"],
        rights_statement_retrieved=row_new["rights_statement_retrieved"],
        rights_statement_hash_matches=row_new["rights_statement_hash_matches"],
        rights_verified=row_new["rights_verified"],
        rights_class=row_new["rights_class"],
        rights_identifier=row_new["rights_identifier"],
        rights_uri=row_new["rights_uri"],
        scope_verified=row_new["scope_verified"],
        scope_type=row_new["scope_type"],
        scope_identifier=row_new["scope_identifier"],
        access_verified=row_new["access_verified"],
        verification_strategy=row_new["verification_strategy"],
        canonical_host=row_new["canonical_host"] if row_new["canonical_host"] else "",
        collection_identifier=row_new["collection_identifier"] if row_new["collection_identifier"] else "",
        conflicts=row_new["conflicts"] if row_new["conflicts"] else [],
        evidence_sources=row_new["evidence_sources"] if row_new["evidence_sources"] else [],
        policy_incompatible=row_new["policy_incompatible"],
        incompatibility_codes=row_new["incompatibility_codes"] if row_new["incompatibility_codes"] else []
    )
    
    # 3. Classify drift
    drift = classify_material_drift(prev_ev, new_ev, previous_decision={})
    
    # 4. Canonicalize and hash drift evaluation
    snapshot = {
        "reverification_id": reverification_id,
        "prev_evidence_id": prev_evidence_id,
        "new_evidence_id": new_evidence_id,
        "drift_detected": drift.drift_detected,
        "drift_class": drift.drift_class,
        "drift_codes": drift.drift_codes,
        "old_material_fingerprint": drift.old_material_fingerprint,
        "new_material_fingerprint": drift.new_material_fingerprint,
        "recommended_action": drift.recommended_action
    }
    
    stable_canon = json.dumps(snapshot, sort_keys=True, separators=(",", ":"))
    eval_hash = hashlib.sha256(stable_canon.encode("utf-8")).hexdigest()
    
    cur.execute(
        "INSERT INTO source_drift_evaluations "
        "(reverification_id, subject_type, subject_id, "
        " drift_detected, drift_class, drift_codes, reason_codes, blocking_conditions, "
        " old_material_fingerprint, new_material_fingerprint, recommended_action, "
        " classifier_version, evaluation_snapshot, evaluation_hash) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
        "RETURNING id",
        (
            reverification_id,
            prev_ev.subject_type,
            prev_ev.subject_id,
            drift.drift_detected,
            drift.drift_class,
            drift.drift_codes,
            drift.reason_codes,
            drift.blocking_conditions,
            drift.old_material_fingerprint,
            drift.new_material_fingerprint,
            drift.recommended_action,
            REVERIFIER_VERSION,
            json.dumps(snapshot),
            eval_hash
        )
    )
    return cur.fetchone()["id"]
