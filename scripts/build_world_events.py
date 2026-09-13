#!/usr/bin/env python3
"""
Build the contextual world-event catalogue for the Atlas.

WHY THIS EXISTS
---------------
`data/world_events.json` held 21 hand-written events covering 1767-1769 and
1785-1788. Vasco da Gama (1497-1499) got zero dots and most of the Atlas drew
an empty "Meanwhile in the world" timeline. The renderer was fine; the data was
not. This script is the acquisition half of the replacement.

ARCHITECTURE
------------
Discovery is the Wikipedia year index — every year article (e.g. "1498") is a
curated, dated list of globally notable events, which is exactly the shape a
world strip needs, and it is available for every year this Atlas spans. Each
candidate is then structured through the Wikidata API: its QID, English
description, Earth coordinates, sitelink count and Wikipedia link. The result
is a normalised shared catalogue (`data/historical-events.json`). A separate
TypeScript step (`scripts/build_world_event_projection.ts`) ranks that
catalogue per voyage with the same deterministic scorer the tests use, and
writes the per-voyage projection the client imports.

We discover via Wikipedia and structure via Wikidata because the Wikidata
Query Service was rate-limiting callers to one request per minute during an
active outage while this was written; the year index is stable, cacheable and
still yields Wikidata-linked, attributable events. The pipeline keeps the two
concerns apart so a WDQS discovery adapter can be added without touching the
scorer.

RELIABILITY
-----------
Identifiable User-Agent, timeouts, bounded retries with backoff, 429 handling,
an on-disk cache, deterministic ordering and dedup by QID / normalised
identity. Nothing here runs in the page path, and a build never depends on a
live query: the generated JSON is checked in.

Usage:
    python3 scripts/build_world_events.py                  # refresh everything
    python3 scripts/build_world_events.py --offline        # cache only, no network
    python3 scripts/build_world_events.py --voyage gama-1497
    python3 scripts/build_world_events.py --dry-run        # report, write nothing
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CATALOGUE_PATH = DATA / "historical-events.json"
VOYAGE_INPUT_PATH = DATA / "world-events-voyages.json"
CACHE_PATH = ROOT / ".world-events-cache.json"

UA = "TerravelerWorldEvents/1.0 (https://www.terraveler.com; editorial desk; contact: desk@terraveler.com)"
TIMEOUT = 30
RETRIES = 3
PAUSE = 0.05
WINDOW_SLACK = 2
MAX_PER_YEAR = 45          # bound the catalogue by significance
POLICY_MIN_SITELINKS = 2   # below this an event is trivia, not context
RETRIEVED_AT = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12,
}
MONTH_ALT = "|".join(m.capitalize() for m in MONTHS)

_cache: dict = {}

# ---------------------------------------------------------------------------
# Cache and HTTP
# ---------------------------------------------------------------------------


def cache_load() -> None:
    global _cache
    if CACHE_PATH.exists():
        try:
            _cache = json.loads(CACHE_PATH.read_text())
        except Exception:
            _cache = {}


def cache_save() -> None:
    CACHE_PATH.write_text(json.dumps(_cache))


def get_json(url: str, *, offline: bool = False, retries: int = RETRIES, cache: bool = True) -> dict | None:
    """GET JSON with an identifiable UA, timeout, bounded retries and backoff.

    Returns None (never raises) so an upstream outage degrades to whatever the
    cache already holds instead of failing the run. `cache=False` is for large
    payloads whose raw form we do not want in memory or on disk — the caller
    extracts the small record it needs instead.
    """
    if cache and url in _cache:
        return _cache[url]
    if offline:
        return None
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                data = json.load(r)
            if cache:
                _cache[url] = data
            time.sleep(PAUSE)
            return data
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429:
                wait = int(e.headers.get("Retry-After") or (2 ** attempt))
                time.sleep(min(wait, 30))
            elif 500 <= e.code < 600:
                time.sleep(2 ** attempt)
            else:
                break
        except Exception as e:  # noqa: BLE001 - any transport failure backs off
            last = e
            time.sleep(2 ** attempt)
    print(f"  ! {url[:110]} -> {last}", file=sys.stderr)
    return None


# ---------------------------------------------------------------------------
# Wikipedia year articles
# ---------------------------------------------------------------------------

LINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]")
REF_RE = re.compile(r"<ref[^>]*?/>|<ref[^>]*?>.*?</ref>", re.S)
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
TEMPLATE_RE = re.compile(r"\{\{[^{}]*\}\}")
IMG_RE = re.compile(r"\[\[(?:File|Image):[^\]]*(?:\][^\]]*)*?\]\]", re.I)
HTML_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def clean_text(s: str) -> str:
    s = COMMENT_RE.sub("", s)
    s = REF_RE.sub("", s)
    for _ in range(4):
        s2 = TEMPLATE_RE.sub("", s)
        if s2 == s:
            break
        s = s2
    s = IMG_RE.sub("", s)
    s = LINK_RE.sub(lambda m: (m.group(2) or m.group(1)).strip(), s)
    s = s.replace("'''", "").replace("''", "")
    s = HTML_RE.sub("", s)
    s = (s.replace("&ndash;", "–").replace("&mdash;", "—").replace("&nbsp;", " ")
          .replace("&amp;", "&").replace("&quot;", '"').replace("&#160;", " "))
    return WS_RE.sub(" ", s).strip()


def link_targets(s: str) -> list[str]:
    out: list[str] = []
    for target, _label in LINK_RE.findall(s):
        t = target.strip()
        if re.match(r"^(File|Image|Category|wikt|Wiktionary|Portal|Special):", t, re.I):
            continue
        if re.match(r"^\d", t) and len(t) < 20:
            continue
        out.append(t)
    return out


def extract_events(wikitext: str, year: int) -> list[dict]:
    """Parse the Events section of a year article into candidates.

    Handles both the modern `* [[Month Day]] – text` form and older pages that
    group events under `=== Month ===` headings. Returns partial dates only as
    precise as the source: a bullet with no day gets year (or month) precision.
    """
    m = re.search(r"==\s*Events\s*==(.*?)(?=\n==[^=])", wikitext, re.S)
    if not m:
        return []
    body = m.group(1)

    events: list[dict] = []
    current_month: int | None = None
    for raw in body.split("\n"):
        line = raw.strip()
        hm = re.match(r"^==+\s*(" + MONTH_ALT + r")\s*==+", line)
        if hm:
            current_month = MONTHS[hm.group(1).lower()]
            continue
        if not line.startswith("*"):
            continue
        bullet = line.lstrip("*").strip()

        month, day = current_month, None
        dm = re.match(r"\[\[\s*(" + MONTH_ALT + r")\s+(\d{1,2})\s*(?:\|[^\]]*)?\]\]", bullet)
        dm2 = re.match(r"\[\[\s*(" + MONTH_ALT + r")\s*(?:\|[^\]]*)?\]\]", bullet)
        if dm:
            month, day = MONTHS[dm.group(1).lower()], int(dm.group(2))
            bullet = bullet[dm.end():]
            # A range opens with two linked dates: `[[July 1]]&ndash;[[July 3|3]]`.
            # Consume the second, or its label ("3") becomes the title.
            bullet = re.sub(
                r"^\s*(?:&ndash;|&mdash;|[–—\-])\s*\[\[\s*(?:" + MONTH_ALT + r")\s+\d{1,2}\s*(?:\|[^\]]*)?\]\]",
                "",
                bullet,
            )
            bullet = re.sub(
                r"^\s*\[\[\s*(?:" + MONTH_ALT + r")\s+\d{1,2}\s*(?:\|[^\]]*)?\]\]",
                "",
                bullet,
            )
        elif dm2:
            month = MONTHS[dm2.group(1).lower()]
            bullet = bullet[dm2.end():]
        else:
            # Older pages write the month bare: `* September – ...`.
            pm = re.match(r"^(" + MONTH_ALT + r")\b(?=\s*(?:&ndash;|&mdash;|[–—\-:]))", bullet, re.I)
            if pm:
                month = MONTHS[pm.group(1).lower()]
                bullet = bullet[pm.end():]

        # Trim a leading date separator, including the HTML entities the year
        # articles use (`&ndash;`), which a bare punctuation strip leaves as
        # "ndash;" glued to the sentence.
        bullet = re.sub(r"^(?:\s*(?:&ndash;|&mdash;|[–—\-:;]))+", "", bullet).strip()
        if not bullet:
            continue

        text = clean_text(bullet)
        if len(text) < 25:
            continue

        targets = link_targets(bullet)
        date = f"{year:04d}"
        precision = "year"
        if month is not None:
            date = f"{year:04d}-{month:02d}"
            precision = "month"
        if month is not None and day is not None:
            date = f"{year:04d}-{month:02d}-{day:02d}"
            precision = "day"

        title = targets[0] if targets else text
        if len(title) > 110:
            title = title[:107].rstrip() + "…"

        events.append(
            {
                "year": year,
                "date": date,
                "date_precision": precision,
                "title": derive_title(text, targets),
                "blurb": trim_blurb(text),
                "subject_title": targets[0] if targets else None,
                "all_targets": targets,
            }
        )
    return events


EVENT_WORD_RE = re.compile(
    r"\b(battle|war|treaty|siege|expedition|voyage|act|revolution|rebellion|massacre|"
    r"election|constitution|congress|conference|discovery|peace|reform|edict|decree|union|"
    r"independence|coronation|riot|earthquake|eruption|famine|plague|flood|shipwreck|premiere|"
    r"abolition|annexation|invasion|partition|unification|launch|festival|peace|pact|trial|"
    r"execution|opening|foundation|uprising|offensive|coup|assassination)\b",
    re.I,
)


def derive_title(text: str, targets: list[str]) -> str:
    """A readable event label, not merely the first entity the sentence links.

    Year-article bullets very often open with the event's name — "[[Battle of
    the Marne|Battle of the Marne]]: ..." or "Text: explanation" — but just as
    often the first link is a person or a country. Using that as the title gave
    a strip whose labels were "Portugal" and "Westminster". Prefer an event-
    shaped leading phrase; fall back to the first clause of the sentence; and
    keep the linked article for provenance regardless.
    """
    m = re.match(r"^([A-Z][^:]{5,70}):\s", text)
    if m:
        return m.group(1).strip()
    if targets and EVENT_WORD_RE.search(targets[0]):
        return targets[0]
    clause = re.split(r"(?:[.;]|\s[–—]\s)", text)[0].strip()
    # A sub-bullet often opens with a time or a log parenthetical, not a name.
    clause = re.sub(r"^\([^)]*\)\s*", "", clause)
    clause = re.sub(r"^\d{1,2}:\d{2}\s*(?:[–—\-:]\s*)?", "", clause)
    if len(clause) < 8:
        return targets[0] if targets else text[:60]
    if len(clause) > 82:
        clause = clause[:79].rsplit(" ", 1)[0].rstrip() + "…"
    return clause or (targets[0] if targets else text[:60])


def trim_blurb(text: str, limit: int = 240) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for sep in (". ", "; ", ", "):
        i = cut.rfind(sep)
        if i > 80:
            return cut[: i + 1].strip()
    return cut.rsplit(" ", 1)[0].rstrip() + "…"


def fetch_year(year: int, offline: bool) -> dict | None:
    page = wiki_year_title(year)
    q = urllib.parse.urlencode(
        {"action": "parse", "page": page, "prop": "wikitext", "format": "json", "redirects": "1"}
    )
    data = get_json(f"https://en.wikipedia.org/w/api.php?{q}", offline=offline)
    if not data or "parse" not in data:
        return None
    parse = data["parse"]
    return {
        "wikitext": parse.get("wikitext", {}).get("*", ""),
        "revid": parse.get("revid"),
        "pageid": parse.get("pageid"),
    }


def wiki_year_title(year: int) -> str:
    """Wikipedia's article title for a year. Astronomical years internally:
    year 0 is 1 BC, so -1299 is 1300 BC. Positive years are plain. This is the
    only place the BCE convention is applied on the discovery side."""
    return str(year) if year > 0 else f"{1 - year} BC"


# ---------------------------------------------------------------------------
# Wikidata resolution
# ---------------------------------------------------------------------------


def wbget(url: str, offline: bool) -> dict | None:
    return get_json(url, offline=offline)


def resolve_titles(titles: list[str], offline: bool) -> dict[str, dict]:
    """Resolve English Wikipedia titles to Wikidata entities, batched 40 at a
    time. Returns {title: {qid, description, lat, lng, sitelinks}}.

    Only the compact record is kept: a raw `wbgetentities` payload carries every
    claim of every entity, and caching thousands of those costs a gigabyte of
    RAM and a hundred megabytes of cache for six small fields. The response is
    therefore read once and discarded; the extracted record is what persists.
    """
    out: dict[str, dict] = {}
    store: dict[str, dict] = _cache.setdefault("__entities__", {})
    uniq = sorted({t for t in titles if t})
    missing: list[str] = []
    for t in uniq:
        if t in store:
            out[t] = store[t]
        else:
            missing.append(t)
    for i in range(0, len(missing), 40):
        batch = missing[i : i + 40]
        q = urllib.parse.urlencode(
            {
                "action": "wbgetentities",
                "sites": "enwiki",
                "titles": "|".join(batch),
                "format": "json",
                "props": "descriptions|claims|sitelinks|labels",
                "languages": "en",
                "redirects": "yes",
            }
        )
        data = get_json(f"https://www.wikidata.org/w/api.php?{q}", offline=offline, cache=False)
        if not data:
            continue
        norm = {n["from"]: n["to"] for n in data.get("normalized", [])}
        redir = {r["from"]: r["to"] for r in data.get("redirects", [])}
        by_title: dict[str, dict] = {}
        for qid, ent in (data.get("entities") or {}).items():
            if qid.startswith("-") or not isinstance(ent, dict):
                continue
            sl = (ent.get("sitelinks") or {}).get("enwiki")
            title = sl.get("title") if sl else None
            rec = entity_record(qid, ent, title)
            if title:
                by_title[title] = rec
        for t in batch:
            t2 = norm.get(t, t)
            t2 = redir.get(t2, t2)
            rec = by_title.get(t2) or by_title.get(t)
            if rec:
                store[t] = rec
                out[t] = rec
        if i % 400 == 0:
            cache_save()
            print(f"    entities: {min(i + 40, len(missing))}/{len(missing)}")
    cache_save()
    return out


def entity_record(qid: str, ent: dict, title: str | None) -> dict:
    desc = ((ent.get("descriptions") or {}).get("en") or {}).get("value")
    lat = lng = None
    try:
        for claim in (ent.get("claims") or {}).get("P625", []):
            v = claim["mainsnak"]["datavalue"]["value"]
            if v.get("globe", "http://www.wikidata.org/entity/Q2") != "http://www.wikidata.org/entity/Q2":
                continue
            lat, lng = float(v["latitude"]), float(v["longitude"])
            break
    except Exception:
        pass
    return {
        "qid": qid,
        "description": desc,
        "latitude": lat,
        "longitude": lng,
        "sitelinks": len(ent.get("sitelinks") or {}),
        "title": title,
    }


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

CATEGORY_KEYWORDS: list[tuple[str, list[str]]] = [
    ("conflict", ["battle", "war", "siege", "invasion", "invade", "army", "troops", "revolt",
                  "rebellion", "revolution", "massacre", "bombard", "fleet", "navy", "conquer",
                  "defeat", "uprising", "raid", "mutiny", "truce", "occupy", "occupation",
                  "attack", "sunk", "sink", "blockade", "captured", "offensive"]),
    ("disaster", ["earthquake", "flood", "famine", "plague", "eruption", "shipwreck", "epidemic",
                  "drought", "fire destroys", "cyclone", "tsunami", "volcanic", "colliery",
                  "disaster", "storm"]),
    ("science", ["invention", "astronomer", "physics", "telescope", "theory", "patent",
                 "observatory", "scientist", "mathematic", "comet", "planet", "experiment",
                 "vaccine", "evolution", "chemistry", "discover", "observations",
                 "measur", "anatomy", "geolog"]),
    ("exploration", ["expedition", "voyage", "explore", "reach", "sail", "landfall",
                     "chart", "circumnavig", "first to", "crossing", "pole", "survey",
                     "arriv", "depart", "coast", "strait", "cape", "island", "land",
                     "discover"]),
    ("trade", ["trade", "merchant", "company", "commerce", "spice", "silk", "tariff",
               "market", "economy", "bank", "currency", "harbour", "harbor", "export",
               "import", "shipping"]),
    ("religion", ["pope", "church", "bishop", "monastery", "temple", "islam", "christian",
                  "crusade", "religion", "synod", "jesuit", "protestant", "catholic",
                  "hindu", "buddhis", "mosque", "clergy"]),
    ("culture", ["painting", "composer", "opera", "cathedral", "literature", "poet", "play",
                 "architecture", "festival", "novel", "symphony", "museum", "university",
                 "college", "theatre", "theater", "palace", "built", "complete", "opened",
                 "opening", "premiere", "publish", "exhibition", "sculpt", "founded",
                 "established", "academy", "library"]),
    ("politics", ["treaty", "king", "queen", "emperor", "empire", "parliament", "constitution",
                  "elected", "election", "coronation", "dynasty", "republic", "independence",
                  "annex", "decree", "charter", "assassinat", "abdicat", "capital",
                  "abolition", "law", "act", "bill", "reform", "minister", "president",
                  "congress", "partition", "unification", "independence", "declaration",
                  "union", "govern", "throne", "succession"]),
]


def classify(text: str) -> str:
    low = text.lower()
    best, best_hits = "culture", 0
    for cat, words in CATEGORY_KEYWORDS:
        hits = sum(1 for w in words if w in low)
        if hits > best_hits:
            best, best_hits = cat, hits
    return best


REGION_BOXES: list[tuple[str, float, float, float, float]] = [
    ("Europe", 35, 72, -12, 45),
    ("North Africa & the Mediterranean", 20, 37, -18, 40),
    ("Sub-Saharan Africa", -36, 20, -20, 52),
    ("Middle East & Central Asia", 12, 55, 25, 90),
    ("South Asia", 5, 38, 60, 92),
    ("East Asia", 18, 55, 92, 150),
    ("Southeast Asia & Oceania", -50, 25, 92, 180),
    ("North America", 15, 75, -170, -50),
    ("Latin America & the Caribbean", -56, 33, -120, -30),
    ("Polar regions", -90, -36, -180, 180),
]


def region_for(lat: float | None, lng: float | None, text: str = "") -> str:
    if lat is not None and lng is not None:
        for name, minlat, maxlat, minlng, maxlng in REGION_BOXES:
            if minlat <= lat <= maxlat and minlng <= lng <= maxlng:
                return name
    return "World"


# ---------------------------------------------------------------------------
# Voyage inputs
# ---------------------------------------------------------------------------

YEAR_RE = re.compile(r"(-?\d{1,4})")


def year_of(value) -> int | None:
    """A signed astronomical year from voyage metadata.

    Accepts signed ISO ("-1299") and the historical spellings an editor is
    likely to write ("1300 BC", "1300 BCE"). 1 BC maps to year 0, so "1300 BC"
    becomes -1299 — the same convention `wiki_year_title` reverses.
    """
    if value is None:
        return None
    s = str(value).strip()
    m = YEAR_RE.search(s)
    if not m:
        return None
    y = int(m.group(1))
    low = s.lower()
    if "bc" in low or "bce" in low:
        y = -(abs(y) - 1)
    return y


def load_gazetteer_places() -> dict[str, list[str]]:
    """slug -> [QID, ...] from the committed gazetteer."""
    out: dict[str, list[str]] = {}
    path = DATA / "gazetteer.json"
    if not path.exists():
        return out
    try:
        places = json.loads(path.read_text()).get("places", [])
    except Exception:
        return out
    for place in places:
        qid = place.get("qid")
        for v in place.get("voyages", []) or []:
            out.setdefault(v, []).append(qid)
    return out


def load_voyages() -> list[dict]:
    out = []
    for path in sorted(DATA.glob("*.json")):
        if path.name in {"gazetteer.json", "gazetteer-decisions.json", "space_events.json",
                         "world_events.json", "historical-events.json",
                         "world-events-voyages.json", "world-events-coverage.json"}:
            continue
        try:
            d = json.loads(path.read_text())
        except Exception:
            continue
        if not isinstance(d, dict) or "voyage" not in d:
            continue
        out.append(d)
    return out


def build_voyage_input(bundle: dict, places: dict[str, list[str]], navigator_qids: dict[str, str]) -> dict:
    v = bundle["voyage"]
    nav = bundle.get("navigator") or {}
    slug = v.get("slug")
    start = year_of(v.get("start_date"))
    end = year_of(v.get("end_date"))
    waypoints = bundle.get("waypoints") or []
    if start is None:
        ys = [year_of(w.get("arrival_date")) for w in waypoints]
        ys = [y for y in ys if y is not None]
        if ys:
            start, end = min(ys), max(ys)
    end = end if end is not None else start
    keywords = [nav.get("name"), v.get("ships"), v.get("sponsor"), v.get("purpose")]
    for w in waypoints:
        for field in ("place_historical", "place_modern"):
            if w.get(field):
                keywords.append(w[field])
    wp = [
        {"latitude": w.get("latitude"), "longitude": w.get("longitude")}
        for w in waypoints
        if isinstance(w.get("latitude"), (int, float)) and isinstance(w.get("longitude"), (int, float))
    ]
    return {
        "slug": slug,
        "start_year": start,
        "end_year": end,
        "navigator_qid": navigator_qids.get((nav.get("name") or "").strip()),
        "place_qids": sorted(set(places.get(slug, []))),
        "waypoints": wp,
        "keywords": [k for k in keywords if isinstance(k, str) and k.strip()],
    }


def resolve_navigators(names: list[str], offline: bool) -> dict[str, str]:
    out: dict[str, str] = {}
    for name in sorted({n.strip() for n in names if n and n.strip()}):
        key = f"search:{name}"
        if key in _cache:
            hits = _cache[key]
        elif offline:
            continue
        else:
            q = urllib.parse.urlencode(
                {"action": "wbsearchentities", "search": name, "language": "en",
                 "format": "json", "limit": 1, "type": "item"}
            )
            data = wbget(f"https://www.wikidata.org/w/api.php?{q}", offline)
            hits = (data or {}).get("search") or []
            _cache[key] = hits
        if hits:
            out[name] = hits[0]["id"]
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="use cache only, never fetch")
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    ap.add_argument("--voyage", help="limit to one slug")
    ap.add_argument("--max-years", type=int, default=0, help="cap year fetches (debug)")
    args = ap.parse_args()

    cache_load()
    bundles = load_voyages()
    if args.voyage:
        bundles = [b for b in bundles if b["voyage"].get("slug") == args.voyage]
        if not bundles:
            print(f"unknown voyage: {args.voyage}", file=sys.stderr)
            return 2

    # The union of every voyage's window, so a year is fetched once.
    needed_years: set[int] = set()
    for b in bundles:
        v = b["voyage"]
        s = year_of(v.get("start_date"))
        e = year_of(v.get("end_date"))
        if s is None:
            ys = [year_of(w.get("arrival_date")) for w in (b.get("waypoints") or [])]
            ys = [y for y in ys if y is not None]
            if ys:
                s, e = min(ys), max(ys)
        if s is None:
            continue
        e = e if e is not None else s
        needed_years.update(range(s - WINDOW_SLACK, e + WINDOW_SLACK + 1))
    years = sorted(needed_years)
    if args.max_years:
        years = years[: args.max_years]
    print(f"voyages: {len(bundles)}  years to harvest: {len(years)}")

    # 1. Harvest year articles.
    raw_events: list[dict] = []
    for i, year in enumerate(years, 1):
        page = fetch_year(year, args.offline)
        if not page:
            continue
        evs = extract_events(page["wikitext"], year)
        for e in evs:
            e["source_revision"] = f"enwiki:{page.get('pageid')}:{page.get('revid')}"
        raw_events.extend(evs)
        if i % 25 == 0 or i == len(years):
            print(f"  year {i}/{len(years)} ({year}) — candidates so far: {len(raw_events)}")
            cache_save()
    cache_save()
    print(f"candidates: {len(raw_events)}")

    # 2. Resolve QIDs/coordinates/sitelinks for the subjects.
    subjects = [e.get("subject_title") for e in raw_events]
    print("resolving Wikidata entities…")
    entities = resolve_titles([s for s in subjects if s], args.offline)
    cache_save()
    print(f"  resolved {len(entities)} entities")

    # 3. Normalise into catalogue records, dedup by QID or identity.
    catalogue: dict[str, dict] = {}
    for e in raw_events:
        ent = entities.get(e.get("subject_title") or "", {})
        qid = ent.get("qid")
        text = f"{e['title']}. {e['blurb']}"
        category = classify(text)
        lat, lng = ent.get("latitude"), ent.get("longitude")
        region = region_for(lat, lng, text)
        sitelinks = ent.get("sitelinks") or 0
        identity = f"qid:{qid}" if qid else "id:" + hashlib.sha1(
            f"{e['date']}|{e['title']}".lower().encode()
        ).hexdigest()[:16]
        rec = {
            "id": f"wev:{qid}" if qid else f"wev:{identity.split(':',1)[1]}",
            "date": e["date"],
            "date_precision": e["date_precision"],
            "title": e["title"],
            "blurb": e["blurb"],
            "category": category,
            "region": region,
            "qid": qid,
            "wikipedia_url": f"https://en.wikipedia.org/wiki/{urllib.parse.quote((e.get('subject_title') or e['title']).replace(' ', '_'))}",
            "wikidata_url": f"https://www.wikidata.org/wiki/{qid}" if qid else None,
            "source_language": "en",
            "retrieved_at": RETRIEVED_AT,
            "source_revision": e.get("source_revision"),
            "discovery_source": "wikipedia-year",
            "latitude": lat,
            "longitude": lng,
            "sitelinks": sitelinks,
            "confidence": "validated" if (qid and ent.get("description") and e["date"]) else "partial",
        }
        prev = catalogue.get(identity)
        if prev is None or _better(rec, prev):
            catalogue[identity] = rec

    # 4. Filter trivia and bound per year, deterministically.
    by_year: dict[str, list[dict]] = {}
    for rec in catalogue.values():
        if (rec.get("sitelinks") or 0) < POLICY_MIN_SITELINKS and rec["confidence"] != "validated":
            continue
        by_year.setdefault(date_year(rec["date"]), []).append(rec)
    kept: list[dict] = []
    for year in sorted(by_year):
        ranked = sorted(
            by_year[year],
            key=lambda r: (-(r.get("sitelinks") or 0), r["date"], r["id"]),
        )[:MAX_PER_YEAR]
        kept.extend(ranked)
    kept.sort(key=lambda r: (r["date"], r["id"]))
    print(f"catalogue events kept: {len(kept)}")

    # 5. Voyage scoring inputs.
    places = load_gazetteer_places()
    nav_names = [(b.get("navigator") or {}).get("name") or "" for b in bundles]
    print("resolving navigators…")
    nav_qids = resolve_navigators(nav_names, args.offline)
    inputs = {b["voyage"]["slug"]: build_voyage_input(b, places, nav_qids) for b in bundles}

    if args.dry_run:
        for slug, vi in inputs.items():
            print(f"  {slug}: window {vi['start_year']}–{vi['end_year']} places={len(vi['place_qids'])} wps={len(vi['waypoints'])}")
        return 0

    CATALOGUE_PATH.write_text(json.dumps(
        {
            "generated_at": RETRIEVED_AT,
            "source": "Wikipedia year articles via MediaWiki API; structured with Wikidata (wbgetentities).",
            "attribution": "Contains information from Wikipedia and Wikidata, available under CC BY-SA 4.0 and CC0 respectively.",
            "events": kept,
        },
        ensure_ascii=False,
        indent=1,
    ))
    VOYAGE_INPUT_PATH.write_text(json.dumps(inputs, ensure_ascii=False, indent=1))
    cache_save()
    print(f"wrote {CATALOGUE_PATH.name} and {VOYAGE_INPUT_PATH.name}")
    print("next: npx tsx scripts/build_world_event_projection.ts")
    return 0


def date_year(date: str) -> str:
    """The year field of a partial date, sign included; `str[:4]` is wrong for
    negative years ("-1300" would become "-130")."""
    m = re.match(r"(-?\d{1,4})", date)
    return m.group(1) if m else date


def _better(a: dict, b: dict) -> bool:
    rank = {"validated": 2, "partial": 1}
    ka = (rank.get(a["confidence"], 0), a.get("sitelinks") or 0, a["date_precision"] == "day")
    kb = (rank.get(b["confidence"], 0), b.get("sitelinks") or 0, b["date_precision"] == "day")
    return ka > kb


if __name__ == "__main__":
    sys.exit(main())
