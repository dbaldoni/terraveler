#!/usr/bin/env python3
"""The Curator's mechanical checks, and the prose they are read as.

This is the half of `desk_review.py` that decides nothing about the world: it
looks at a draft, says what it noticed, and hands back a list. It was split out
of that script when the verdict pass became a Motus graph, because a node has
to be a function of its inputs and the checks already were.

WHY A FINDING IS NOT A SENTENCE ANY MORE
----------------------------------------
A finding used to be `["FAIL", 0, "wp3.claim1: NOT FOUND in the live source —
fabricated or altered (Carta 3.4). Offered: 'the voyage began'"]`, and that
string went into `audit_log.findings` and onto the contributor's screen.

It now leaves here as a shape:

    {"level": "FAIL", "where": "wp3.claim1", "code": "QUOTE_ABSENT",
     "args": {"seq": 3, "ci": 1}}

and the sentence is composed at recording time by `compose()`, out of the
draft's payload and the spans located in the sources — both of which are in
the database, where they already were.

The reason is the trace. The verdict pass runs on Motus now, its every fact
lands in an immutable trace, and that trace's root is published on a public
chain so a verdict cannot be edited afterwards without the edit showing. A
finding carrying the draft's own words would put the draft's own words in the
thing being published, and would put a second copy of a quotation that already
exists in `submissions.payload` and in `verified_spans` into a third place that
must then be kept in step with both. Counts, offsets, source URLs and enum
values are what a trace is for; the words are what the database is for.

Nothing here reads the network or the database. The one exception is stated
where it happens: `verify_quotation` is handed the source text, it does not go
and get it.
"""
from __future__ import annotations

import re

EVIDENCE_BASIS = {"contemporary-journal", "contemporary-testimony",
                  "later-chronicle", "reconstructed"}
CONFIDENCE = {"certain", "approximate", "reconstructed", "contested"}

# Reviews a draft needs before it may advance to a verdict. Mirrors
# REVIEWS_TO_ADVANCE in app/api/mcp/route.ts:313 — this script has no import
# path to the Next.js source at runtime, so the number is copied rather than
# shared, and the two must be kept in step by hand if the Carta's review
# requirement ever changes.
REVIEWS_TO_ADVANCE = 2

# A reviewer this fresh at the moment they cast a review, with next to no
# review history of its own, is indistinguishable from an account created for
# the purpose. One hour is deliberately generous — a real Scribe reviewing
# within an hour of enrolling is rare but not impossible, and the cost of a
# false escalation (a human reads one more dossier) is far smaller than the
# cost of a false approval.
#
# The threshold is on the review count, not on zero: a live sybil ring of
# three fresh accounts, each reviewing two of the others' drafts, has already
# earned one prior review by its second — every reviewer in that ring stayed
# under three. A minimum this low would have missed the very ring it was
# written to catch had it required zero. This is a blunt instrument on
# purpose: a graduated eligibility scheme — a fresh agent may review, but its
# review does not yet weigh toward REVIEWS_TO_ADVANCE — is the better
# long-term shape and is not this pass's job to build.
SUSPICIOUS_REVIEWER_AGE_SECONDS = 3600
SUSPICIOUS_REVIEWER_PRIOR_REVIEWS = 3

# Submission types that bring no voyage record of their own.
#
# Carta §3.6 binds the VOYAGE — "every voyage declares its evidence basis …
# and, in one sentence, what was lost" — and an enrichment does not make a
# voyage, it adds stages to one that declared both when it was published.
# Asking an enrichment for them again asks it to re-state a neighbouring
# record's fields, and the desk failed all five in the queue for not carrying
# a `voyage` key they are not built with.
#
# Stated as an exemption rather than as a list of the types that ARE checked,
# so that a type nobody has thought of yet is checked rather than waved
# through. Failing closed is the safer direction for a gate.
VOYAGELESS_TYPES = {"waypoint-enrichment"}


class Findings:
    """Everything the pass noticed, in shapes.

    `rows` is a list of dicts and not of triples on purpose: a triple whose
    third element is a formatted sentence cannot be put in a trace without
    putting the draft in the trace with it. The triples the rest of the system
    reads — `audit_log.findings`, `lib/deskEscalation.ts` — are built by
    `compose()` and have not changed shape.
    """

    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add(self, level: str, where: str, code: str, **args) -> None:
        self.rows.append({"level": level, "where": where, "code": code,
                          "args": args})

    def fail(self, where, code, **a): self.add("FAIL", where, code, **a)
    def warn(self, where, code, **a): self.add("WARN", where, code, **a)
    def note(self, where, code, **a): self.add("INFO", where, code, **a)
    def escalate(self, where, code, **a): self.add("ESCALATE", where, code, **a)

    def count(self, level: str) -> int:
        return sum(1 for r in self.rows if r["level"] == level)


# ------------------------------------------------------------- the checks

def check_shape(payload: dict, f: Findings, carta: str,
                sub_type: str | None = None) -> None:
    """The clauses a draft must satisfy to be publishable at all.

    `sub_type` decides which of them apply: the §3.6 pair belongs to a voyage,
    and a submission that makes no voyage is not asked for it. An unknown type
    — or none passed — is checked in full, because a gate that skips what it
    does not recognise is not a gate.
    """
    meta = payload.get("meta") or {}
    voyage = payload.get("voyage") or {}
    drafted_under = meta.get("carta_version")
    if drafted_under != carta:
        # A draft is not at fault for being older than the constitution — the
        # Carta moves and a queue takes days. What matters is whether the
        # amendment changed something this draft depends on. v0.5 changed what
        # a quotation IS, so a draft built before it carries text a scribe
        # retyped rather than a span copied from the source, and the quotation
        # check below will say so line by line. Anything else is a note.
        material = bool(drafted_under and drafted_under < "0.5" <= carta)
        (f.fail if material else f.note)(
            "meta", "CARTA_STALE_MATERIAL" if material else "CARTA_STALE_NOTED",
            drafted_under=drafted_under, carta=carta)
    if sub_type not in VOYAGELESS_TYPES:
        basis = voyage.get("evidence_basis")
        if basis not in EVIDENCE_BASIS:
            f.fail("voyage", "EVIDENCE_BASIS_INVALID", basis=basis)
        if not (voyage.get("what_was_lost") or "").strip():
            f.fail("voyage", "WHAT_WAS_LOST_EMPTY")
    if not payload.get("waypoints"):
        f.fail("waypoints", "NO_WAYPOINTS")


def check_confidence(waypoints: list, f: Findings) -> None:
    for w in waypoints:
        if w.get("confidence") not in CONFIDENCE:
            f.fail(f"wp{w.get('seq')}", "CONFIDENCE_INVALID",
                   confidence=w.get("confidence"))
        quoted = any((c.get('evidence') or {}).get('quote')
                     for c in (w.get("claims") or []))
        if quoted and w.get("confidence") == "reconstructed":
            f.warn(f"wp{w.get('seq')}", "CONFIDENCE_CONTRADICTS_QUOTE")


def check_chronology(waypoints: list, f: Findings) -> None:
    prev = None
    for w in waypoints:
        d = (w.get("arrival_date") or "")[:10]
        if not d:
            continue
        if prev and d < prev[0]:
            f.warn(f"wp{w.get('seq')}", "STAGE_OUT_OF_ORDER",
                   date=d, prev_seq=prev[1], prev_date=prev[0])
        prev = (d, w.get("seq"))


def check_sources(waypoints: list, f: Findings, verify_source) -> tuple[list, dict]:
    """The licence gate, and the inventory of what will have to be fetched.

    Split out of the quotation check so that the graph has a node whose whole
    job is "may this source be used at all" — a question answered from a
    whitelist and never from the network. It walks claims rather than distinct
    URLs, and emits one finding per claim, because that is what it did when it
    was one loop and a contributor reading the findings is reading about
    claims.

    Returns the claims admitted to verification, and the counts the gate alone
    can already settle.
    """
    admitted: list[dict] = []
    stats = {"quoted": 0, "verified": 0, "unreachable": 0, "mismatched": 0,
             "absent": 0}
    for w in waypoints:
        for ci, c in enumerate(w.get("claims") or [], 1):
            ev = c.get("evidence") or {}
            quote = ev.get("quote")
            if not quote:
                continue
            stats["quoted"] += 1
            seq = w.get("seq")
            where = f"wp{seq}.claim{ci}"
            url = ev.get("source_url")
            if not url:
                f.fail(where, "QUOTE_NO_SOURCE_URL", seq=seq, ci=ci)
                stats["absent"] += 1
                continue
            ok, why = verify_source(url)
            if not ok:
                f.fail(where, "SOURCE_REFUSED", seq=seq, ci=ci, why=why)
                continue
            admitted.append({"seq": seq, "ci": ci, "where": where, "url": url,
                             "quote": quote, "quote_len": len(quote)})
    return admitted, stats


def verify_quotation(claim: dict, body: str, f: Findings, stats: dict,
                     basis: str | None, locate_in_source, norm) -> dict | None:
    """One quotation, against the text of its source. Returns the located span.

    The heart of it, and unchanged in what it decides. Every quotation is
    re-located in its live source, and the submitted text must equal the span
    the source actually holds.

    Equality is the point. It is not enough for the passage to exist: under
    Carta 3.4 the published text IS the source's own span, so a draft carrying
    a quotation the model retyped — however faithfully — is not publishable,
    it is merely close. Drafts built before that rule fail here, which is what
    this pass is for.

    `body` is passed in rather than fetched: fetching is an effect and belongs
    to the node that declares one.
    """
    where, quote = claim["where"], claim["quote"]
    raw, reading, transformations = locate_in_source(quote, body)

    if raw is None:
        f.fail(where, "QUOTE_ABSENT", seq=claim["seq"], ci=claim["ci"])
        stats["absent"] += 1
        return None

    span = {"raw_span": raw, "reading_span": reading,
            "transformations": transformations,
            "start_offset": body.find(raw), "length": len(raw)}

    if norm(quote) != norm(reading):
        f.fail(where, "QUOTE_TRANSCRIBED", seq=claim["seq"], ci=claim["ci"],
               source_length=len(reading), draft_length=len(quote))
        stats["mismatched"] += 1
        return span

    stats["verified"] += 1
    # Verbatim and in the source is not the same as being the traveller
    # speaking. No cheap signal has ever separated an account from a commentary
    # on it here, so this is flagged for something that can read rather than
    # guessed at.
    #
    # A span that crosses a page break drags the running head and the page
    # number in with it. Verbatim, and not a sentence.
    if re.search(r"\n\s*\n[^\n]{0,60}\b\d{1,4}\b[^\n]{0,60}\n\s*\n", raw):
        f.escalate(where, "SPAN_CROSSES_PAGE_BREAK", seq=claim["seq"], ci=claim["ci"])
    # A chapter-contents line. Verbatim, inside the narrative range, in
    # English, naming the right place — and it proves nothing, because it is
    # the book's own summary of what the chapter contains. Two reached a draft
    # of Mungo Park and only a reader caught them; the mechanical checks had no
    # reason to object to any of it.
    #
    # ESCALATE and never FAIL. docs/LIBRARY_QUEUE.md records three attempts to
    # separate apparatus from account by pattern, all of which failed, and this
    # is a narrower signal rather than a solution to that problem.
    flat = " ".join(reading.split())
    dashes = flat.count("—") + flat.count("--")
    # Case-insensitive, or a sentence opening with "We sailed from Portsmouth"
    # reads as nobody speaking — which it did, and the escalation it produced
    # was noise that would have taught a reader to skim these.
    first_person = re.search(r"\b(I|we|my|our|us|me)\b", flat, re.I)
    if dashes >= 1 and not first_person and len(flat) > 40:
        f.escalate(where, "SPAN_READS_AS_CONTENTS", seq=claim["seq"], ci=claim["ci"],
                   dashes=dashes, flat_length=len(flat))
    # Only where a traveller's own log survives. On a voyage whose evidence
    # basis is a later chronicle, third person is not a warning sign — it is
    # the whole nature of the source, and escalating every line of Cabot would
    # bury the real ones.
    if basis == "contemporary-journal" and len(quote) > 40 and not first_person:
        f.escalate(where, "SPAN_NO_FIRST_PERSON", seq=claim["seq"], ci=claim["ci"])
    return span


def verdict_of(f: Findings, stats: dict) -> tuple[str, str]:
    """The verdict the mechanical checks alone imply, before the dossier."""
    if f.count("FAIL"):
        return "changes", "findings must be answered before this can be published"
    if f.count("ESCALATE"):
        return "escalate", "clean on every mechanical check; needs a reader"
    if stats["unreachable"]:
        return "escalate", "a source could not be reached — retry before ruling"
    if not stats["verified"] and stats["quoted"]:
        return "changes", "no quotation could be verified"
    return "approve", "every mechanical check passed"


# ------------------------------------------------------------- the prose

# One entry per code. Everything a template needs is either in the finding's
# own `args` (a count, an enum value, a URL, a length) or is derived below from
# the draft and the located spans. Nothing is derived from a finding's text,
# because a finding no longer has any.
MESSAGES = {
    "CARTA_STALE_MATERIAL":
        "drafted under Carta v{drafted_under}, in force is v{carta} — v0.5 "
        "changed what a quotation is: these were transcribed by the scribe "
        "rather than copied out of the source, so the draft must be "
        "regenerated rather than edited",
    "CARTA_STALE_NOTED":
        "drafted under Carta v{drafted_under}, in force is v{carta} — no "
        "clause this draft depends on changed",
    "EVIDENCE_BASIS_INVALID":
        "evidence_basis {basis!r} is not one of {evidence_bases}",
    "WHAT_WAS_LOST_EMPTY":
        "what_was_lost is empty — Carta 3.6 requires a voyage to say what the "
        "archive does not hold",
    "NO_WAYPOINTS":
        "no waypoints — a voyage with no itinerary is not a voyage",
    "CONFIDENCE_INVALID":
        "confidence {confidence!r} is not one of {confidences}",
    "CONFIDENCE_CONTRADICTS_QUOTE":
        "carries a verbatim quotation but is marked reconstructed — one of the "
        "two is wrong",
    "STAGE_OUT_OF_ORDER":
        "dated {date} but follows wp{prev_seq} dated {prev_date} — a stage out "
        "of order needs an editorial decision, not a guess",
    "QUOTE_NO_SOURCE_URL":
        "a quotation with no source_url",
    "SOURCE_REFUSED":
        "source refused by the licence gate: {why}",
    "SOURCE_UNVERIFIABLE":
        "cannot be verified: {detail}",
    "SOURCE_UNREACHABLE":
        "source unreachable ({url}): {failure} — not a verdict on the "
        "quotation, a verdict on the network",
    "QUOTE_ABSENT":
        "NOT FOUND in the live source — fabricated or altered (Carta 3.4). "
        "Offered: {offered!r}",
    "QUOTE_TRANSCRIBED":
        "found in the source but not as submitted. The published text must be "
        "the source's own span (Carta 3.4), and this was transcribed. Source "
        "has {reading!r}, draft has {offered!r}",
    "SPAN_CROSSES_PAGE_BREAK":
        "the span crosses a page break and carries the running head or page "
        "number into the quotation — verbatim, and not something a reader "
        "should be shown",
    "SPAN_READS_AS_CONTENTS":
        "reads like a chapter-contents line rather than narrative — fragments "
        "joined by dashes, nobody speaking. Verbatim and in the source, and it "
        "may still prove nothing: {flat!r}",
    "SPAN_NO_FIRST_PERSON":
        "verbatim, but nobody in it speaks in the first person, on a voyage "
        "whose own journal survives — check this is the traveller and not the "
        "editor annotating him: {reading!r}",
    "DOSSIER_SHORT":
        "§10.4 blocks this approval — {recorded}/{required} reviews recorded "
        "for submission #{submission_id}, {refutes} refuting. The editor rules "
        "with the reviewers' dossier in hand, not without it; escalating "
        "instead of approving.",
    "DOSSIER_REVIEWERS_FRESH":
        "all {recorded} reviews on submission #{submission_id} came from an "
        "account under an hour old at review time with no earlier review of "
        "its own — that dossier could be genuine Scribes or a ring of "
        "accounts validating each other, and this pass cannot tell them "
        "apart; escalating instead of approving.",
    "DOSSIER_REVIEWER_RING":
        "submission #{submission_id}'s own author also reviewed a submission "
        "from one of its reviewers — a mutual-review pattern the dossier "
        "requirement was not built to catch; escalating instead of approving.",
}
# One text, two codes: the sentence is identical and the distinction is which
# half of §10.4 blocked the approval, which the verdict's own reason names.
MESSAGES["DOSSIER_REFUTED"] = MESSAGES["DOSSIER_SHORT"]

# The four findings whose sentence quotes the draft or the source. Their words
# are fetched back out of the payload and the spans at composing time, which is
# the whole reason those two artefacts are stored.
_QUOTES_THE_DRAFT = {"QUOTE_ABSENT", "QUOTE_TRANSCRIBED",
                     "SPAN_READS_AS_CONTENTS", "SPAN_NO_FIRST_PERSON"}


def _excerpts(code: str, args: dict, payload: dict, spans: dict) -> dict:
    """The words a sentence needs, out of the database and never out of a trace.

    A missing artefact is stated rather than papered over: a finding composed
    without the span it quotes says so, because "(span not stored)" is a fact
    about this deployment and an empty string is a lie about the source.
    """
    key = f"{args.get('seq')}.{args.get('ci')}"
    span = (spans or {}).get(key) or {}
    reading = span.get("reading_span")
    quote = None
    for w in payload.get("waypoints") or []:
        if w.get("seq") == args.get("seq"):
            claims = w.get("claims") or []
            idx = (args.get("ci") or 0) - 1
            if 0 <= idx < len(claims):
                quote = ((claims[idx].get("evidence") or {}).get("quote"))
            break
    missing_span = "(span not stored)"
    missing_quote = "(quotation not in the payload)"
    if code == "QUOTE_ABSENT":
        return {"offered": (quote or missing_quote)[:90]}
    if code == "QUOTE_TRANSCRIBED":
        return {"reading": (reading or missing_span)[:80],
                "offered": (quote or missing_quote)[:80]}
    if code == "SPAN_READS_AS_CONTENTS":
        flat = " ".join((reading or missing_span).split())
        return {"flat": flat[:110]}
    if code == "SPAN_NO_FIRST_PERSON":
        return {"reading": (reading or missing_span)[:110]}
    return {}


def compose(findings: list[dict], payload: dict, spans: dict) -> list[list]:
    """Shapes back into the triples the rest of the system already reads.

    `[level, 0, "where: what"]` — the shape `audit_log.findings` holds and
    `lib/deskEscalation.ts` matches on. The middle element was always zero and
    stays zero; changing it here would be a schema change wearing a refactor's
    clothes.
    """
    rows = []
    for item in findings:
        code = item["code"]
        args = dict(item.get("args") or {})
        args.setdefault("evidence_bases", sorted(EVIDENCE_BASIS))
        args.setdefault("confidences", sorted(CONFIDENCE))
        args.setdefault("required", REVIEWS_TO_ADVANCE)
        if code in _QUOTES_THE_DRAFT:
            args.update(_excerpts(code, args, payload or {}, spans or {}))
        text = MESSAGES[code].format(**args)
        rows.append([item["level"], 0, f"{item['where']}: {text}"])
    return rows
