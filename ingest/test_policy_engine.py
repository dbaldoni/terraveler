"""
Phase 3B.1: Deterministic Policy Activation Engine Tests (Hardened).
Tests pure function invariants for evaluating verified evidence without LLM/Network.

Run with:
    python3 -m unittest test_policy_engine -v
"""

import unittest
import datetime
from policy_engine import VerifiedEvidence, evaluate_source_policy

class TestDeterministicPolicyEngine(unittest.TestCase):

    def _base_evidence(self) -> VerifiedEvidence:
        return VerifiedEvidence(
            assessment_id=1,
            verified_at=datetime.datetime.now(datetime.timezone.utc),
            verifier_version="1.0",
            subject_type="endpoint",
            subject_id=42,
            institution_identity_verified=True,
            endpoint_identity_verified=True,
            rights_statement_retrieved=True,
            rights_statement_hash_matches=True,
            rights_verified=True,
            rights_class="public_domain",
            rights_identifier="PD",
            rights_uri=None,
            scope_verified=True,
            scope_type="endpoint",
            scope_identifier="example.org",
            access_verified=True,
            verification_strategy="none",
            conflicts=[],
            evidence_sources=["https://example.org/terms"],
            policy_incompatible=False,
            incompatibility_codes=[]
        )

    def test_a_verified_endpoint_public_domain(self):
        # A. Verified endpoint-wide public domain => APPROVE / DOMAIN_TRUSTED
        evidence = self._base_evidence()
        result = evaluate_source_policy(evidence)
        
        self.assertEqual(result.decision_outcome, "approve")
        self.assertEqual(result.trust_mode, "domain_trusted")
        self.assertEqual(result.rule_id, "SG-P1-010_ENDPOINT_SCOPE_AND_RIGHTS_VERIFIED")

    def test_b_verified_collection_compatible_cc(self):
        # B. Verified collection-wide compatible CC licence => APPROVE / COLLECTION_TRUSTED
        evidence = self._base_evidence()
        evidence.rights_class = "creative_commons"
        evidence.scope_type = "collection"
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "approve")
        self.assertEqual(result.trust_mode, "collection_trusted")
        self.assertEqual(result.rule_id, "SG-P1-011_COLLECTION_SCOPE_AND_RIGHTS_VERIFIED")

    def test_c_public_domain_unresolved_scope(self):
        # C. Public-domain wording but unresolved scope => NEEDS_HUMAN_REVIEW
        evidence = self._base_evidence()
        evidence.scope_type = "unresolved"
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")
        self.assertIsNone(result.trust_mode)
        self.assertIn("SCOPE_UNRESOLVED", result.blocking_conditions)
        self.assertEqual(result.rule_id, "SG-P1-002_SCOPE_UNRESOLVED")

    def test_d_mixed_repository_supported_verifier(self):
        # D. Mixed repository + supported deterministic item verifier => APPROVE / ITEM_VERIFIED
        evidence = self._base_evidence()
        evidence.rights_class = "mixed"
        evidence.verification_strategy = "archive_org_metadata"
        evidence.scope_type = "endpoint"
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "approve")
        self.assertEqual(result.trust_mode, "item_verified")
        self.assertEqual(result.rule_id, "SG-P1-020_SUPPORTED_ITEM_VERIFIER")

    def test_e_mixed_repository_unsupported_verifier(self):
        # E. Mixed repository without supported item verifier => NEEDS_HUMAN_REVIEW
        evidence = self._base_evidence()
        evidence.rights_class = "mixed"
        evidence.verification_strategy = "some_future_ai_verifier"
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")
        self.assertIsNone(result.trust_mode)
        self.assertIn("UNSUPPORTED_VERIFIER", result.blocking_conditions)
        self.assertEqual(result.rule_id, "SG-P1-021_MIXED_WITHOUT_SUPPORTED_VERIFIER")

    def test_f_legitimate_source_no_ingestion_link_only(self):
        # F. Verified legitimate source with no ingestion rights but link/reference allowed => APPROVE / LINK_ONLY
        evidence = self._base_evidence()
        evidence.rights_class = "in_copyright"
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "approve")
        self.assertEqual(result.trust_mode, "link_only")
        self.assertEqual(result.rule_id, "SG-P1-030_LINK_ONLY_ALLOWED")

    def test_g_unknown_rights(self):
        # G. Unknown rights => NEEDS_HUMAN_REVIEW
        evidence = self._base_evidence()
        evidence.rights_class = "unknown"
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")
        self.assertIsNone(result.trust_mode)
        self.assertIn("UNKNOWN_RIGHTS", result.blocking_conditions)

    def test_h_rights_unverified(self):
        # H. Rights statement exists but rights_verified=false => NEEDS_HUMAN_REVIEW
        evidence = self._base_evidence()
        evidence.rights_verified = False
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")
        self.assertIsNone(result.trust_mode)
        self.assertIn("RIGHTS_NOT_VERIFIED", result.blocking_conditions)

    def test_i_conflicting_rights(self):
        # I. Conflicting rights evidence => NEEDS_HUMAN_REVIEW
        evidence = self._base_evidence()
        evidence.conflicts = ["Found CC-BY but terms also say 'all rights reserved'"]
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")
        self.assertIsNone(result.trust_mode)
        self.assertIn("CONFLICTING_EVIDENCE", result.blocking_conditions)

    def test_j_scope_unverified(self):
        # J. scope_verified=false => NEEDS_HUMAN_REVIEW
        evidence = self._base_evidence()
        evidence.scope_verified = False
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")
        self.assertIsNone(result.trust_mode)
        self.assertEqual(result.rule_id, "SG-P1-002_SCOPE_UNRESOLVED")

    def test_k_hash_matches_but_rights_unverified(self):
        # K. Hash matches exactly but legal rights semantics are unverified => NEEDS_HUMAN_REVIEW
        evidence = self._base_evidence()
        evidence.rights_statement_hash_matches = True
        evidence.rights_verified = False
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")
        self.assertIsNone(result.trust_mode)

    def test_l_explicit_policy_incompatibility_reject(self):
        # L. Explicit verified policy incompatibility => REJECT (Driven by policy_incompatible fact)
        evidence = self._base_evidence()
        evidence.policy_incompatible = True
        evidence.incompatibility_codes = ["TERRAVELER_PROHIBITED_ARCHIVE"]
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "reject")
        self.assertIsNone(result.trust_mode)
        self.assertEqual(result.rule_id, "SG-P1-099_POLICY_INCOMPATIBLE")

    def test_m_unsupported_item_verifier(self):
        # M. Unsupported item verification strategy => NEEDS_HUMAN_REVIEW
        evidence = self._base_evidence()
        evidence.rights_class = "mixed"
        evidence.verification_strategy = "non_existent"
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")
        self.assertIn("UNSUPPORTED_VERIFIER", result.blocking_conditions)

    def test_n_reproducibility(self):
        # N. Same input + same policy version evaluated repeatedly => identical semantic PolicyEvaluation
        evidence = self._base_evidence()
        res1 = evaluate_source_policy(evidence)
        res2 = evaluate_source_policy(evidence)
        
        self.assertEqual(res1.decision_outcome, res2.decision_outcome)
        self.assertEqual(res1.trust_mode, res2.trust_mode)
        self.assertEqual(res1.rule_id, res2.rule_id)
        self.assertEqual(res1.evidence_snapshot, res2.evidence_snapshot)

    def test_o_archivist_confidence_change(self):
        # O. Changing only Archivist confidence/recommendation => MUST NOT change deterministic result
        self.assertFalse(hasattr(VerifiedEvidence, "llm_confidence"))
        self.assertFalse(hasattr(VerifiedEvidence, "recommended_trust_mode"))

    # -------------------------------------------------------------------------
    # Hardening & Regression Tests
    # -------------------------------------------------------------------------

    def test_item_verified_blocker_bypass_prevention_rights_unverified(self):
        # Mixed + archive_org_metadata + rights_verified=false => NEEDS_HUMAN_REVIEW (No bypass!)
        evidence = self._base_evidence()
        evidence.rights_class = "mixed"
        evidence.verification_strategy = "archive_org_metadata"
        evidence.rights_verified = False
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")
        self.assertIsNone(result.trust_mode)

    def test_item_verified_blocker_bypass_prevention_conflicts(self):
        # Mixed + archive_org_metadata + conflicts => NEEDS_HUMAN_REVIEW (No bypass!)
        evidence = self._base_evidence()
        evidence.rights_class = "mixed"
        evidence.verification_strategy = "archive_org_metadata"
        evidence.conflicts = ["Terms say Public Domain but also Restricted"]
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")
        self.assertIsNone(result.trust_mode)

    def test_item_verified_blocker_bypass_prevention_identity_unverified(self):
        # Mixed + archive_org_metadata + identity unverified => NEEDS_HUMAN_REVIEW (No bypass!)
        evidence = self._base_evidence()
        evidence.rights_class = "mixed"
        evidence.verification_strategy = "archive_org_metadata"
        evidence.endpoint_identity_verified = False
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")
        self.assertIsNone(result.trust_mode)

    def test_unsupported_policy_version_raises_error(self):
        evidence = self._base_evidence()
        with self.assertRaises(ValueError):
            evaluate_source_policy(evidence, policy_version="SOME_UNSUPPORTED_VERSION")

    def test_complete_evidence_snapshot(self):
        evidence = self._base_evidence()
        evidence.policy_incompatible = True
        evidence.incompatibility_codes = ["TEST"]
        result = evaluate_source_policy(evidence)
        
        snap = result.evidence_snapshot
        self.assertEqual(snap["assessment_id"], evidence.assessment_id)
        self.assertEqual(snap["verifier_version"], evidence.verifier_version)
        self.assertEqual(snap["policy_version"], "SG-P1")
        self.assertEqual(snap["rights_verified"], evidence.rights_verified)
        self.assertEqual(snap["scope_verified"], evidence.scope_verified)
        self.assertEqual(snap["access_verified"], evidence.access_verified)
        self.assertEqual(snap["policy_incompatible"], True)
        self.assertEqual(snap["incompatibility_codes"], ["TEST"])

    def test_canonicalize_evidence_and_hash_reproducibility(self):
        from policy_engine import canonicalize_evidence, compute_evidence_hash
        e1 = self._base_evidence()
        e2 = self._base_evidence()
        
        # Change dynamic metadata / timestamps on e2
        e2.assessment_id = 9999
        e2.verified_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)
        e2.verifier_version = "2.0-beta"
        
        # Assert that the canonical string and resulting SHA256 hashes are 100% identical and reproducible
        self.assertEqual(canonicalize_evidence(e1), canonicalize_evidence(e2))
        self.assertEqual(compute_evidence_hash(e1), compute_evidence_hash(e2))

    def test_produce_verified_evidence_boundary(self):
        from policy_engine import produce_verified_evidence, VerifierAssertion
        assessment = {
            "id": 42,
            "rights_class": "mixed",
            "rights_verified": True,
            "rights_scope_type": "endpoint",
            "rights_scope_identifier": "malicious-attacker.org",
            "access_verified": True,
            "verification_strategy": "prohibited",
            "conflicts": [],
            "evidence_sources": ["https://malicious-attacker.org/terms"]
        }
        
        assertions = [
            VerifierAssertion(
                code="SG-INC-003_INVALID_SOURCE_IDENTITY",
                verifier_id_version="identity_verifier/1.0", # Authorized!
                basis="Resolved IP is unverified.",
                source_evidence="Forbidden range",
                timestamp=datetime.datetime.now(datetime.timezone.utc)
            )
        ]
        
        evidence = produce_verified_evidence(assessment, assertions)
        self.assertEqual(evidence.assessment_id, 42)
        self.assertEqual(evidence.rights_class, "mixed")
        self.assertEqual(evidence.scope_type, "endpoint")
        self.assertEqual(evidence.scope_identifier, "malicious-attacker.org")
        self.assertTrue(evidence.policy_incompatible)
        self.assertNotIn("SG-INC-001_EXPLICIT_USE_PROHIBITION", evidence.incompatibility_codes) # No fallback!
        self.assertIn("SG-INC-003_INVALID_SOURCE_IDENTITY", evidence.incompatibility_codes)

    def test_produce_verified_evidence_fail_closed_on_incomplete_assessment(self):
        from policy_engine import produce_verified_evidence
        # An extremely bare assessment containing only id and rights_class
        assessment = {
            "id": 100
        }
        evidence = produce_verified_evidence(assessment)
        
        # Verify all verification metrics default to FALSE for safety (fail-closed!)
        self.assertFalse(evidence.institution_identity_verified)
        self.assertFalse(evidence.endpoint_identity_verified)
        self.assertFalse(evidence.rights_statement_retrieved)
        self.assertFalse(evidence.rights_statement_hash_matches)
        self.assertFalse(evidence.rights_verified)
        self.assertFalse(evidence.scope_verified)
        self.assertFalse(evidence.access_verified)
        
        # Result of evaluation under fail-closed defaults must be REVIEW
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")

    def test_403_network_block_not_policy_incompatible(self):
        from policy_engine import produce_verified_evidence
        assessment = {
            "id": 101,
            "access_verified": False, # Mock network block
            "rights_class": "unknown",
            "conflicts": ["Forbidden Access"]
        }
        evidence = produce_verified_evidence(assessment)
        
        # A network block/forbidden access does NOT by itself produce policy_incompatible=True.
        # It is categorized as needs_human_review / insufficient evidence
        self.assertFalse(evidence.policy_incompatible)
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review")

    def test_verification_strategy_prohibited_alone_does_not_reject(self):
        from policy_engine import produce_verified_evidence
        # assessment strategy="prohibited" alone must NOT set policy_incompatible=True without assertion!
        assessment = {
            "id": 102,
            "verification_strategy": "prohibited"
        }
        evidence = produce_verified_evidence(assessment)
        self.assertFalse(evidence.policy_incompatible)
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "needs_human_review") # Bypasses reject, goes to REVIEW!

    def test_verified_explicit_incompatibility(self):
        from policy_engine import produce_verified_evidence, VerifierAssertion
        assessment = {
            "id": 102
        }
        assertion = VerifierAssertion(
            code="SG-INC-001_EXPLICIT_USE_PROHIBITION",
            verifier_id_version="rights_scanner/1.0", # Authorized!
            basis="Explicit use prohibition.",
            source_evidence="No commercial harvesting",
            timestamp=datetime.datetime.now(datetime.timezone.utc)
        )
        evidence = produce_verified_evidence(assessment, [assertion])
        self.assertTrue(evidence.policy_incompatible)
        self.assertIn("SG-INC-001_EXPLICIT_USE_PROHIBITION", evidence.incompatibility_codes)
        
        result = evaluate_source_policy(evidence)
        self.assertEqual(result.decision_outcome, "reject")

    def test_canonicalize_policy_evaluation_and_hash_reproducibility(self):
        from policy_engine import canonicalize_policy_evaluation, compute_policy_evaluation_hash
        evidence = self._base_evidence()
        result = evaluate_source_policy(evidence)
        
        # Hash must be perfectly stable and identical for same parameters
        h1 = compute_policy_evaluation_hash(result, "endpoint", 42, 100)
        h2 = compute_policy_evaluation_hash(result, "endpoint", 42, 100)
        self.assertEqual(h1, h2)

    def test_policy_evaluation_hash_changes_with_rule_or_trust_mode(self):
        from policy_engine import compute_policy_evaluation_hash
        evidence = self._base_evidence()
        r1 = evaluate_source_policy(evidence)
        
        h1 = compute_policy_evaluation_hash(r1, "endpoint", 42, 100)
        
        # Change rule_id
        r2 = evaluate_source_policy(evidence)
        r2.rule_id = "SG-P1-SOME_OTHER_RULE"
        h2 = compute_policy_evaluation_hash(r2, "endpoint", 42, 100)
        
        # Change trust_mode
        r3 = evaluate_source_policy(evidence)
        r3.trust_mode = "item_verified"
        h3 = compute_policy_evaluation_hash(r3, "endpoint", 42, 100)
        
        self.assertNotEqual(h1, h2)
        self.assertNotEqual(h1, h3)

    def test_coexistence_of_identical_evidence_on_different_subjects(self):
        from policy_engine import compute_evidence_hash
        # Option A: same evidence facts, different subjects must have distinct row contexts (coexist correctly)
        e1 = self._base_evidence()
        e1.subject_type = "endpoint"
        e1.subject_id = 1
        
        e2 = self._base_evidence()
        e2.subject_type = "endpoint"
        e2.subject_id = 2
        
        h1 = compute_evidence_hash(e1)
        h2 = compute_evidence_hash(e2)
        
        # They coexist safely because subject properties make their canonical forms (and hashes) distinct
        self.assertNotEqual(h1, h2)

    def test_assertion_type_verification(self):
        from policy_engine import produce_verified_evidence, VerifierAssertion
        
        # Authorized verifier assertion is accepted
        assertion = VerifierAssertion(
            code="SG-INC-001_EXPLICIT_USE_PROHIBITION",
            verifier_id_version="license_scanner/1.0", # Authorized!
            basis="Explicit prohibition phrasing found in terms page.",
            source_evidence="No commercial use permitted",
            timestamp=datetime.datetime.now(datetime.timezone.utc)
        )
        
        evidence = produce_verified_evidence({"id": 103}, [assertion])
        self.assertTrue(evidence.policy_incompatible)
        self.assertIn("SG-INC-001_EXPLICIT_USE_PROHIBITION", evidence.incompatibility_codes)
        
        # Arbitrary dictionary is ignored
        evidence_ignored = produce_verified_evidence({"id": 104}, ["not-an-assertion-class"])
        self.assertFalse(evidence_ignored.policy_incompatible)

    def test_persist_source_policy_evaluation_reproducibility(self):
        from policy_engine import persist_source_policy_evaluation
        
        # Mock database cursor to simulate retrieving a verified evidence row
        class MockCursor:
            def __init__(self):
                self.writes = []
                self.fixed_time = datetime.datetime(2026, 9, 12, 12, 0, 0, tzinfo=datetime.timezone.utc)
            def execute(self, query, params=None):
                self.writes.append((query, params))
            def fetchone(self):
                # Return static, identical data matching source_verified_evidence schema
                query_str = self.writes[-1][0].lower()
                if "select" in query_str:
                    return {
                        "id": 100,
                        "assessment_id": 42,
                        "proposal_id": None,
                        "subject_type": "endpoint",
                        "subject_id": 1,
                        "verified_at": self.fixed_time,
                        "verifier_version": "1.0",
                        "institution_identity_verified": True,
                        "endpoint_identity_verified": True,
                        "rights_statement_retrieved": True,
                        "rights_statement_hash_matches": True,
                        "rights_verified": True,
                        "rights_class": "public_domain",
                        "rights_identifier": "PD",
                        "rights_uri": None,
                        "scope_verified": True,
                        "scope_type": "endpoint",
                        "scope_identifier": "example.org",
                        "access_verified": True,
                        "verification_strategy": "none",
                        "conflicts": [],
                        "evidence_sources": ["https://example.org/terms"],
                        "canonical_host": "example.org",
                        "collection_identifier": "",
                        "reverification_generation": 0,
                        "policy_incompatible": False,
                        "incompatibility_codes": []
                    }
                elif "insert" in query_str:
                    return {"id": 1}
                return None

        # Execute once
        cur1 = MockCursor()
        persist_source_policy_evaluation(cur1, 100)
        
        # Execute twice
        cur2 = MockCursor()
        persist_source_policy_evaluation(cur2, 100)
        
        # Assert that the SQL inserts, parameter snapshots and calculated evaluation_hash are exactly identical and reproducible!
        insert_query_1, params_1 = [w for w in cur1.writes if "INSERT" in w[0].upper()][0]
        insert_query_2, params_2 = [w for w in cur2.writes if "INSERT" in w[0].upper()][0]
        
        self.assertEqual(params_1[-1], params_2[-1])
        self.assertEqual(params_1, params_2)

    # -------------------------------------------------------------------------
    # Phase 3B.3 Drift & Reverification Tests
    # -------------------------------------------------------------------------

    def test_classify_material_drift_no_drift(self):
        from policy_engine import classify_material_drift
        prev_ev = self._base_evidence()
        new_ev = self._base_evidence()
        
        res = classify_material_drift(prev_ev, new_ev, previous_decision={})
        self.assertFalse(res.drift_detected)
        self.assertEqual(res.drift_class, "NO_DRIFT")
        self.assertEqual(res.recommended_action, "KEEP_ACTIVE")

    def test_classify_material_drift_non_material_change(self):
        from policy_engine import classify_material_drift
        prev_ev = self._base_evidence()
        new_ev = self._base_evidence()
        
        # Change dynamic fields/prose that are non-material (e.g. verified_at, evidence_sources)
        new_ev.verified_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)
        new_ev.evidence_sources = ["https://example.org/new_terms_page_but_same_license"]
        
        res = classify_material_drift(prev_ev, new_ev, previous_decision={})
        self.assertFalse(res.drift_detected)
        self.assertEqual(res.drift_class, "NO_DRIFT")
        self.assertEqual(res.recommended_action, "KEEP_ACTIVE")

    def test_classify_material_drift_material_rights_change(self):
        from policy_engine import classify_material_drift
        prev_ev = self._base_evidence()
        new_ev = self._base_evidence()
        
        # Change trust-relevant licence URI (material rights drift)
        new_ev.rights_uri = "https://creativecommons.org/licenses/by-nc/4.0/"
        
        res = classify_material_drift(prev_ev, new_ev, previous_decision={})
        self.assertTrue(res.drift_detected)
        self.assertEqual(res.drift_class, "MATERIAL_RIGHTS_DRIFT")
        self.assertIn("SG-DRIFT-002_RIGHTS_URI_CHANGED", res.drift_codes)
        self.assertEqual(res.recommended_action, "QUARANTINE_AND_REEVALUATE")

    def test_classify_material_drift_material_prohibition(self):
        from policy_engine import classify_material_drift
        prev_ev = self._base_evidence()
        new_ev = self._base_evidence()
        
        # Express explicit use prohibition (material rights drift)
        new_ev.policy_incompatible = True
        
        res = classify_material_drift(prev_ev, new_ev, previous_decision={})
        self.assertTrue(res.drift_detected)
        self.assertEqual(res.drift_class, "MATERIAL_RIGHTS_DRIFT")
        self.assertIn("SG-DRIFT-013_TERMS_PROHIBITION_DETECTED", res.drift_codes)
        self.assertEqual(res.recommended_action, "QUARANTINE_AND_REEVALUATE")

    def test_classify_material_drift_first_transient_failure(self):
        from policy_engine import classify_material_drift
        prev_ev = self._base_evidence()
        new_ev = self._base_evidence()
        
        # Simulate one temporary access failure
        new_ev.access_verified = False
        
        res = classify_material_drift(prev_ev, new_ev, previous_decision={}, policy_context={"access_failure_count": 1})
        # Transient failure remains active (KEEP_ACTIVE), does not quarantine immediately
        self.assertTrue(res.drift_detected)
        self.assertEqual(res.drift_class, "NON_MATERIAL_DRIFT")
        self.assertIn("SG-DRIFT-099_UNRESOLVED_CHANGE", res.drift_codes)
        self.assertIn("TRANSIENT_OPERATIONAL_FAILURE_OBSERVED", res.reason_codes)
        self.assertEqual(res.recommended_action, "KEEP_ACTIVE")

    def test_classify_material_drift_persistent_failure_threshold(self):
        from policy_engine import classify_material_drift
        prev_ev = self._base_evidence()
        new_ev = self._base_evidence()
        
        # Simulate repeated access failures crossing threshold (3 retries)
        new_ev.access_verified = False
        
        res = classify_material_drift(prev_ev, new_ev, previous_decision={}, policy_context={"access_failure_count": 3})
        # Over threshold triggers unresolved drift and QUARANTINE!
        self.assertTrue(res.drift_detected)
        self.assertEqual(res.drift_class, "UNRESOLVED_DRIFT")
        self.assertEqual(res.recommended_action, "QUARANTINE_AND_REEVALUATE")

    def test_material_fingerprint_is_deterministic(self):
        from policy_engine import compute_material_fingerprint
        e1 = self._base_evidence()
        e2 = self._base_evidence()
        
        # Random IDs, timestamps, formatting do NOT affect fingerprint hash
        e2.assessment_id = 98765
        e2.verified_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=10)
        e2.evidence_sources = ["https://different-source-evidence-sources"]
        
        h1 = compute_material_fingerprint(e1)
        h2 = compute_material_fingerprint(e2)
        self.assertEqual(h1, h2)


if __name__ == "__main__":
    unittest.main()
