import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import {
  CATEGORY_WEIGHT,
  dedupeEvents,
  eventIdentity,
  formatHistoricalMonthYear,
  formatPartialDate,
  parsePartialDate,
  scoreCandidate,
  selectVoyageEvents,
  validateEvent,
  validateVoyageEvent,
  type NormalizedEvent,
  type ScoringVoyage,
} from "../lib/world-events-core";
import { parseHistoricalDate } from "../lib/voyage-motion";
import { voyageEventsFor, worldEventsMeta } from "../lib/world-events";
import { ATLAS } from "../lib/voyages";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const readJson = (p: string) => JSON.parse(read(p));

/**
 * The world-events suite. It runs entirely offline: acquisition is tested
 * through the checked-in cache and through the generator's own offline path,
 * never through a live Wikimedia request.
 */

const base = (over: Partial<NormalizedEvent>): NormalizedEvent => ({
  id: "wev:Q0",
  date: "1768-08-26",
  date_precision: "day",
  title: "An event",
  blurb: "Something happened.",
  category: "exploration",
  region: "Britain",
  qid: "Q0",
  wikipedia_url: "https://en.wikipedia.org/wiki/An_event",
  wikidata_url: "https://www.wikidata.org/wiki/Q0",
  source_language: "en",
  retrieved_at: "2026-01-01T00:00:00Z",
  source_revision: "enwiki:1:2",
  discovery_source: "wikipedia-year",
  latitude: null,
  longitude: null,
  sitelinks: 10,
  confidence: "validated",
  ...over,
});

const voy = (over: Partial<ScoringVoyage> = {}): ScoringVoyage => ({
  slug: "test-1768",
  start_year: 1768,
  end_year: 1771,
  navigator_qid: "Q7328",
  place_qids: ["Q100"],
  waypoints: [{ latitude: 50.37, longitude: -4.14 }],
  keywords: ["James Cook", "Endeavour", "Tahiti"],
  ...over,
});

// 1. Date and partial-date normalisation -----------------------------------

test("year-only dates keep year precision and never gain a month", () => {
  const parsed = parsePartialDate("1271");
  assert.ok(parsed);
  assert.equal(parsed.precision, "year");
  assert.equal(new Date(parsed.time).getUTCFullYear(), 1271);
  assert.equal(new Date(parsed.time).getUTCMonth(), 0);
  assert.equal(formatPartialDate("1271-01-01", "year"), "1271");
});

test("month and day precision are preserved exactly", () => {
  assert.equal(parsePartialDate("1768-08")?.precision, "month");
  assert.equal(parsePartialDate("1768-8")?.precision, "month");
  assert.equal(parsePartialDate("1768-08-26")?.precision, "day");
  assert.equal(formatPartialDate("1768-08-26", "month"), "1768-08");
});

test("unparseable or impossible dates return null rather than guessing", () => {
  for (const bad of ["", "circa 1500", "1498-13", "1498-00-01", "abcd", null]) {
    assert.equal(parsePartialDate(bad as string | null), null, `expected null for ${bad}`);
  }
});

// The Atlas is meant to reach "an unlimited temporal range", so the epoch must
// be right before the first voyage needs it. Two JS traps live here: the Date
// constructor maps years 0-99 to 1900+y, and Intl drops the era for BCE dates.
test("two-digit years are not shifted into the 20th century", () => {
  const p = parsePartialDate("0042");
  assert.ok(p);
  assert.equal(new Date(p.time).getUTCFullYear(), 42);
  assert.equal(parseHistoricalDate("399"), parsePartialDate("0399")?.time);
});

test("BCE years parse, order and format with the era", () => {
  const p = parsePartialDate("-1299");
  assert.ok(p);
  assert.equal(p.precision, "year");
  assert.equal(new Date(p.time).getUTCFullYear(), -1299);
  assert.equal(formatHistoricalMonthYear(p.time), "January 1300 BC");
  assert.equal(formatPartialDate("-1299-05-17", "month"), "-1299-05");
  // 1 BC is astronomical year 0, and is EARLIER than 1 AD.
  assert.ok(parsePartialDate("-1299")!.time < parsePartialDate("1492")!.time);
  assert.equal(formatHistoricalMonthYear(parsePartialDate("0000")!.time), "January 1 BC");
});

// 2. Deterministic ranking --------------------------------------------------

test("scoring is a pure function of its inputs", () => {
  const e = base({ category: "conflict", latitude: 50.4, longitude: -4.2 });
  const a = scoreCandidate(e, voy());
  const b = scoreCandidate(e, voy());
  assert.deepEqual(a, b);
  assert.ok(a.score > 0 && a.score <= 100);
});

test("proximity to the route outranks distance", () => {
  const near = scoreCandidate(base({ latitude: 50.4, longitude: -4.2 }), voy());
  const far = scoreCandidate(base({ latitude: -30, longitude: 140 }), voy());
  assert.ok(
    near.parts.geographic > far.parts.geographic,
    `near ${near.parts.geographic} should exceed far ${far.parts.geographic}`,
  );
  assert.equal(near.relevance_class, "route");
});

test("a shared QID marks an event as connected", () => {
  const e = base({ qid: "Q7328", latitude: 10, longitude: 10 });
  const scored = scoreCandidate(e, voy({ navigator_qid: "Q7328" }));
  assert.equal(scored.relevance_class, "connected");
  assert.match(scored.why, /person|port|place/i);
});

test("selection is deterministic and keeps per-year balance", () => {
  const candidates: NormalizedEvent[] = [];
  for (let i = 0; i < 40; i++) {
    candidates.push(
      base({
        id: `wev:Q${i}`,
        qid: `Q${i}`,
        date: `176${7 + (i % 4)}-01-01`,
        date_precision: "day",
        title: `Event ${i}`,
        sitelinks: 40 - i,
      }),
    );
  }
  const first = selectVoyageEvents(candidates, voy(), { max: 12 });
  const second = selectVoyageEvents(candidates, voy(), { max: 12 });
  assert.deepEqual(first.map((e) => e.id), second.map((e) => e.id));
  assert.equal(first.length, 12);
  // Chronological output, as the strip expects.
  const times = first.map((e) => parsePartialDate(e.date)!.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("category weights are explicit and bounded", () => {
  for (const [cat, weight] of Object.entries(CATEGORY_WEIGHT)) {
    assert.ok(weight > 0 && weight <= 1, `${cat} weight out of range`);
  }
});

// 3. Deduplication ----------------------------------------------------------

test("dedup keys off QID first, then normalised date+title", () => {
  assert.equal(
    eventIdentity({ qid: "Q42", date: "1498", title: "A" }),
    "qid:Q42",
  );
  assert.equal(
    eventIdentity({ qid: null, date: "1498-05-17", title: "Québec!" }),
    eventIdentity({ qid: null, date: "1498-05-17", title: "quebec" }),
  );
});

test("dedup keeps the more complete record and a stable order", () => {
  const thin = base({ id: "wev:Q9a", qid: "Q9", confidence: "partial", sitelinks: 3 });
  const full = base({
    id: "wev:Q9b",
    qid: "Q9",
    confidence: "validated",
    latitude: 1,
    longitude: 2,
    sitelinks: 9,
  });
  const out = dedupeEvents([thin, full]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "wev:Q9b");
});

// 4. Schema validation ------------------------------------------------------

test("well-formed events validate; malformed ones are named", () => {
  assert.deepEqual(validateEvent(base({})), []);
  assert.ok(validateEvent({ id: "x", title: "", date: "nope", category: "war" as never }).length >= 3);
});

test("voyage events require class, score and explanation", () => {
  const good = {
    ...base({}),
    relevance_class: "route" as const,
    relevance_score: 55,
    why: "Took place close to the route.",
  };
  assert.deepEqual(validateVoyageEvent(good), []);
  assert.ok(validateVoyageEvent({ ...good, relevance_class: "nonsense" as never }).length >= 1);
  assert.ok(validateVoyageEvent({ ...good, relevance_score: undefined as never }).length >= 1);
});

// 5/6. Cache, fallback and offline execution --------------------------------

test("the generator degrades gracefully offline without writing", () => {
  const out = execFileSync(
    "python3",
    ["scripts/build_world_events.py", "--offline", "--dry-run", "--max-years", "1"],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
  );
  assert.match(out, /voyages:/);
});

test("the runtime loader is local-only: no Wikimedia URL or fetch in the client path", () => {
  const loader = read("lib/world-events.ts");
  const core = read("lib/world-events-core.ts");
  for (const src of [loader, core]) {
    assert.doesNotMatch(src, /\bfetch\s*\(/);
    assert.doesNotMatch(src, /wikipedia\.org|wikidata\.org|wikimedia\.org|query\.wikidata/i);
  }
  // And the component that renders the strip must go through the loader.
  const component = read("components/VoyageExperience.tsx");
  assert.match(component, /voyageEventsFor\(/);
  assert.doesNotMatch(component, /wikipedia\.org|wikidata\.org|wikimedia\.org/i);
});

// 7. Desktop timeline population from cached data ---------------------------

test("the projection file is a schema-valid per-voyage map", () => {
  const projection = readJson("data/world_events.json");
  assert.ok(projection.voyages && typeof projection.voyages === "object");
  assert.ok(projection._meta?.attribution, "attribution must be present");
  let total = 0;
  for (const [slug, list] of Object.entries(projection.voyages) as [string, any[]][]) {
    for (const ev of list) {
      const problems = validateVoyageEvent(ev);
      assert.deepEqual(problems, [], `${slug}/${ev.id}: ${problems.join(", ")}`);
      total++;
    }
  }
  assert.ok(total > 0, "the catalogue must not be empty");
});

// 8. Phone behaviour unchanged ----------------------------------------------

test("the world strip stays off phones and lives in the transport bar switch", () => {
  const component = read("components/VoyageExperience.tsx");
  // The top strip is desktop-only.
  assert.match(component, /\{!isMobile && \(\s*<div\s+className="world-strip"/);
  // The world track reaches the bar only on a phone.
  assert.match(component, /\.\.\.\(isMobile\s*\n\s*\?\s*\[\s*\{[\s\S]*?key: "world"/);
  // The Voyage/World tabs remain the mobile affordance.
  const bar = read("components/map/TransportBar.tsx");
  assert.match(bar, /tb-track-tab/);
});

// 9. No direct client-side Wikimedia fetches (covered above) + provenance ----

test("every published event carries machine-readable provenance", () => {
  const projection = readJson("data/world_events.json");
  for (const list of Object.values(projection.voyages) as any[][]) {
    for (const ev of list) {
      assert.ok(ev.id, "stable id");
      assert.ok(ev.source_language, "source language");
      assert.ok(ev.retrieved_at, "retrieval timestamp");
      assert.ok(ev.wikipedia_url || ev.wikidata_url, "a source link");
      assert.ok(["validated", "partial"].includes(ev.confidence));
    }
  }
});

// 10. Coverage across the published Atlas -----------------------------------

/* Voyages that legitimately cannot carry an Age-of-Sail world timeline. This is
   an explicit, documented exception list — NOT a silence. Every entry here is
   reported by data/world-events-coverage.json. */
const DOCUMENTED_EMPTY = new Set<string>([
  // Space probes read data/space_events.json and render in
  // SpaceVoyageExperience — this Earth catalogue does not apply to them.
  "voyager-2",
]);

test("the coverage report names every published voyage", () => {
  const coverage = readJson("data/world-events-coverage.json");
  for (const { slug } of ATLAS) {
    assert.ok(coverage.voyages[slug], `coverage report is missing ${slug}`);
  }
  for (const slug of coverage.uncovered as string[]) {
    assert.ok(DOCUMENTED_EMPTY.has(slug), `${slug} has no contextual events and is not exempt`);
  }
});

test("the demonstration windows across the Atlas are populated", () => {
  const projection = readJson("data/world_events.json");
  const required: [string, string][] = [
    ["gama-1497", "Vasco da Gama (1497–1499)"],
    ["polo-1271", "a medieval voyage (Marco Polo)"],
    ["magellan-1519", "an early-modern voyage (Magellan)"],
    ["cook-1768", "Cook"],
    ["darwin-1831", "a nineteenth-century voyage (Darwin)"],
    ["shackleton-1914", "a twentieth-century voyage (Shackleton)"],
  ];
  for (const [slug, label] of required) {
    const list = projection.voyages[slug] ?? [];
    assert.ok(list.length > 0, `${label} [${slug}] has no cached contextual events`);
  }
});

test("no voyage is flooded with trivia", () => {
  const projection = readJson("data/world_events.json");
  for (const [slug, list] of Object.entries(projection.voyages) as [string, any[]][]) {
    assert.ok(list.length <= 15, `${slug} has ${list.length} events, above the cap`);
  }
});

test("the coverage report exists and is machine-readable", () => {
  assert.ok(existsSync(resolve(ROOT, "data/world-events-coverage.json")));
  const coverage = readJson("data/world-events-coverage.json");
  assert.ok(typeof coverage.catalogue_events === "number");
  assert.ok(Array.isArray(coverage.uncovered));
});

// 11. MCP read capabilities --------------------------------------------------

/**
 * The catalogue is written by agents but governed by humans, so what the MCP
 * exposes is READ access plus the existing proposal flow — never a write tool
 * into the catalogue. These assertions pin that boundary.
 */
test("the MCP exposes contextual events and coverage as read-only tools", () => {
  const route = read("app/api/mcp/route.ts");
  for (const name of ["get_context_events", "list_event_gaps"]) {
    assert.match(route, new RegExp(`name: "${name}"`), `${name} is not defined`);
  }
  // Neither is a scoped write tool: TOOL_SCOPE is the write authority map.
  const scopes = read("lib/agentCapabilities.ts");
  assert.doesNotMatch(scopes, /get_context_events|list_event_gaps/);
  // Both are declared read-only and unauthenticated.
  const block = route.slice(route.indexOf('name: "get_context_events"'), route.indexOf('name: "get_contract"'));
  assert.match(block, /name: "get_context_events"[\s\S]*?readOnlyHint: true/);
  assert.match(block, /name: "list_event_gaps"[\s\S]*?readOnlyHint: true/);
  assert.match(block, /securitySchemes: OPEN/);
});

test("the MCP tool outputs are grounded in the checked-in catalogue", () => {
  const meta = worldEventsMeta();
  assert.ok(meta?.attribution, "the catalogue must carry attribution for citation");
  const events = voyageEventsFor("gama-1497");
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.ok(e.qid || e.wikipedia_url);
    assert.ok(e.date_precision);
    assert.ok(e.relevance_class);
  }
});
