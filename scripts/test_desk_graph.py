#!/usr/bin/env python3
"""The Curator's verdict graph, and the trace it is only worth as much as.

    python3 -m unittest test_desk_graph -v          (from scripts/)

No database and no network. Every outside read is stubbed with something
deterministic and derived from its input, which is what makes the assertions
mean anything: the run below is the run production performs, minus the two
places it reaches out.

The test that matters is `TamperedTrace`. Everything else here checks that the
pass rules the way it always ruled; that one checks that the evidence it leaves
is evidence — that altering a recorded value makes the trace fail its own
validator, by name. A trace nobody can refute is a log.
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "ingest"))

from vitruvyan_motus import JsonlTraceSink, Policy         # noqa: E402

import desk_checks as K                                    # noqa: E402
import desk_graph as G                                     # noqa: E402


# ------------------------------------------------------------- the stub world

# A source whose text is fixed, and a draft that quotes it three ways: exactly
# (verbatim), nearly (transcribed by a scribe — the failure Carta 3.4 exists
# for), and not at all (fabricated).
SOURCE_TEXT = (
    "The Voyage began upon the fourteenth day, and we stood out to sea with a "
    "fair wind.\n\nI have never seen the like of that coast, nor do I expect "
    "to see it again.\n\nWe came at length to the river, and there we halted."
)
VERBATIM = "I have never seen the like of that coast"
# Retyped by a scribe: different case, and it still VERIFIES — which is the
# design and not a hole. `locate_in_source` folds case to find the passage and
# then copies the source's own span out, so what gets published is the page's
# capitalisation and never the quoter's. The mismatch branch is exercised
# directly in `TheMismatchBranch` below, where it can be shown rather than
# hoped for.
RETYPED = "i have never seen the like of that Coast"
FABRICATED = "we discovered a city of gold beyond the mountains"

SOURCE_URL = "https://www.gutenberg.org/files/12345/12345-0.txt"

PAYLOAD = {
    "meta": {"carta_version": "0.7"},
    "voyage": {"evidence_basis": "contemporary-journal",
               "what_was_lost": "The second volume of the journal burned in 1812."},
    "waypoints": [
        {"seq": 1, "confidence": "certain", "arrival_date": "1766-05-01",
         "claims": [{"evidence": {"quote": VERBATIM, "source_url": SOURCE_URL}}]},
        {"seq": 2, "confidence": "approximate", "arrival_date": "1766-06-01",
         "claims": [{"evidence": {"quote": RETYPED, "source_url": SOURCE_URL}}]},
        {"seq": 3, "confidence": "certain", "arrival_date": "1766-07-01",
         "claims": [{"evidence": {"quote": FABRICATED, "source_url": SOURCE_URL}}]},
    ],
}

ROW = {"id": 42, "type": "new-voyage", "target_voyage": "boudeuse-1766",
       "status": "peer-review"}


class StubCursor:
    """Just enough of psycopg2 to let the recording nodes write, and to say
    afterwards what they wrote."""

    def __init__(self, world):
        self.world = world
        self.rowcount = 0
        self._rows: list = []

    def execute(self, sql, params=()):
        s = " ".join(sql.split()).lower()
        self._rows = []
        if s.startswith("select r.verdict, r.reviewer_id"):
            self._rows = list(self.world["reviewer_rows"])
        elif s.startswith("select count(*) from reviews r2 join submissions s1"):
            self._rows = [(1 if self.world["ring_detected"] else 0,)]
        elif s.startswith("update submissions set status"):
            self.rowcount = 0 if self.world["superseded"] else 1
            if self.rowcount:
                self.world["status"] = params[0]
        elif s.startswith("select payload from submissions"):
            self._rows = [{"payload": self.world["payload"]}]
        elif s.startswith("insert into verified_spans"):
            self.world["spans_written"] = params[1].adapted
        elif s.startswith("insert into audit_log"):
            self.world["audit"] = {"actor": params[1], "action": params[2],
                                   "verdict": params[3],
                                   "findings": params[4].adapted}
        else:                                       # pragma: no cover
            raise AssertionError(f"unexpected statement: {s[:80]}")

    def fetchall(self): return list(self._rows)
    def fetchone(self): return self._rows[0] if self._rows else None
    def __enter__(self): return self
    def __exit__(self, *exc): return False


class StubConnection:
    def __init__(self, world): self.world = world
    def cursor(self, **kw): return StubCursor(self.world)
    def commit(self): self.world["commits"] = self.world.get("commits", 0) + 1
    def rollback(self): self.world["rollbacks"] = self.world.get("rollbacks", 0) + 1
    def close(self): pass
    def __enter__(self): return self
    def __exit__(self, *exc): return False


class Stubbed:
    """Point the graph at the stub world. Both pipelines through this module —
    the assertions and the tamper test — see the same one."""

    def __init__(self, *, payload=PAYLOAD, dossier=("support", "support"),
                 reviewer_rows=None, ring_detected=False,
                 superseded=False, unreachable=False, dry_run=False):
        dossier = list(dossier)
        if reviewer_rows is None:
            # Established Scribes by default: thirty days old at review time
            # and five reviews behind them — every existing test that does not
            # care about reviewer identity keeps the answer it always got.
            # Row shape mirrors the real query: (verdict, reviewer_id, rank,
            # age_at_review_seconds, prior_reviews).
            reviewer_rows = [(v, 100 + i, "scribe", 30 * 24 * 3600, 5)
                             for i, v in enumerate(dossier)]
        self.world = {"payload": payload, "dossier": dossier,
                      "reviewer_rows": reviewer_rows, "ring_detected": ring_detected,
                      "superseded": superseded, "status": ROW["status"],
                      "spans_written": None, "audit": None}
        self.unreachable = unreachable
        self.dry_run = dry_run
        self.saved = {}

    def __enter__(self):
        world = self.world

        def _payload(cfg, sid):
            p = world["payload"]
            return (p, G.digest(p), dict(ROW, status=world["status"])) if p else (None, G.digest(None), {})

        def _fetch(cfg, url):
            if self.unreachable:
                raise TimeoutError("the archive did not answer")
            return SOURCE_TEXT

        for name, value in (("_payload", _payload), ("fetch", _fetch)):
            self.saved[name] = getattr(G, name)
            setattr(G, name, value)
        self.cfg = G.DeskConfig(pg={}, carta="0.7", dry_run=self.dry_run)
        object.__setattr__(self.cfg, "connect", lambda: StubConnection(world))
        return self

    def __exit__(self, *exc):
        for name, value in self.saved.items():
            setattr(G, name, value)
        return False


def run(stub, sid=42, sink=None):
    return G.run_desk(stub.cfg, sid, run_id=f"verdict-{sid}-test", sink=sink,
                      policy=Policy.EXPLORATION)


def trace_file(stub, sid=42):
    """One real run, written out as the canonical JSONL a validator reads."""
    d = tempfile.mkdtemp()
    sink = JsonlTraceSink(d)
    result = run(stub, sid, sink=sink)
    path = next(p for p in pathlib.Path(d).iterdir() if p.suffix == ".jsonl")
    return result, path


def validate(path, *, spec=None):
    cmd = [sys.executable, "-m", "vitruvyan_motus.contract.validate", "jsonl", str(path)]
    if spec:
        cmd += ["--spec", str(spec)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr)


# ------------------------------------------------------------------ the pass

class Verdicts(unittest.TestCase):

    def test_a_draft_with_a_fabricated_quotation_is_sent_back(self):
        with Stubbed() as s:
            result = run(s)
        self.assertEqual(result.state.decision("verdict"), "changes")
        stats = result.state.fact("stats")
        self.assertEqual(stats["quoted"], 3)
        # Two located in the source — including the one a scribe retyped, whose
        # published text will be the source's span and not the scribe's.
        self.assertEqual(stats["verified"], 2)
        self.assertEqual(stats["absent"], 1)         # the invented one
        self.assertEqual(stats["mismatched"], 0)

    def test_a_clean_draft_with_a_full_dossier_is_approved(self):
        payload = {**PAYLOAD, "waypoints": PAYLOAD["waypoints"][:1]}
        with Stubbed(payload=payload) as s:
            result = run(s)
        self.assertEqual(result.state.decision("verdict"), "approve")
        self.assertEqual(s.world["status"], "approved")
        self.assertEqual(s.world["audit"]["action"], "verdict")
        self.assertEqual(s.world["audit"]["actor"], "curator-desk")

    def test_a_short_dossier_turns_an_approval_into_an_escalation(self):
        """Carta §10.4, and the reason the dossier is read before the verdict
        rather than after it."""
        payload = {**PAYLOAD, "waypoints": PAYLOAD["waypoints"][:1]}
        with Stubbed(payload=payload, dossier=("support",)) as s:
            result = run(s)
        self.assertEqual(result.state.decision("verdict"), "escalate")
        self.assertEqual(s.world["status"], "peer-review")   # it did not move
        self.assertEqual(s.world["audit"]["action"], "review")

    def test_a_dossier_of_fresh_accounts_with_no_history_is_escalated(self):
        """The review-ring hardening probe: a long, unanimous dossier is
        exactly what a ring of freshly self-enrolled accounts produces too,
        and REVIEWS_TO_ADVANCE alone cannot tell the two apart."""
        payload = {**PAYLOAD, "waypoints": PAYLOAD["waypoints"][:1]}
        fresh = [("support", 1, "cabin-boy", 90, 0), ("support", 2, "cabin-boy", 45, 0)]
        with Stubbed(payload=payload, dossier=("support", "support"),
                    reviewer_rows=fresh) as s:
            result = run(s)
        self.assertEqual(result.state.decision("verdict"), "escalate")
        self.assertEqual(s.world["status"], "peer-review")
        self.assertIn("freshly-enrolled", result.state.fact("verdict_reason"))

    def test_the_actual_review_ring_shape_is_caught(self):
        """Pinned from a real run: three agents self-enrolled, each reviewed
        two of the others' drafts, and by a reviewer's second review it
        already had one prior review to its name — a strict prior_reviews==0
        check would have missed exactly the ring it exists to catch."""
        payload = {**PAYLOAD, "waypoints": PAYLOAD["waypoints"][:1]}
        ring_shape = [("support", 42, "cabin-boy", 109.8, 1), ("support", 43, "cabin-boy", 110.0, 1)]
        with Stubbed(payload=payload, dossier=("support", "support"),
                    reviewer_rows=ring_shape) as s:
            result = run(s)
        self.assertEqual(result.state.decision("verdict"), "escalate")

    def test_one_established_reviewer_is_enough_to_avoid_the_fresh_escalation(self):
        """The signal is about the WHOLE dossier, not one reviewer — a single
        Scribe with history vouching alongside a new account is the ordinary
        case this must not block."""
        payload = {**PAYLOAD, "waypoints": PAYLOAD["waypoints"][:1]}
        mixed = [("support", 1, "cabin-boy", 90, 0), ("support", 2, "scribe", 30 * 24 * 3600, 5)]
        with Stubbed(payload=payload, dossier=("support", "support"),
                    reviewer_rows=mixed) as s:
            result = run(s)
        self.assertEqual(result.state.decision("verdict"), "approve")

    def test_a_reviewer_ring_is_escalated_even_with_an_established_looking_dossier(self):
        """Two reviewers can each be individually unremarkable and still form
        a ring with the author — freshness is one signal, not the only one."""
        payload = {**PAYLOAD, "waypoints": PAYLOAD["waypoints"][:1]}
        with Stubbed(payload=payload, dossier=("support", "support"),
                    ring_detected=True) as s:
            result = run(s)
        self.assertEqual(result.state.decision("verdict"), "escalate")
        self.assertIn("reviewer ring", result.state.fact("verdict_reason"))

    def test_a_refuting_reviewer_outranks_every_mechanical_check(self):
        payload = {**PAYLOAD, "waypoints": PAYLOAD["waypoints"][:1]}
        with Stubbed(payload=payload, dossier=("support", "support", "refute")) as s:
            result = run(s)
        self.assertEqual(result.state.decision("verdict"), "escalate")
        self.assertIn("refutes", result.state.fact("verdict_reason"))

    def test_a_lost_race_records_nothing(self):
        with Stubbed(superseded=True) as s:
            result = run(s)
        self.assertEqual(result.state.decision("recorded"), "superseded")
        self.assertIsNone(s.world["audit"])
        self.assertIsNone(s.world["spans_written"])

    def test_an_unreachable_source_is_a_verdict_on_the_network(self):
        with Stubbed(unreachable=True) as s:
            result = run(s)
        self.assertEqual(result.state.decision("verdict"), "escalate")
        self.assertEqual(result.state.fact("stats")["unreachable"], 3)
        # The exception CLASS, never its message: a message can carry a key.
        codes = {f["code"] for f in result.state.fact("findings")}
        self.assertIn("SOURCE_UNREACHABLE", codes)
        text = json.dumps(result.state.fact("findings"))
        self.assertIn("TimeoutError", text)
        self.assertNotIn("the archive did not answer", text)

    def test_a_dry_run_writes_nothing_and_still_produces_a_trace(self):
        with Stubbed(dry_run=True) as s:
            result = run(s)
        self.assertIsNone(s.world["audit"])
        self.assertEqual(s.world["status"], "peer-review")
        self.assertEqual(result.state.decision("recorded"), "dry-run")
        self.assertIsNotNone(result.trace.root)


class TheRouteIsOnTheDecision(unittest.TestCase):
    """The whole argument of the phase: the branch a verdict took is a record
    in the trace, naming the Decision the dispatch observed — not an `if` that
    happened once and left nothing behind."""

    def _routing(self, records, after):
        return next(r for r in records
                    if r.get("kind") == "routing" and r.get("after") == after)

    def test_the_verdict_routing_cites_the_verdict_decision(self):
        with Stubbed() as s:
            result, path = trace_file(s)
        records = [json.loads(line) for line in path.read_text().splitlines()][1:]
        routing = self._routing(records, "decide")
        self.assertEqual(routing["on"], "verdict")
        self.assertEqual(routing["value"], "changes")
        self.assertEqual(routing["outcome"], "matched")
        self.assertEqual(routing["selected"], "record_ruling")
        # It does not merely agree with the decision, it points at the record
        # that carries it.
        cited = next(r for r in records if r.get("seq") == routing["origin"]["seq"])
        self.assertEqual(cited["node"], "decide")

    def test_an_escalation_routes_to_the_node_that_does_not_move_the_draft(self):
        payload = {**PAYLOAD, "waypoints": PAYLOAD["waypoints"][:1]}
        with Stubbed(payload=payload, dossier=("support",)) as s:
            result, path = trace_file(s)
        records = [json.loads(line) for line in path.read_text().splitlines()][1:]
        routing = self._routing(records, "decide")
        self.assertEqual(routing["value"], "escalate")
        self.assertEqual(routing["selected"], "record_escalation")


class TheTraceCarriesShapesNotText(unittest.TestCase):
    """The rule that makes the root publishable. A trace holding a
    contributor's unpublished draft is a draft you cannot anchor without
    publishing it — and a second copy of a quotation that is already in
    `submissions.payload` and in `verified_spans`."""

    def test_no_quotation_and_no_source_text_reaches_the_trace(self):
        with Stubbed() as s:
            result, path = trace_file(s)
        blob = path.read_text()
        for forbidden in (VERBATIM, RETYPED, FABRICATED,
                          "we stood out to sea", "there we halted"):
            self.assertNotIn(forbidden, blob,
                             f"the trace carries source or draft text: {forbidden!r}")

    def test_the_shapes_that_replace_it_are_there(self):
        with Stubbed() as s:
            result, path = trace_file(s)
        blob = path.read_text()
        self.assertIn(SOURCE_URL, blob)          # an identifier: it belongs
        self.assertIn("spans_digest", blob)
        self.assertIn("payload_sha256", blob)
        self.assertIn("audit_findings_digest", blob)

    def test_the_digest_in_the_trace_covers_the_findings_that_were_written(self):
        """The binding. Edit `audit_log.findings` afterwards and it no longer
        hashes to what the anchored trace committed to."""
        with Stubbed() as s:
            result = run(s)
            written = s.world["audit"]["findings"]
        self.assertEqual(result.state.fact("audit_findings_digest"),
                         G.digest(written))

    def test_the_digest_in_the_trace_covers_the_spans_that_were_written(self):
        with Stubbed() as s:
            result = run(s)
            written = s.world["spans_written"]
        self.assertEqual(result.state.fact("spans_digest"), G.digest(written))


class TheProse(unittest.TestCase):
    """Findings leave the checks as shapes and reach the contributor as
    sentences. The composition happens against the draft and the located spans,
    both of which are in the database — which is why the sentences can still
    quote them."""

    def test_findings_compose_to_the_triples_the_rest_of_the_system_reads(self):
        with Stubbed() as s:
            run(s)
            rows = s.world["audit"]["findings"]
        self.assertTrue(all(isinstance(r, list) and len(r) == 3 for r in rows))
        self.assertTrue(all(r[1] == 0 for r in rows))
        levels = {r[0] for r in rows}
        self.assertTrue(levels <= {"FAIL", "WARN", "INFO", "ESCALATE"})

    def test_the_sentence_still_quotes_the_draft(self):
        """The excerpt is gone from the trace and still reaches the
        contributor — read back out of `submissions.payload` at recording
        time, which is where it already was."""
        with Stubbed() as s:
            run(s)
            rows = s.world["audit"]["findings"]
        absent = next(t for _, _, t in rows if "NOT FOUND" in t)
        self.assertIn(FABRICATED[:40], absent)

    def test_a_mismatch_sentence_quotes_both_the_draft_and_the_source(self):
        """Composed from the two artefacts that hold the words: the payload for
        what the draft offered, `verified_spans` for what the source has."""
        findings = [{"level": "FAIL", "where": "wp2.claim1",
                     "code": "QUOTE_TRANSCRIBED",
                     "args": {"seq": 2, "ci": 1, "source_length": 39,
                              "draft_length": 39}}]
        spans = {"2.1": {"reading_span": VERBATIM}}
        rows = K.compose(findings, PAYLOAD, spans)
        self.assertEqual(len(rows), 1)
        text = rows[0][2]
        self.assertIn(VERBATIM[:30], text)      # what the source actually has
        self.assertIn(RETYPED[:30], text)       # what the draft offered

    def test_a_sentence_missing_its_artefact_says_so(self):
        """An absent span is stated, never papered over with an empty string:
        "(span not stored)" is a fact about the deployment, "" is a lie about
        the source."""
        findings = [{"level": "FAIL", "where": "wp2.claim1",
                     "code": "QUOTE_TRANSCRIBED",
                     "args": {"seq": 2, "ci": 1, "source_length": 0,
                              "draft_length": 39}}]
        text = K.compose(findings, PAYLOAD, {})[0][2]
        self.assertIn("(span not stored)", text)

    def test_every_code_a_check_can_emit_has_a_message(self):
        # A finding whose code has no template raises at recording time, which
        # is the worst possible moment to discover it. The codes are read out
        # of the checks themselves rather than listed again here.
        source = (HERE / "desk_checks.py").read_text()
        import re as _re
        emitted = set(_re.findall(r'"([A-Z][A-Z0-9_]{4,})"', source))
        emitted -= {"FAIL", "WARN", "INFO", "ESCALATE"}
        emitted &= {c for c in emitted if c.isupper()}
        missing = {c for c in emitted if c not in K.MESSAGES} - {
            "MESSAGES", "EVIDENCE_BASIS", "CONFIDENCE", "REVIEWS_TO_ADVANCE"}
        self.assertEqual(missing, set(), f"codes with no template: {missing}")


# ------------------------------------------------------ the point of it all

class TamperedTrace(unittest.TestCase):
    """The trace is only worth what a checker refuses.

    `motus-validate` ships with Motus, so the person checking this need trust
    neither Terraveler nor its author. Below: a real verdict trace passes, and
    the same trace with one recorded value changed does not — by rule name.
    """

    def setUp(self):
        with Stubbed() as s:
            self.result, self.path = trace_file(s)
        self.lines = self.path.read_text().splitlines()
        self.spec = pathlib.Path(tempfile.mkdtemp()) / "desk.spec.json"
        self.spec.write_text(json.dumps(G.SPEC.to_dict()))

    def _write(self, lines):
        p = pathlib.Path(tempfile.mkdtemp()) / "tampered.jsonl"
        p.write_text("\n".join(lines) + "\n")
        return p

    def test_the_untouched_trace_passes(self):
        code, out = validate(self.path, spec=self.spec)
        self.assertEqual(code, 0, out)

    def test_changing_the_verdict_breaks_the_chain_and_the_routing(self):
        """The edit someone would actually make: turn a rejection into an
        approval, in the record that carries the decision."""
        lines = list(self.lines)
        for i, line in enumerate(lines):
            r = json.loads(line)
            if r.get("kind") == "transition" and r.get("node") == "decide":
                blob = line.replace('"value":"changes"', '"value":"approve"')
                self.assertNotEqual(blob, line, "the decision was not where expected")
                lines[i] = blob
                break
        else:                                            # pragma: no cover
            self.fail("no decide transition in the trace")

        code, out = validate(self._write(lines), spec=self.spec)
        self.assertNotEqual(code, 0, "a tampered trace passed validation")
        # T11 is the hash chain: the record no longer hashes to what the next
        # record committed to. T8 is the routing rule: the branch cites a
        # decision that no longer says what the branch took.
        self.assertIn("T11", out, out)
        self.assertIn("T8", out, out)

    def test_changing_any_recorded_value_breaks_the_hash_chain(self):
        """Not only the verdict. Every record is covered."""
        lines = list(self.lines)
        for i, line in enumerate(lines):
            if '"n_quoted"' in line:
                lines[i] = line.replace('"n_quoted","value":3', '"n_quoted","value":1')
                self.assertNotEqual(lines[i], line, "n_quoted was not where expected")
                break
        else:                                            # pragma: no cover
            self.fail("no n_quoted fact in the trace")
        code, out = validate(self._write(lines))
        self.assertNotEqual(code, 0, "a tampered trace passed validation")
        self.assertIn("T11", out, out)

    def test_deleting_a_record_is_refused(self):
        """Removing the escalation someone did not like."""
        lines = [l for i, l in enumerate(self.lines) if i != len(self.lines) - 3]
        code, out = validate(self._write(lines))
        self.assertNotEqual(code, 0, "a truncated trace passed validation")

    def test_the_root_changes_when_the_trace_does(self):
        """What Phase 3 publishes, and why publishing it is worth anything."""
        with Stubbed() as s:
            other = run(s, sid=43)
        self.assertNotEqual(self.result.trace.root, other.trace.root)
        self.assertTrue(self.result.trace.root.startswith("sha256:"))


class TheMismatchBranch(unittest.TestCase):
    """Carta 3.4's own clause, tested where it lives.

    A quotation can be found in the source and still not BE the source's span —
    that is the case the rule exists for. It cannot be produced through the
    real matcher by retyping, because the matcher folds case and then copies
    the page's own characters out; it is produced when the span the source
    holds and the text offered normalise differently. So the locator is stubbed
    and the branch is shown directly, rather than approximated with a fixture
    that happens to pass.
    """

    def test_a_span_that_is_not_what_was_submitted_fails(self):
        f, stats = K.Findings(), {"verified": 0, "mismatched": 0, "absent": 0}
        claim = {"seq": 2, "ci": 1, "where": "wp2.claim1", "quote": "the coast"}
        span = K.verify_quotation(
            claim, SOURCE_TEXT, f, stats, "contemporary-journal",
            locate_in_source=lambda q, s: ("that coast", "that coast", []),
            norm=lambda s: s.lower())
        self.assertEqual(stats["mismatched"], 1)
        self.assertEqual(stats["verified"], 0)
        self.assertEqual([r["code"] for r in f.rows], ["QUOTE_TRANSCRIBED"])
        # The span is still returned: it was located, and located evidence is
        # stored even when the draft quoting it is sent back.
        self.assertEqual(span["raw_span"], "that coast")


class TheSpec(unittest.TestCase):

    def test_the_graphspec_satisfies_the_contract(self):
        p = pathlib.Path(tempfile.mkdtemp()) / "spec.json"
        p.write_text(json.dumps(G.SPEC.to_dict()))
        r = subprocess.run(
            [sys.executable, "-m", "vitruvyan_motus.contract.validate",
             "graphspec", str(p)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_only_decide_claims_to_be_pure(self):
        """A false `pure` claim is caught by verify-replay, so it is not
        guessed at. Every check reads the draft out of the database because the
        draft may not be in the state — see desk_graph's module docstring."""
        spec = G.SPEC.to_dict()
        pure = {n["name"] for n in spec["nodes"] if n["effect_class"] == "pure"}
        self.assertEqual(pure, {"decide", "no_submission"})
        # The criterion is READ or MUTATE and nothing else
        # (TERRAVELER_MOTUS_TRON.md, Phase 2). check_verbatim only performs
        # GETs — a read whose result is the effect — so it is
        # `recorded_effect` alongside the other checks; the two nodes that
        # actually mutate something outside the run are the two that write
        # the verdict.
        external = {n["name"] for n in spec["nodes"]
                    if n["effect_class"] == "external_effect"}
        self.assertEqual(external, {"record_ruling", "record_escalation"})
        recorded = {n["name"] for n in spec["nodes"]
                   if n["effect_class"] == "recorded_effect"}
        self.assertEqual(recorded, {"load_submission", "check_shape",
                                    "check_sources", "check_verbatim",
                                    "read_dossier"})


# --------------------------------------------- what the first live run found

class TheRedirectGuard(unittest.TestCase):
    """archive.org redirects to archive.org, and that is not an open redirect.

    Both cases were found by running the pass against the real queue: every one
    of submission #27's twelve quotations failed as `absent` because
    `archive.org/download/…` answers from a per-item CDN node and the guard
    re-verified the node against a whitelist holding only the apex.
    """

    def test_a_cdn_node_is_still_archive_org(self):
        asked = ("https://archive.org/download/travelsininter00park/"
                 "travelsininter00park_djvu.txt")
        for answered in (
            "https://dn760108.eu.archive.org/0/items/travelsininter00park/x.txt",
            "https://ia800808.us.archive.org/19/items/travelsininter00park/x.txt",
        ):
            self.assertTrue(G.redirect_stays_home(asked, answered), answered)

    def test_a_lookalike_host_is_not(self):
        """The dot is the guarantee. Without it these three pass, and a
        whitelisted host could hand provenance to a body it did not serve."""
        asked = "https://archive.org/download/item/file.txt"
        for answered in ("https://evil-archive.org/file.txt",
                         "https://archive.org.evil.com/file.txt",
                         "https://notarchive.org/file.txt",
                         "https://www.gutenberg.org/files/1/1-0.txt"):
            self.assertFalse(G.redirect_stays_home(asked, answered), answered)

    def test_it_does_not_excuse_a_redirect_from_somewhere_else(self):
        """The exemption is archive.org's, not every host's: a source that did
        not start on archive.org cannot end there unexamined."""
        self.assertFalse(G.redirect_stays_home(
            "https://www.gutenberg.org/files/1/1-0.txt",
            "https://ia800808.us.archive.org/19/items/x/x.txt"))


class ShapeChecksKnowTheirType(unittest.TestCase):
    """Carta §3.6 binds the voyage, and an enrichment makes no voyage.

    All five `waypoint-enrichment` submissions in the queue failed on
    `evidence_basis` and `what_was_lost` — fields their payloads are not built
    with, because the voyage they enrich declared both when it was published.
    """

    ENRICHMENT = {"meta": {"carta_version": "0.7"},
                  "waypoints": [{"seq": 1, "confidence": "certain"}]}

    def _codes(self, payload, sub_type):
        f = K.Findings()
        K.check_shape(payload, f, "0.7", sub_type=sub_type)
        return {r["code"] for r in f.rows if r["level"] == "FAIL"}

    def test_an_enrichment_is_not_asked_for_a_voyages_fields(self):
        self.assertEqual(self._codes(self.ENRICHMENT, "waypoint-enrichment"),
                         set())

    def test_a_new_voyage_still_is(self):
        self.assertEqual(self._codes(self.ENRICHMENT, "new-voyage"),
                         {"EVIDENCE_BASIS_INVALID", "WHAT_WAS_LOST_EMPTY"})

    def test_an_unknown_type_is_checked_rather_than_waved_through(self):
        """The exemption is a named list and the default is to check. A gate
        that skips what it does not recognise is not a gate."""
        for sub_type in (None, "something-invented-next-year"):
            self.assertEqual(self._codes(self.ENRICHMENT, sub_type),
                             {"EVIDENCE_BASIS_INVALID", "WHAT_WAS_LOST_EMPTY"},
                             sub_type)

    def test_the_checks_that_do_concern_an_enrichment_still_run(self):
        """Exempting §3.6 exempts nothing else: an enrichment with no stages is
        still an enrichment that enriches nothing."""
        self.assertEqual(
            self._codes({"meta": {"carta_version": "0.7"}, "waypoints": []},
                        "waypoint-enrichment"),
            {"NO_WAYPOINTS"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
