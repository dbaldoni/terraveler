# World events — the "Meanwhile in the world" catalogue

## The problem this replaced

`data/world_events.json` was 21 hand-written events covering 1767–1769 and
1785–1788. The desktop strip filtered them correctly, but Vasco da Gama
(1497–1499) and most of the Atlas got zero dots. The renderer was never the
defect; the data was.

## Architecture

```
Wikipedia year articles  ──►  scripts/build_world_events.py
  (MediaWiki API, discovery)        │  normalise, classify, dedup by QID
                                    ▼
                        data/historical-events.json      (shared catalogue, audit)
                        data/world-events-voyages.json   (per-voyage scoring inputs)
                                    │
                                    ▼
                        scripts/build_world_event_projection.ts
                          selectVoyageEvents() in lib/world-events-core.ts
                                    │
                                    ▼
                        data/world_events.json           (per-voyage projection, client)
                        data/world-events-coverage.json  (coverage report)
```

Discovery uses the Wikipedia year index because every year article is a
curated, dated list of globally notable events and it is available for the
whole span of the Atlas (399–1977). Each candidate is then structured through
the Wikidata API: its QID, English description, Earth coordinates, sitelink
count and article link. A WDQS discovery adapter can be added later without
touching the scorer; the pipeline keeps acquisition and ranking apart.

**The client never calls Wikimedia.** `lib/world-events.ts` reads the checked-in
projection only, so the strip keeps working when upstream is down.

## Files

| File | Role |
|---|---|
| `lib/world-events-core.ts` | Pure model: partial dates, dedup, validation, deterministic scoring, selection. No data import — runs in tests and in the build step. |
| `lib/world-events.ts` | Runtime loader (`voyageEventsFor`). Re-exports the core. Never fetches. |
| `scripts/build_world_events.py` | Acquisition. Cache, retries, backoff, 429 handling, dedup, classification. |
| `scripts/build_world_event_projection.ts` | Ranks the catalogue per voyage with the tested scorer. |
| `data/historical-events.json` | Normalised shared catalogue (not in the browser bundle). |
| `data/world-events-voyages.json` | Per-voyage scoring inputs (window, waypoints, QIDs, keywords). |
| `data/world_events.json` | The per-voyage projection the client imports. |
| `data/world-events-coverage.json` | Coverage report; names every uncovered voyage. |

## Refreshing the catalogue

```bash
npm run events:build          # harvest + rank + write all four artifacts
npm run events:project        # re-rank only (uses the existing catalogue)
python3 scripts/build_world_events.py --offline --dry-run   # no network, report only
```

The acquisition cache is `.world-events-cache.json` (gitignored, regenerable).
A build never depends on a successful live query: the generated JSON is
checked in.

### Automatic refresh

`.github/workflows/world-events-refresh.yml` runs monthly (`cron: 17 4 1 * *`)
and on demand. It harvests, re-ranks, runs the test suite, and **opens a pull
request** with the four data files — it never commits to `main` by itself. The
machine proposes; a human reviews the coverage report and authorises. On a VPS,
the same job is `npm run events:build` on a cron of your choosing.

### Unlimited temporal range (BCE and early years)

Astronomical years are the internal convention everywhere: **year 0 is 1 BC**,
so `1300 BC` is `-1299`. The generators accept `1300 BC`/`1300 BCE` and signed
`-1299`; Wikipedia discovery maps `-1299` to the article `1300 BC`. Two JS traps
are closed in `lib/voyage-motion.ts` and `lib/world-events-core.ts`:

- `Date.UTC(42, …)` means 1942, not year 42 — `utcTimestamp()` uses
  `setUTCFullYear` instead, so every year from BCE to the present is correct;
- `Intl.DateTimeFormat` drops the era for BCE, so `formatHistoricalMonthYear()`
  renders `January 1300 BC` explicitly.

A future voyage before the Common Era (e.g. a Biblical journey) only needs its
bundle dates in signed years or `N BC`; the pipeline and the timeline follow.

## Relevance model

Every candidate is scored deterministically against each voyage:

| Signal | Weight | Meaning |
|---|---|---|
| temporal | 1.0 | overlap with the voyage window, decaying outside it |
| significance | 1.5 | Wikidata sitelink count, log-scaled |
| geographic | 0.8 | proximity to route/waypoints, `exp(-km/450)` |
| connected | 1.5 | shared QID with navigator, port or place; keyword overlap |
| thematic | 0.8 | category weight (conflict, politics, exploration weighted up) |
| quality | 0.4 | completeness of structured source data |

Classes: `connected` (shared QID/keywords), `route` (geographic score ≥ 0.30),
`world` (globally notable and contemporary). Selection keeps the top events
with a per-year cap so one busy year cannot crowd out the voyage, then returns
them in chronological order, capped at 15.

## Provenance and licensing

Every event carries a stable id (`wev:<QID>` or a content hash), partial date
with precision, title, source-derived blurb, category, region, QID, Wikipedia
and Wikidata URLs, source language, retrieval timestamp, the source page
revision, coordinates and confidence. The strip renders the source link, the
QID and "Wikipedia / Wikidata · CC BY-SA". Partial dates are never promoted to
day or month precision. Blurbs are the source's own wording, trimmed — no
model invents a date or an event.

## Known limitations

- Blurb text is drawn from year-article prose (CC BY-SA) and is not a
  paraphrase; the link is the claim's address.
- Titles are derived heuristically from the bullet and can be awkward where the
  source links a person or country before the event.
- `{{HMS|Beagle}}`-style templates are dropped rather than expanded, so a few
  blurbs lack a ship name.
- Region is a coarse bounding-box inference, explicitly approximate.
- An LLM may later assist with classification or rewriting offline, but it is
  never in the render path and never authoritative for dates or facts.
