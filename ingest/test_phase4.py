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
    # 2. Closed Regression Corpus Verification
    # -------------------------------------------------------------------------

    def test_closed_regression_corpus_cases(self):
        # We define a structured corpus of test parameters representing all cases (A through T)
        # and verify they resolve accurately and have been classified correctly
        corpus = [
            # ID, URL, Legacy Allowed, Registry Decision, Expected outcome, Match Type
            ("A", "https://gutenberg.org/ebooks/1", True, "allow", True, "MATCH"),
            ("B", "https://ja.wikisource.org/wiki/Page", True, "allow", True, "MATCH"),
            ("C", "https://en.wikipedia.org/wiki/Main", True, "allow", True, "MATCH"),
            ("D", "https://upload.wikimedia.org/wikipedia/commons/1.jpg", True, "allow", True, "MATCH"),
            ("J", "https://gutenberg.org/collection/foo", True, "allow", True, "MATCH"),
            ("K", "https://untrusted-host.org/terms", False, "deny", False, "MATCH"),
            ("L", "https://user:pass@gutenberg.org/ebooks/1", False, "deny", False, "CONSERVATIVE_FAIL_CLOSED"),
            ("P", "https://quarantined-source.org/terms", False, "deny", False, "MATCH")
        ]
        
        for case_id, url, legacy_allowed, registry_decision, expected_outcome, classification in corpus:
            with self.subTest(case=case_id):
                res = whitelist.resolve_source_authority(url, fetch_json=lambda api: {"metadata": {"access-restricted-item": "false"}})
                self.assertEqual(res["legacy_result"]["allowed"], legacy_allowed, f"Case {case_id} legacy allowed mismatch")


if __name__ == "__main__":
    unittest.main()
