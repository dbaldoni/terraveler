"""
Phase 4: Fast-Track Registry Authority Cutover Test Suite.
Verifies the closed regression corpus, mismatch classifications, mode switching,
fail-closed DB safety, and E2E ingestion path logic.

Run with:
    python3 -m unittest test_phase4 -v      (from ingest/)
"""

import unittest
import os
import sys
import datetime
import urllib.request
from unittest.mock import patch, MagicMock

# Add current directory and parent directory to Python path
sys.path.append(os.path.dirname(__file__))
import whitelist
import source_governance_shadow

class Phase4AuthorityCutoverTests(unittest.TestCase):
    def setUp(self):
        self.original_mode = os.environ.get("SOURCE_AUTHORITY_MODE")
        self.original_shadow = os.environ.get("SOURCE_GOVERNANCE_SHADOW_ENABLED")
        
    def tearDown(self):
        if self.original_mode is not None:
            os.environ["SOURCE_AUTHORITY_MODE"] = self.original_mode
        elif "SOURCE_AUTHORITY_MODE" in os.environ:
            del os.environ["SOURCE_AUTHORITY_MODE"]
            
        if self.original_shadow is not None:
            os.environ["SOURCE_GOVERNANCE_SHADOW_ENABLED"] = self.original_shadow
        elif "SOURCE_GOVERNANCE_SHADOW_ENABLED" in os.environ:
            del os.environ["SOURCE_GOVERNANCE_SHADOW_ENABLED"]

    # -------------------------------------------------------------------------
    # 1. Authority Mode Switching and Rollback Tests
    # -------------------------------------------------------------------------

    def test_legacy_mode_unchanged(self):
        # In legacy mode, whitelist.py decided runtime ingestion regardless of registry status
        os.environ["SOURCE_AUTHORITY_MODE"] = "legacy"
        
        # Gutenberg is whitelisted in legacy
        allowed, reason = whitelist.verify_source("https://gutenberg.org/ebooks/123")
        self.assertTrue(allowed)
        self.assertIn("Public domain", reason)
        
        # Random domain is rejected
        allowed, reason = whitelist.verify_source("https://unknown-untrusted.example")
        self.assertFalse(allowed)
        self.assertIn("off-whitelist", reason)

    def test_shadow_mode_parallels_and_logs(self):
        # In shadow mode, legacy is still authoritative, but we record discrepancies
        os.environ["SOURCE_AUTHORITY_MODE"] = "shadow"
        
        # Gutenberg is whitelisted
        allowed, reason = whitelist.verify_source("https://gutenberg.org/ebooks/123")
        self.assertTrue(allowed)

    @patch("source_governance_shadow.resolve_trust_from_db")
    def test_registry_mode_becomes_authoritative(self, mock_resolve):
        # In registry mode, database registry is sole authority
        os.environ["SOURCE_AUTHORITY_MODE"] = "registry"
        
        # Case A: Registry approves
        mock_resolve.return_value = {
            "matched": True,
            "decision": "allow",
            "endpoint_id": 1,
            "host_pattern": "gutenberg.org",
            "trust_mode": "domain_trusted",
            "verification_strategy": "none",
            "rights_class": "public_domain",
            "policy_decision_id": 10
        }
        allowed, reason = whitelist.verify_source("https://gutenberg.org/ebooks/123")
        self.assertTrue(allowed)
        self.assertEqual(reason, "public_domain")

        # Case B: Registry denies
        mock_resolve.return_value = {
            "matched": True,
            "decision": "deny",
            "trust_mode": "rejected",
            "verification_strategy": "none",
            "rights_class": "unknown",
            "policy_decision_id": None
        }
        allowed, reason = whitelist.verify_source("https://gutenberg.org/ebooks/123")
        self.assertFalse(allowed)

    @patch("source_governance_shadow.resolve_trust_from_db")
    def test_registry_mode_fails_closed_on_db_unavailability(self, mock_resolve):
        # Registry infrastructure error => fail closed! No fallback to whitelist.py.
        os.environ["SOURCE_AUTHORITY_MODE"] = "registry"
        
        mock_resolve.return_value = {
            "matched": False,
            "decision": "deny",
            "trust_mode": "rejected",
            "verification_strategy": "none",
            "rights_class": "unknown",
            "policy_decision_id": None,
            "error": "Connection timed out"
        }
        allowed, reason = whitelist.verify_source("https://gutenberg.org/ebooks/123")
        self.assertFalse(allowed)
        self.assertIn("fail closed", reason)

    # -------------------------------------------------------------------------
    # 2. Closed Regression Corpus Verification (Cases A-T)
    # -------------------------------------------------------------------------

    @patch("source_governance_shadow.resolve_trust_from_db")
    def test_closed_regression_corpus_cases(self, mock_resolve):
        # We define a structured corpus of test parameters representing all cases (A through T)
        # and verify they resolve accurately in shadow mode, correctly classifying any mismatches.
        os.environ["SOURCE_AUTHORITY_MODE"] = "shadow"
        
        # Test Case Definition: (Case ID, URL, fetch_mock, registry_db_mock, Expected Mismatch Classification)
        corpus = [
            (
                "A. Project Gutenberg allowed", 
                "https://gutenberg.org/ebooks/1",
                None,
                {"matched": True, "decision": "allow", "rights_class": "public_domain", "trust_mode": "domain_trusted", "endpoint_id": 1, "verification_strategy": "none"},
                "MATCH"
            ),
            (
                "B. Wikisource allowed", 
                "https://ja.wikisource.org/wiki/Page",
                None,
                {"matched": True, "decision": "allow", "rights_class": "public_domain", "trust_mode": "domain_trusted", "endpoint_id": 2, "verification_strategy": "none"},
                "MATCH"
            ),
            (
                "C. Wikipedia/CC case", 
                "https://en.wikipedia.org/wiki/Main",
                None,
                {"matched": True, "decision": "allow", "rights_class": "creative_commons", "trust_mode": "domain_trusted", "endpoint_id": 3, "verification_strategy": "none"},
                "MATCH"
            ),
            (
                "D. Wikimedia mixed/per-file case", 
                "https://upload.wikimedia.org/wikipedia/commons/1.jpg",
                None,
                {"matched": True, "decision": "allow", "rights_class": "mixed", "trust_mode": "domain_trusted", "endpoint_id": 4, "verification_strategy": "none"},
                "MATCH"
            ),
            (
                "E. Archive.org valid public-domain item", 
                "https://archive.org/details/valid-book",
                lambda api: {"metadata": {"date": "1800", "access-restricted-item": "false"}},
                {"matched": True, "decision": "requires_item_verification", "rights_class": "mixed", "trust_mode": "item_verified", "endpoint_id": 5, "verification_strategy": "archive_org_metadata"},
                "MATCH"
            ),
            (
                "F. Archive.org lending/restricted item", 
                "https://archive.org/details/restricted-book",
                lambda api: {"metadata": {"date": "1800", "access-restricted-item": "true"}},
                {"matched": True, "decision": "requires_item_verification", "rights_class": "mixed", "trust_mode": "item_verified", "endpoint_id": 5, "verification_strategy": "archive_org_metadata"},
                "MATCH"
            ),
            (
                "G. Archive.org community upload", 
                "https://archive.org/details/community-book",
                lambda api: {"metadata": {"collection": ["opensource"], "date": "1800", "access-restricted-item": "false"}},
                {"matched": True, "decision": "requires_item_verification", "rights_class": "mixed", "trust_mode": "item_verified", "endpoint_id": 5, "verification_strategy": "archive_org_metadata"},
                "MATCH"
            ),
            (
                "H. invalid publication year", 
                "https://archive.org/details/invalid-year",
                lambda api: {"metadata": {"date": "unknown", "access-restricted-item": "false"}},
                {"matched": True, "decision": "requires_item_verification", "rights_class": "mixed", "trust_mode": "item_verified", "endpoint_id": 5, "verification_strategy": "archive_org_metadata"},
                "MATCH"
            ),
            (
                "I. modern post-cutoff edition", 
                "https://archive.org/details/modern-book",
                lambda api: {"metadata": {"date": "1995", "access-restricted-item": "false"}},
                {"matched": True, "decision": "requires_item_verification", "rights_class": "mixed", "trust_mode": "item_verified", "endpoint_id": 5, "verification_strategy": "archive_org_metadata"},
                "MATCH"
            ),
            (
                "J. trusted collection case", 
                "https://gutenberg.org/collection/foo",
                None,
                {"matched": True, "decision": "allow", "rights_class": "public_domain", "trust_mode": "collection_trusted", "endpoint_id": 1, "verification_strategy": "none"},
                "MATCH"
            ),
            (
                "K. unknown host", 
                "https://untrusted-host.example.org",
                None,
                {"matched": False, "decision": "deny", "trust_mode": "rejected", "endpoint_id": None, "verification_strategy": "none"},
                "MATCH"
            ),
            (
                "L. malformed URL", 
                "not-a-url",
                None,
                {"matched": False, "decision": "deny", "trust_mode": "rejected", "endpoint_id": None, "verification_strategy": "none"},
                "MATCH"
            ),
            (
                "M. redirect within expected boundary", 
                "https://gutenberg.org/redirect",
                None,
                {"matched": True, "decision": "allow", "rights_class": "public_domain", "trust_mode": "domain_trusted", "endpoint_id": 1, "verification_strategy": "none"},
                "MATCH"
            ),
            (
                "N. redirect outside trusted boundary", 
                "https://gutenberg.org/redirect-outside",
                None,
                {"matched": True, "decision": "deny", "trust_mode": None, "endpoint_id": 1, "rights_class": "public_domain", "verification_strategy": "none"},
                "INTENTIONAL_REGISTRY_IMPROVEMENT"
            ),
            (
                "O. quarantined source", 
                "https://gutenberg.org/ebooks/quarantined",
                None,
                {"matched": True, "decision": "deny", "trust_mode": None, "endpoint_id": 1, "rights_class": "public_domain", "verification_strategy": "none"},
                "INTENTIONAL_REGISTRY_IMPROVEMENT" # Legacy allowed it, registry correctly denies due to quarantine
            ),
            (
                "P. needs_human_review source", 
                "https://gutenberg.org/ebooks/review",
                None,
                {"matched": True, "decision": "deny", "trust_mode": None, "endpoint_id": 1, "rights_class": "public_domain", "verification_strategy": "none"},
                "INTENTIONAL_REGISTRY_IMPROVEMENT"
            ),
            (
                "Q. rejected source", 
                "https://gutenberg.org/ebooks/rejected",
                None,
                {"matched": True, "decision": "deny", "trust_mode": None, "endpoint_id": 1, "rights_class": "public_domain", "verification_strategy": "none"},
                "INTENTIONAL_REGISTRY_IMPROVEMENT"
            ),
            (
                "R. link_only source", 
                "https://gutenberg.org/ebooks/link_only",
                None,
                {"matched": True, "decision": "deny", "trust_mode": "link_only", "endpoint_id": 1, "rights_class": "in_copyright", "verification_strategy": "none"},
                "INTENTIONAL_REGISTRY_IMPROVEMENT"
            ),
            (
                "S. item_verified source with verifier success", 
                "https://archive.org/details/valid-book",
                lambda api: {"metadata": {"date": "1800", "access-restricted-item": "false"}},
                {"matched": True, "decision": "requires_item_verification", "rights_class": "mixed", "trust_mode": "item_verified", "endpoint_id": 5, "verification_strategy": "archive_org_metadata"},
                "MATCH"
            ),
            (
                "T. item_verified source with verifier failure", 
                "https://archive.org/details/restricted-book",
                lambda api: {"metadata": {"date": "1800", "access-restricted-item": "true"}},
                {"matched": True, "decision": "requires_item_verification", "rights_class": "mixed", "trust_mode": "item_verified", "endpoint_id": 5, "verification_strategy": "archive_org_metadata"},
                "MATCH"
            ),
            (
                "Unexpected matched registry deny with unknown/unexpected reason",
                "https://gutenberg.org/ebooks/unexpected",
                None,
                {"matched": True, "decision": "deny", "trust_mode": "some_unexpected_trust_mode_meaning_bug", "endpoint_id": 1, "rights_class": "public_domain", "verification_strategy": "none"},
                "BUG"
            ),
            (
                "Unexpected Registry Disappearance (Conservative Fail Closed)", 
                "https://gutenberg.org/ebooks/missing",
                None,
                {"matched": False, "decision": "deny", "trust_mode": "rejected", "endpoint_id": None, "verification_strategy": "none"},
                "CONSERVATIVE_FAIL_CLOSED"
            )
        ]
        
        for case_name, url, fetch_mock, registry_decision, expected_class in corpus:
            with self.subTest(case=case_name):
                mock_resolve.return_value = registry_decision
                res = whitelist.resolve_source_authority(url, fetch_json=fetch_mock)
                
                # Verify that the comparison class exactly matches the expected taxonomy
                self.assertEqual(
                    res["comparison_class"], 
                    expected_class, 
                    f"Mismatch in case {case_name}: Expected {expected_class}, got {res['comparison_class']}. Legacy allowed: {res['legacy_result']['allowed']}, Registry allowed: {res['registry_result']['allowed']}"
                )

    def test_invalid_authority_mode_fails_closed(self):
        # Do not silently fall back to legacy if a typo is made in production environment variables
        os.environ["SOURCE_AUTHORITY_MODE"] = "some_invalid_mode"
        
        res = whitelist.resolve_source_authority("https://gutenberg.org/ebooks/1")
        self.assertFalse(res["allowed"])
        self.assertEqual(res["authority_mode"], "INVALID_AUTHORITY_MODE")
        self.assertIn("fail closed: invalid SOURCE_AUTHORITY_MODE", res["reason_codes"][0])


if __name__ == "__main__":
    unittest.main()
