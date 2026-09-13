#!/usr/bin/env python3
"""The Curator's verdict pass, as a Motus graph.

Carta §2 gives the Curator the power to issue `approved | rejected |
changes-requested`, and §5 makes every verdict motivated, cited and appealable.
That is a graph with decisions and routing, and until now it was a script with
`if`s: the branch a verdict took existed only in the moment the interpreter
took it, and the record left behind was a row someone with the database
password could edit afterwards, silently.

This is the pass rebuilt so that cannot be true. Every verdict is a recorded
`Decision`, the routing is *on that decision* so the branch is a fact rather
than a control-flow event nobody can see, and the whole run leaves an immutable
trace whose records are hash-chained and whose root is published on a public
chain (`scripts/anchor.py`). A verdict that was edited afterwards no longer
matches the root that was published before the edit, and anyone can check it
with `motus-validate`, trusting neither this code nor its author.

WHAT THE TRACE CARRIES, AND WHAT IT REFUSES TO
----------------------------------------------
Shapes. Counts, lengths, offsets, source URLs, enum values, digests. Not the
draft's words and not the source's.

That is not squeamishness, it is what makes the anchor publishable: the root
covers everything in the trace, and a trace holding a contributor's unpublished
draft is a draft you cannot anchor without publishing it. It is also the only
way to keep one fact in one place — the quotation is already in
`submissions.payload`, the located span is already in `verified_spans`, and a
third copy inside a trace is a third thing to keep in step with the other two.

The binding between the shapes and the words is a digest, and it is the point:
`findings_digest` covers the exact sentences written to `audit_log`, and
`spans_digest` covers the exact spans written to `verified_spans`. Edit either
row afterwards and it no longer hashes to what the anchored trace committed to.

WHY SO FEW NODES ARE `pure`
---------------------------
Only `decide` is. Every check reads the draft out of the database rather than
out of the state, because the state is the trace and the draft is exactly what
the trace must not carry — so a check that could have been a pure function of
its inputs is honestly a node that reads the outside world. Each read records
the payload's SHA-256 in its effect description, so a trace shows whether all
four checks saw the same bytes, which a single cached read could only assert.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import urllib.request
from dataclasses import dataclass, field
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
sys.path.insert(0, str(ROOT / "scripts"))

import psycopg2                                            # noqa: E402
import psycopg2.extras                                     # noqa: E402

from vitruvyan_motus import (                              # noqa: E402
    Decision, EffectDescriptor, EffectReceipt, Fact, GraphSpec, Policy,
    Rejection, Runtime, State,
)
from vitruvyan_motus.context import ReplayStatus           # noqa: E402
from vitruvyan_motus.effects import EffectClass            # noqa: E402

from verbatim import (                                     # noqa: E402
    UnverifiableSource, locate_in_source, norm, source_text,
)
from whitelist import domain_of, verify_source             # noqa: E402

import desk_checks as K                                    # noqa: E402

RECORDED = EffectClass.RECORDED_EFFECT
EXTERNAL = EffectClass.EXTERNAL_EFFECT

UA = "terraveler-desk/1.0 (contact: dbaldoni@gmail.com)"
ACTOR = "curator-desk"
# Cap on a single source fetch. Verification runs unattended under the
# officers' watch; a djvu scan is tens of MB, a book is a few — anything
# beyond this is not a source we can locate a span in at this scale.
MAX_FETCH_BYTES = 30 * 1024 * 1024
# The statuses this desk may rule from. An explicit id is a way to pick a
# submission out of the queue, not a way to re-rule one that has left it
# (approved, rejected, appealed — the editor's ground).
RULEABLE = ("submitted", "peer-review", "human-review")


# ------------------------------------------------------------------- the spec

SPEC = GraphSpec.from_dict({
    "schema_version": "1.0.0",
    "name": "terraveler-desk-verdict",
    "version": "1.0.0",
    "entry": "load_submission",
    "nodes": [
        # Reads the queue. The *result* is the effect; it changes nothing.
        {"name": "load_submission", "effect_class": "recorded_effect",
         "reads_declared": ["submission_id"],
         "writes_declared": ["type", "target_voyage", "status", "drafted_under",
                             "evidence_basis", "n_waypoints", "n_claims",
                             "n_quoted", "payload_sha256", "queue"]},
        # `pure` would be a lie and `pure` would also be a better graph: this
        # reads the payload from the database because the payload may not be
        # in the state. See the module docstring.
        {"name": "check_shape", "effect_class": "recorded_effect",
         "reads_declared": ["submission_id"],
         "writes_declared": ["shape_findings", "n_shape_fail"]},
        # The licence gate. It answers from a whitelist, never from the
        # network — but it reads the draft to know which sources to ask about.
        {"name": "check_sources", "effect_class": "recorded_effect",
         "reads_declared": ["submission_id"],
         "writes_declared": ["source_findings", "cited_sources", "n_admitted",
                             "n_refused", "gate_stats"]},
        # The only node that goes out to the archives. The criterion is READ
        # or MUTATE and nothing else (TERRAVELER_MOTUS_TRON.md, Phase 2): this
        # node only performs GETs, and a GET is a read whose result is the
        # effect. It was declared `external_effect` here once, on the
        # reasoning that "the spans it locates are staged for a write" — but
        # the write that reasoning describes happens downstream, in
        # `record_ruling`/`record_escalation`, which already declare it. This
        # node mutates nothing outside the run itself.
        {"name": "check_verbatim", "effect_class": "recorded_effect",
         "reads_declared": ["submission_id", "cited_sources", "gate_stats",
                            "evidence_basis"],
         "writes_declared": ["verbatim_findings", "stats", "n_spans",
                             "spans_digest", "sources_fetched"]},
        # Carta §10.4: the editor rules with the reviewers' dossier in hand.
        # Read BEFORE the verdict rather than after it, which is where the
        # script had it — a rule that can turn an approval into an escalation
        # is evidence for the verdict, not an afterthought to it.
        {"name": "read_dossier", "effect_class": "recorded_effect",
         "reads_declared": ["submission_id"],
         "writes_declared": ["reviews_recorded", "reviews_refuting",
                             "reviewer_signals", "reviewer_ring_detected"]},
        # The one pure node, and the one that matters: it reads what the
        # checks recorded and issues the verdict. It does not know, and must
        # not know, which node runs next.
        {"name": "decide", "effect_class": "pure",
         "reads_declared": ["shape_findings", "source_findings",
                            "verbatim_findings", "stats", "reviews_recorded",
                            "reviews_refuting", "reviewer_signals",
                            "reviewer_ring_detected", "submission_id"],
         "writes_declared": ["findings", "findings_count", "verdict_reason"]},
        # The two ways a verdict is written down. They differ in exactly one
        # thing — whether the submission's status moves — which is why the
        # route is not decorative.
        {"name": "record_ruling", "effect_class": "external_effect",
         "reads_declared": ["submission_id", "findings"],
         "writes_declared": ["recorded_status", "audit_action",
                             "audit_findings_digest", "spans_committed"]},
        {"name": "record_escalation", "effect_class": "external_effect",
         "reads_declared": ["submission_id", "findings"],
         "writes_declared": ["recorded_status", "audit_action",
                             "audit_findings_digest", "spans_committed"]},
        # Nothing in the queue under this id that this desk may rule on.
        {"name": "no_submission", "effect_class": "pure",
         "reads_declared": ["submission_id"], "writes_declared": ["outcome"]},
    ],
    "transitions": {
        "load_submission": {"kind": "route", "on": "queue",
                            "map": {"loaded": "check_shape",
                                    "absent": "no_submission"},
                            "default": "no_submission"},
        "check_shape": {"kind": "next", "to": "check_sources"},
        "check_sources": {"kind": "next", "to": "check_verbatim"},
        "check_verbatim": {"kind": "next", "to": "read_dossier"},
        "read_dossier": {"kind": "next", "to": "decide"},
        # The whole argument of the phase is in these five lines. The verdict
        # is a Decision a node recorded; the dispatch routes on that Decision
        # and the trace carries a routing record naming it. A verdict the graph
        # took but did not record cannot reach a recording node at all.
        "decide": {"kind": "route", "on": "verdict",
                   "map": {"approve": "record_ruling",
                           "changes": "record_ruling",
                           "reject": "record_ruling",
                           "escalate": "record_escalation"},
                   "default": "record_escalation"},
        "record_ruling": {"kind": "terminal"},
        "record_escalation": {"kind": "terminal"},
        "no_submission": {"kind": "terminal"},
    },
})

# Only `pure` nodes are re-executed by verify-replay, and `decide` is the only
# one. Saying `partial` with that constraint is the strongest claim this graph
# can honour — and it is the claim worth having, because `decide` is precisely
# the node someone would want to re-execute to check that these findings imply
# this verdict.
DECLARED_REPLAY = ReplayStatus.declared(
    "partial", ("only-pure-nodes-are-reexecutable",))


# --------------------------------------------------------------- the plumbing

def canonical(value: Any) -> bytes:
    """The bytes a digest in this graph is taken over.

    Ours, and named as ours: Motus canonicalises its own records and we do not
    reach into its private helper to do it. Sorted keys, no whitespace, no
    ASCII escaping — so the same value hashes the same on any machine, and a
    reader can reproduce it in four lines of any language.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical(value)).hexdigest()


class SpanStore:
    """The located quotations, between the node that finds them and the node
    that writes them down.

    This is the one thing that passes between nodes outside the state, and it
    exists because the alternative is putting the source's text in the trace.
    It is not a hiding place: `check_verbatim` records `spans_digest` over
    exactly what it staged, and the recording node records the digest of
    exactly what it committed. Two digests over one artefact, in an immutable
    trace, at both ends of the channel — tamper with what passes through and
    the trace says so.
    """

    def __init__(self) -> None:
        self._staged: dict[str, dict] = {}
        self.committed = False

    def stage(self, key: str, span: dict) -> None:
        self._staged[key] = span

    def staged(self) -> dict[str, dict]:
        return dict(self._staged)

    def commit(self, cur, submission_id: int, carta: str) -> bool:
        """Write the spans, or decline to and say why.

        An EMPTY pass writes nothing: a run where every source was unreachable
        must not overwrite spans a previous run located — evidence is replaced
        by evidence, never by absence.
        """
        if not self._staged:
            return False
        cur.execute("insert into verified_spans (submission_id, spans, carta_version) "
                    "values (%s,%s,%s) on conflict (submission_id) do update "
                    "set spans = excluded.spans, carta_version = excluded.carta_version, "
                    "verified_at = now()",
                    (submission_id, psycopg2.extras.Json(self._staged), carta))
        self.committed = True
        return True


@dataclass(frozen=True)
class DeskConfig:
    """Deployment configuration, read-only and shared.

    Not a channel between nodes: the one thing nodes pass to each other lives
    in `spans`, which is a SpanStore and says so in its own docstring. What is
    here is the connection string, the constitution in force, and whether this
    run is allowed to write anything at all.
    """
    pg: dict[str, Any]
    carta: str
    dry_run: bool = False
    spans: SpanStore = field(default_factory=SpanStore)
    fetch_cache: dict[str, str] = field(default_factory=dict)

    def connect(self):
        return psycopg2.connect(**self.pg)


def _within(host: str, family: str) -> bool:
    """True when `host` is `family` itself or a subdomain of it.

    The leading dot is the whole guarantee and the reason this is not a
    substring test: `evil-archive.org` does not end with `.archive.org`, and
    neither does `archive.org.evil.com`.
    """
    return host == family or host.endswith("." + family)


def redirect_stays_home(asked: str, answered: str) -> bool:
    """True when a redirect never left the host whose licence was verified.

    archive.org serves item files from per-item CDN nodes — dn760108.eu,
    ia800808.us — and every `archive.org/download/…` URL redirects to one of
    them. They are archive.org's own infrastructure, but `VERIFIED_DOMAINS`
    matches exactly and holds only the apex, so the guard below refused every
    one of them and no archive.org quotation could be verified at all. The
    atlas's principal source was unusable by the desk that polices it.

    Re-verifying the *destination* is still right, and stays right: a
    whitelisted host that open-redirects off-list must not bind PD/CC
    provenance to a body some other server chose. What this says is narrower —
    that archive.org handing us to archive.org is not that redirect. The
    item's licence was established against the URL we asked for, by
    `verify_archive_item`, which reads the item's own metadata; a CDN node
    serving that same item's file is the same guarantee arriving by a
    different door.
    """
    return _within(domain_of(asked), "archive.org") and \
        _within(domain_of(answered), "archive.org")


def fetch(cfg: DeskConfig, url: str) -> str:
    """The readable text of a source, cached for the run.

    What counts as readable is verbatim.source_text, which both gates share —
    and which keys on the server's Content-Type rather than on the presence of
    an angle bracket.
    """
    if url in cfg.fetch_cache:
        return cfg.fetch_cache[url]
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        # The whitelist was checked against the URL we asked for; urlopen
        # follows redirects, so the guarantee must be re-established against
        # the URL that answered. A whitelisted host that open-redirects
        # off-list would otherwise bind PD/CC provenance to a body some other
        # server chose. And the read is capped: this runs unattended now, and
        # an unbounded r.read() on a shared VPS is an OOM with a contributor's
        # name on the trigger.
        final = r.geturl()
        if final != url and not redirect_stays_home(url, final):
            ok, why = verify_source(final)
            if not ok:
                raise UnverifiableSource(
                    f"redirected off-whitelist: {url} -> {final} ({why})")
        raw = r.read(MAX_FETCH_BYTES + 1)
        if len(raw) > MAX_FETCH_BYTES:
            raise UnverifiableSource(
                f"source larger than {MAX_FETCH_BYTES >> 20}MB: {url}")
        body = raw.decode("utf-8", "replace")
        ctype = r.headers.get("Content-Type", "")
    cfg.fetch_cache[url] = source_text(body, ctype)
    return cfg.fetch_cache[url]


def _payload(cfg: DeskConfig, submission_id: int) -> tuple[dict | None, str, dict]:
    """The draft as the database holds it, with the digest of what was read.

    Re-read by every node that needs it rather than carried in the state. The
    digest travels into each node's effect description, so a trace shows
    whether the four checks saw the same bytes — which is a stronger statement
    than one read repeated from memory could make.
    """
    conn = cfg.connect()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("select id,type,target_voyage,status,payload from submissions "
                        " where id = %s and status in %s",
                        (submission_id, RULEABLE))
            row = cur.fetchone()
    finally:
        conn.close()
    if row is None:
        return None, digest(None), {}
    payload = row["payload"] or {}
    return payload, digest(payload), {k: row[k] for k in
                                      ("id", "type", "target_voyage", "status")}


# --------------------------------------------------------------- the nodes

def make_nodes(cfg: DeskConfig):
    """Build the node table. The closure carries configuration and the span
    store, and nothing else — no findings, no verdict, no payload."""

    def load_submission(state: State, ctx) -> State:
        sid = state.fact("submission_id")
        payload, sha, row = _payload(cfg, sid)
        now = ctx.now()
        ctx.record_effect(EffectDescriptor(
            effect_class=RECORDED,
            description=(f"read submissions#{sid} in {RULEABLE}: "
                         f"{'found' if row else 'nothing this desk may rule on'}"
                         + (f", payload {sha}" if row else ""))))
        if not row:
            return state.with_rejection(Rejection(
                "rule on this submission",
                f"submission {sid} is not in {list(RULEABLE)} — it has left the "
                f"queue, or it was never in it", now,
                evidence={"submission_id": sid},
            )).with_decision(Decision(
                "queue", "absent", now,
                reason=f"no row for #{sid} in a status this desk may rule from"))

        waypoints = payload.get("waypoints") or []
        claims = [c for w in waypoints for c in (w.get("claims") or [])]
        quoted = [c for c in claims if (c.get("evidence") or {}).get("quote")]
        voyage = payload.get("voyage") or {}
        return (state
                .with_fact(Fact("type", row["type"], "load_submission", now))
                .with_fact(Fact("target_voyage", row["target_voyage"], "load_submission", now))
                .with_fact(Fact("status", row["status"], "load_submission", now))
                .with_fact(Fact("drafted_under", (payload.get("meta") or {}).get("carta_version"),
                                "load_submission", now))
                .with_fact(Fact("evidence_basis", voyage.get("evidence_basis"),
                                "load_submission", now))
                .with_fact(Fact("n_waypoints", len(waypoints), "load_submission", now))
                .with_fact(Fact("n_claims", len(claims), "load_submission", now))
                .with_fact(Fact("n_quoted", len(quoted), "load_submission", now))
                .with_fact(Fact("payload_sha256", sha, "load_submission", now))
                .with_decision(Decision(
                    "queue", "loaded", now,
                    reason=(f"#{sid} is '{row['status']}', {len(waypoints)} waypoint(s), "
                            f"{len(quoted)}/{len(claims)} claim(s) carrying a quotation"))))

    def check_shape(state: State, ctx) -> State:
        sid = state.fact("submission_id")
        payload, sha, row = _payload(cfg, sid)
        payload = payload or {}
        now = ctx.now()
        ctx.record_effect(EffectDescriptor(
            effect_class=RECORDED,
            description=f"read submissions#{sid} payload {sha} for the shape checks"))

        # The type comes from the row rather than from the state: the state's
        # `type` was written by load_submission and this node re-reads the
        # database anyway, so taking it from the same read that produced `sha`
        # keeps one fact from one place. It also cannot drift from the payload
        # the clauses are being applied to.
        f = K.Findings()
        K.check_shape(payload, f, cfg.carta, sub_type=row.get("type"))
        K.check_confidence(payload.get("waypoints") or [], f)
        K.check_chronology(payload.get("waypoints") or [], f)
        state = (state
                 .with_fact(Fact("shape_findings", f.rows, "check_shape", now))
                 .with_fact(Fact("n_shape_fail", f.count("FAIL"), "check_shape", now)))
        if f.count("FAIL"):
            state = state.with_rejection(Rejection(
                "publish as drafted",
                f"{f.count('FAIL')} shape finding(s) must be answered first", now,
                evidence={"codes": sorted({r["code"] for r in f.rows
                                           if r["level"] == "FAIL"})}))
        return state

    def check_sources(state: State, ctx) -> State:
        sid = state.fact("submission_id")
        payload, sha, _ = _payload(cfg, sid)
        payload = payload or {}
        now = ctx.now()
        f = K.Findings()
        admitted, stats = K.check_sources(payload.get("waypoints") or [], f,
                                          verify_source)
        ctx.record_effect(EffectDescriptor(
            effect_class=RECORDED,
            description=(f"licence gate over submissions#{sid} payload {sha}: "
                         f"{len(admitted)} of {stats['quoted']} quotation(s) admitted, "
                         f"{f.count('FAIL')} refused")))
        # The URLs travel: a source identifier is exactly the kind of thing a
        # trace is supposed to name. The quotation does not.
        cited = [{"seq": a["seq"], "ci": a["ci"], "where": a["where"],
                  "url": a["url"], "quote_len": a["quote_len"]} for a in admitted]
        return (state
                .with_fact(Fact("source_findings", f.rows, "check_sources", now))
                .with_fact(Fact("cited_sources", cited, "check_sources", now))
                .with_fact(Fact("n_admitted", len(admitted), "check_sources", now))
                .with_fact(Fact("n_refused", f.count("FAIL"), "check_sources", now))
                .with_fact(Fact("gate_stats", stats, "check_sources", now)))

    def check_verbatim(state: State, ctx) -> State:
        sid = state.fact("submission_id")
        payload, _, _ = _payload(cfg, sid)
        payload = payload or {}
        basis = state.fact("evidence_basis")
        cited = state.fact("cited_sources") or []
        stats = dict(state.fact("gate_stats") or {})
        now = ctx.now()
        stamp = now.isoformat(timespec="seconds")

        # The quotation itself is read back out of the payload rather than
        # carried here from check_sources: the state does not hold it, and
        # that is the rule this graph is built around.
        quotes = {}
        for w in payload.get("waypoints") or []:
            for ci, c in enumerate(w.get("claims") or [], 1):
                q = (c.get("evidence") or {}).get("quote")
                if q:
                    quotes[f"{w.get('seq')}.{ci}"] = q

        f = K.Findings()
        fetched: list[dict] = []
        for entry in cited:
            key = f"{entry['seq']}.{entry['ci']}"
            claim = {"seq": entry["seq"], "ci": entry["ci"],
                     "where": entry["where"], "url": entry["url"],
                     "quote": quotes.get(key, "")}
            try:
                body = fetch(cfg, entry["url"])
            except UnverifiableSource as e:
                f.fail(entry["where"], "SOURCE_UNVERIFIABLE",
                       seq=entry["seq"], ci=entry["ci"], detail=str(e))
                stats["absent"] = stats.get("absent", 0) + 1
                continue
            except Exception as e:
                # The class, not the message: a message can carry a key or a
                # URL, and this string is persisted and shown to a reader.
                failure = type(e).__name__
                f.warn(entry["where"], "SOURCE_UNREACHABLE",
                       seq=entry["seq"], ci=entry["ci"],
                       url=entry["url"], failure=failure)
                stats["unreachable"] = stats.get("unreachable", 0) + 1
                # A failed GET is still a read: nothing was mutated by asking.
                # The node's declared class governs which class its own
                # effects may carry (a `recorded_effect` node may not record
                # an `external_effect`), so this follows check_verbatim's
                # declaration above.
                ctx.record_effect(EffectDescriptor(
                    effect_class=RECORDED,
                    description=f"GET {entry['url']} failed: {failure}",
                    receipt=EffectReceipt(receipt_id=failure, status="unknown")))
                continue
            body_sha = "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
            if not any(s["url"] == entry["url"] for s in fetched):
                fetched.append({"url": entry["url"], "length": len(body),
                                "sha256": body_sha})
                ctx.record_effect(EffectDescriptor(
                    effect_class=RECORDED,
                    description=(f"GET {entry['url']}: {len(body)} readable "
                                 f"character(s), {body_sha}"),
                    receipt=EffectReceipt(receipt_id=entry["url"],
                                          status="completed",
                                          result_fingerprint="effect:" + body_sha)))
            span = K.verify_quotation(claim, body, f, stats, basis,
                                      locate_in_source, norm)
            if span is not None:
                # The materialised span. Everything downstream reads THIS and
                # never the contributor's text — which is the only way the
                # guarantee survives a path that does not run the pipeline.
                span.update({"source_url": entry["url"],
                             "source_sha256": body_sha.split(":", 1)[1],
                             "verified_at": stamp,
                             "carta_version": cfg.carta})
                cfg.spans.stage(key, span)

        staged = cfg.spans.staged()
        return (state
                .with_fact(Fact("verbatim_findings", f.rows, "check_verbatim", now))
                .with_fact(Fact("stats", stats, "check_verbatim", now))
                .with_fact(Fact("n_spans", len(staged), "check_verbatim", now))
                .with_fact(Fact("spans_digest", digest(staged), "check_verbatim", now))
                .with_fact(Fact("sources_fetched", fetched, "check_verbatim", now)))

    def read_dossier(state: State, ctx) -> State:
        """The dossier, and who is in it.

        §10.4 says the editor rules with the dossier in hand — it does not say
        the dossier is just a count. Three fresh accounts reviewing each
        other's drafts satisfy REVIEWS_TO_ADVANCE exactly as well as three
        Scribes do; the only difference is in who the reviewers are, which the
        cardinality check cannot see and this query exists to fetch. Reviewer
        age is measured AT THE TIME OF REVIEW, not now — an account that has
        since aged is not evidence about how much history it had when it
        vouched for this draft.
        """
        sid = state.fact("submission_id")
        now = ctx.now()
        conn = cfg.connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "select r.verdict, r.reviewer_id, c.rank, "
                    "extract(epoch from (r.created_at - c.created_at)) as age_at_review_seconds, "
                    "(select count(*) from reviews r2 where r2.reviewer_id = r.reviewer_id "
                    " and r2.submission_id <> r.submission_id) as prior_reviews "
                    "from reviews r join contributors c on c.id = r.reviewer_id "
                    "where r.submission_id = %s", (sid,))
                rows = cur.fetchall()
                reviewer_ids = [row[1] for row in rows]
                ring_detected = False
                if reviewer_ids:
                    # s1 is this submission's own author, joined in by id
                    # rather than fetched separately first — one round trip
                    # asks "did the author review one of their own reviewers".
                    cur.execute(
                        "select count(*) from reviews r2 "
                        "join submissions s1 on s1.id = %s "
                        "join submissions s2 on s2.id = r2.submission_id "
                        "where r2.reviewer_id = s1.contributor_id "
                        "and s2.contributor_id = any(%s)", (sid, reviewer_ids))
                    ring_detected = cur.fetchone()[0] > 0
        finally:
            conn.close()
        dossier = [row[0] for row in rows]
        refutes = dossier.count("refute")
        signals = [{"reviewer_id": rid, "rank": rank,
                    "age_at_review_seconds": age, "prior_reviews": prior}
                   for _, rid, rank, age, prior in rows]
        ctx.record_effect(EffectDescriptor(
            effect_class=RECORDED,
            description=(f"read the review dossier for #{sid}: {len(dossier)} "
                         f"recorded, {refutes} refuting, ring={ring_detected}")))
        return (state
                .with_fact(Fact("reviews_recorded", len(dossier), "read_dossier", now))
                .with_fact(Fact("reviews_refuting", refutes, "read_dossier", now))
                .with_fact(Fact("reviewer_signals", signals, "read_dossier", now))
                .with_fact(Fact("reviewer_ring_detected", ring_detected, "read_dossier", now)))

    def decide(state: State, ctx) -> State:
        """The node the whole pass exists for, and the only pure one.

        It reads what the checks recorded and issues a verdict. It does not
        write it down and it does not know which node will — the runtime routes
        on the Decision below, so the branch taken is in the trace beside the
        Decision that caused it.
        """
        findings = ((state.fact("shape_findings") or [])
                    + (state.fact("source_findings") or [])
                    + (state.fact("verbatim_findings") or []))
        stats = state.fact("stats") or {}
        recorded = state.fact("reviews_recorded") or 0
        refutes = state.fact("reviews_refuting") or 0
        sid = state.fact("submission_id")
        now = ctx.now()

        f = K.Findings()
        f.rows = list(findings)
        verdict, why = K.verdict_of(f, stats)

        if verdict == "approve" and (recorded < K.REVIEWS_TO_ADVANCE or refutes):
            # Carta §10.4: "the editor rules with the reviewers' dossier in
            # hand." And the dossier is read, not counted. Two Scribes both
            # refuting a claim against its sources is precisely the case §10.4
            # exists for — the quotation can be verbatim in the source while
            # the source's words belong to an editor and not the traveller,
            # which no mechanical check here can see. A cardinality check would
            # have approved over their objection; a refutation is a reader's
            # finding, and weighing one is a reader's job.
            f.escalate("desk", "DOSSIER_REFUTED" if refutes else "DOSSIER_SHORT",
                       recorded=recorded, refutes=refutes, submission_id=sid)
            verdict = "escalate"
            why = ("mechanical checks passed but a reviewer refutes" if refutes
                   else "mechanical checks passed but the review dossier is short")

        if verdict == "approve":
            # The dossier was long enough and unanimous — but long enough by
            # whom is exactly what a ring of fresh accounts can fake, and
            # unanimous is what they would all say. Neither check above reads
            # who is in the dossier; this one does.
            signals = state.fact("reviewer_signals") or []
            ring = state.fact("reviewer_ring_detected") or False
            all_fresh = bool(signals) and all(
                (sig["age_at_review_seconds"] or 0) < K.SUSPICIOUS_REVIEWER_AGE_SECONDS
                and sig["prior_reviews"] < K.SUSPICIOUS_REVIEWER_PRIOR_REVIEWS
                for sig in signals)
            if ring or all_fresh:
                f.escalate("desk", "DOSSIER_REVIEWER_RING" if ring else "DOSSIER_REVIEWERS_FRESH",
                           recorded=recorded, submission_id=sid)
                verdict = "escalate"
                why = ("a reviewer ring: the author also reviewed one of its own reviewers"
                       if ring else
                       "every reviewer on the dossier is freshly-enrolled with no review history")

        state = (state
                 .with_fact(Fact("findings", f.rows, "decide", now))
                 .with_fact(Fact("findings_count", {
                     level: f.count(level)
                     for level in ("FAIL", "WARN", "INFO", "ESCALATE")}, "decide", now))
                 .with_fact(Fact("verdict_reason", why, "decide", now)))
        if verdict != "approve":
            # A refusal is recorded as a refusal, not merely as an absence.
            state = state.with_rejection(Rejection(
                "approve for publication", why, now,
                evidence={"fail": f.count("FAIL"), "escalate": f.count("ESCALATE"),
                          "verified": stats.get("verified", 0),
                          "quoted": stats.get("quoted", 0)}))
        return state.with_decision(Decision("verdict", verdict, now, reason=why))

    def _write(state: State, ctx, *, move_status: bool) -> State:
        sid = state.fact("submission_id")
        findings = state.fact("findings") or []
        verdict = _verdict_of_state(state)
        now = ctx.now()
        status = {"approve": "approved", "changes": "changes-requested",
                  "reject": "rejected"}.get(verdict) if move_status else None

        if cfg.dry_run:
            rows = K.compose(findings, _payload(cfg, sid)[0] or {}, cfg.spans.staged())
            ctx.record_effect(EffectDescriptor(
                effect_class=EXTERNAL,
                description=(f"DRY RUN: would record '{verdict}' on #{sid} "
                             f"({len(rows)} finding(s), {len(cfg.spans.staged())} span(s)) "
                             f"— nothing written"),
                # `unknown` and not a third word: the contract allows two, and
                # a run that deliberately did not act has not completed one.
                receipt=EffectReceipt(receipt_id=f"dry-run:{sid}", status="unknown")))
            return (state
                    .with_fact(Fact("recorded_status", None, "policy", now))
                    .with_fact(Fact("audit_action", "dry-run", "policy", now))
                    .with_fact(Fact("audit_findings_digest", digest(rows), "policy", now))
                    .with_fact(Fact("spans_committed", False, "policy", now))
                    .with_decision(Decision("recorded", "dry-run", now,
                                            reason="--dry-run: the pass reports and writes nothing")))

        conn = cfg.connect()
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                if status:
                    # The world may have moved during this pass: verification
                    # fetches sources for minutes, and in that window the
                    # editor may have ruled or the contributor may have
                    # appealed — and ruling on an appeal is the one thing the
                    # Curator's commission forbids (Carta §5, Ship's Officers
                    # §4.1). So the transition is conditional on the submission
                    # still being in a state this desk may rule from, and a
                    # lost race records nothing: the ledger must not hold a
                    # Curator verdict that never took effect.
                    cur.execute(
                        "update submissions set status=%s, updated_at=now() "
                        " where id=%s and status in %s", (status, sid, RULEABLE))
                    if cur.rowcount == 0:
                        conn.rollback()
                        ctx.record_effect(EffectDescriptor(
                            effect_class=EXTERNAL,
                            description=f"#{sid} changed hands during verification — nothing written",
                            receipt=EffectReceipt(receipt_id=f"submission:{sid}",
                                                  status="unknown")))
                        return (state
                                .with_fact(Fact("recorded_status", None, "policy", now))
                                .with_fact(Fact("audit_action", None, "policy", now))
                                .with_fact(Fact("spans_committed", False, "policy", now))
                                .with_rejection(Rejection(
                                    "record this verdict",
                                    "the submission changed hands during verification "
                                    "(editor's verdict, or an appeal) — nothing recorded",
                                    now, evidence={"submission_id": sid,
                                                   "verdict": verdict}))
                                .with_decision(Decision(
                                    "recorded", "superseded", now,
                                    reason=f"0 rows matched #{sid} in {list(RULEABLE)}")))
                    cur.execute("select payload from submissions where id = %s", (sid,))
                else:
                    cur.execute("select payload from submissions where id = %s", (sid,))
                row = cur.fetchone()
                payload = (row or {}).get("payload") or {}
                rows = K.compose(findings, payload, cfg.spans.staged())
                wrote_spans = cfg.spans.commit(cur, sid, cfg.carta)
                # The actor is the Curator, never the editor. A verdict
                # recorded under a human's name that a human did not give is
                # the defect this replaces.
                action = "verdict" if status else "review"
                cur.execute(
                    "insert into audit_log (submission_id, actor, action, verdict,"
                    " findings, carta_version) values (%s,%s,%s,%s,%s,%s)",
                    (sid, ACTOR, action, verdict,
                     psycopg2.extras.Json(rows), cfg.carta))
            conn.commit()
        finally:
            conn.close()

        ctx.record_effect(EffectDescriptor(
            effect_class=EXTERNAL,
            description=(f"recorded '{verdict}' on #{sid} as {ACTOR}: status "
                         f"{status or 'unchanged'}, {len(rows)} finding(s), "
                         f"{len(cfg.spans.staged()) if wrote_spans else 0} span(s)"),
            receipt=EffectReceipt(receipt_id=f"audit:{sid}:{verdict}",
                                  status="completed",
                                  result_fingerprint="effect:" + digest(rows))))
        return (state
                .with_fact(Fact("recorded_status", status, "policy", now))
                .with_fact(Fact("audit_action", action, "policy", now))
                .with_fact(Fact("audit_findings_digest", digest(rows), "policy", now))
                .with_fact(Fact("spans_committed", wrote_spans, "policy", now))
                .with_decision(Decision(
                    "recorded", "ruled" if status else "escalated", now,
                    reason=(f"audit_log row as '{action}', submission "
                            f"{'moved to ' + status if status else 'left where it stands'}"))))

    def record_ruling(state: State, ctx) -> State:
        """A verdict that moves the submission. approve / changes / reject."""
        return _write(state, ctx, move_status=True)

    def record_escalation(state: State, ctx) -> State:
        """A verdict that does not. The draft stays where it is and the row
        says the editor's attention is owed — which is the whole difference
        between the two recording nodes, and why the route is real."""
        return _write(state, ctx, move_status=False)

    def no_submission(state: State, ctx) -> State:
        sid = state.fact("submission_id")
        now = ctx.now()
        return state.with_fact(Fact(
            "outcome", f"nothing to rule on for #{sid}", "no_submission", now))

    return {"load_submission": load_submission, "check_shape": check_shape,
            "check_sources": check_sources, "check_verbatim": check_verbatim,
            "read_dossier": read_dossier, "decide": decide,
            "record_ruling": record_ruling, "record_escalation": record_escalation,
            "no_submission": no_submission}


def _verdict_of_state(state: State) -> str | None:
    """The verdict this run recorded, read back from the state.

    Read rather than passed: the recording node must write down the Decision
    the graph actually routed on, and taking it from anywhere else would let
    the two drift — which is the defect this whole pass is built to prevent.
    """
    return state.decision("verdict")


# ------------------------------------------------------------------ the run

def initial_state(submission_id: int, *, carta: str, dry_run: bool, ts) -> State:
    """Every input the run can turn on, as a Fact.

    Not as metadata: run metadata reaches the trace HEADER and nothing else, so
    two runs over different submissions would produce byte-identical record
    streams and a reader would have no way to tell them apart from the records
    alone. A Fact lands in `run_started.initial_state`, inside the stream.
    """
    return State.new(
        f"verdict:{submission_id}",
        facts=[
            Fact("submission_id", submission_id, "caller", ts),
            Fact("carta_version", carta, "caller", ts),
            Fact("dry_run", dry_run, "caller", ts),
        ],
        metadata={"submission_id": str(submission_id), "carta_version": carta,
                  "actor": ACTOR, "dry_run": "yes" if dry_run else "no"},
    )


def run_desk(cfg: DeskConfig, submission_id: int, *, run_id: str, sink=None,
             policy=Policy.EXPLORATION, ts=None):
    """Execute the verdict graph on Motus. Returns the RunResult.

    One DeskConfig per submission, and the caller builds it: a SpanStore shared
    between two runs would let one draft's spans be written under the other's
    id, which is the one bug this channel could plausibly have. Making the
    caller construct it keeps the store reachable afterwards — the CLI composes
    its report from it — which a store minted in here would not be.
    """
    from datetime import datetime, timezone
    ts = ts or datetime.now(timezone.utc)
    runtime = Runtime(SPEC, make_nodes(cfg), policy=policy, sink=sink)
    return runtime.run(
        initial_state(submission_id, carta=cfg.carta, dry_run=cfg.dry_run, ts=ts),
        run_id=run_id, replay=DECLARED_REPLAY)
