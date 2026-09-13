/**
 * Contextual world events for a voyage's "Meanwhile in the world" strip.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The strip used to read a flat, hand-written `data/world_events.json` of 21
 * events covering 1767–1769 and 1785–1788. Vasco da Gama (1497–1499) therefore
 * got zero dots and most of the Atlas drew an empty timeline. The data problem
 * was real; the renderer was not.
 *
 * The runtime authority is now a generated, normalised catalogue. The client
 * never calls Wikimedia: it renders from the checked-in cache, so the strip
 * keeps working when the network does not. Acquisition lives in
 * `scripts/build_world_events.py`; everything here is pure and testable.
 *
 * RELATIONSHIP TO THE CATALOGUE
 * -----------------------------
 * `data/historical-events.json` holds the normalised shared catalogue (one
 * record per event, keyed by Wikidata QID where one exists) with full
 * provenance. `data/world_events.json` is the per-voyage projection the client
 * imports: for each slug, the selected events with their relevance class,
 * score and explanation. Keeping the projection per-voyage is what stops a
 * multi-megabyte catalogue entering the browser bundle.
 *
 * A period-accurate blurb is never invented here. It is the source's own
 * wording, trimmed; the link beside it is the claim's address. Partial dates
 * keep their precision: a year-only event is not silently promoted to January.
 */

import { utcTimestamp } from "./voyage-motion";

export type EventCategory =
  | "politics"
  | "conflict"
  | "science"
  | "culture"
  | "exploration"
  | "trade"
  | "religion"
  | "disaster";

/** The three conceptual classes the ranking model works in. They are not yet
 *  three panels; they are metadata and future extensibility. */
export type RelevanceClass = "world" | "route" | "connected";

/** How precise a historical date is. Never invent day or month precision the
 *  source did not give. */
export type DatePrecision = "day" | "month" | "year";

export type Confidence = "validated" | "partial";

/** The normalised, shared record. One per event. */
export interface NormalizedEvent {
  /** Stable internal identifier: `wev:<qid>` when a QID is known, otherwise a
   *  deterministic content hash. Never re-keyed by position. */
  id: string;
  /** Partial ISO date: "1271", "1271-07" or "1271-07-02". */
  date: string;
  date_precision: DatePrecision;
  /** Optional interval for events with a start and end (wars, reigns). */
  end_date?: string | null;
  title: string;
  /** The source's own one-sentence account, trimmed — not a paraphrase. */
  blurb: string;
  category: EventCategory;
  /** Coarse region label, derived deterministically (coordinates or the
   *  source text); explicitly approximate. */
  region: string;
  /** Wikidata QID, when the source linked one. */
  qid?: string | null;
  wikipedia_url?: string | null;
  wikidata_url?: string | null;
  /** Source language of the Wikipedia article (always "en" today). */
  source_language: string;
  /** ISO timestamp of retrieval. */
  retrieved_at: string;
  /** Best available provenance identifier, e.g. "enwiki:12345:67890". */
  source_revision?: string | null;
  /** Which surface discovered it: "wikipedia-year" | "wikidata" etc. */
  discovery_source?: string | null;
  /** Coordinates for proximity ranking (Earth only). */
  latitude?: number | null;
  longitude?: number | null;
  /** Number of Wikidata sitelinks — a deterministic notability proxy. */
  sitelinks?: number;
  confidence: Confidence;
}

/** A catalogue event, ranked for one voyage. */
export interface VoyageContextEvent extends NormalizedEvent {
  relevance_class: RelevanceClass;
  /** Deterministic score, higher is more relevant. Bounded [0, ~100]. */
  relevance_score: number;
  /** Short, deterministic explanation of why this matters to THIS voyage. */
  why: string;
}

/** The persisted catalogue file. */
export interface EventCatalogue {
  generated_at?: string;
  source?: string;
  attribution?: string;
  events: NormalizedEvent[];
}

/** The client-facing projection file. */
export interface VoyageEventProjection {
  _meta?: {
    generated_at?: string;
    source?: string;
    attribution?: string;
    catalogue?: number;
  };
  voyages: Record<string, VoyageContextEvent[]>;
}

/** A minimal view of a voyage the scorer needs. Kept structural so tests can
 *  build one without importing the whole voyage registry. */
export interface ScoringVoyage {
  slug: string;
  start_year: number | null;
  end_year: number | null;
  navigator_qid?: string | null;
  place_qids?: string[];
  waypoints?: { latitude: number; longitude: number; arrival_year?: number | null }[];
  keywords?: string[];
  purpose?: string | null;
}

const CATEGORY_ORDER: EventCategory[] = [
  "conflict",
  "politics",
  "science",
  "exploration",
  "trade",
  "culture",
  "religion",
  "disaster",
];

/** Category weights for the thematic signal. Politics, conflict and
 *  exploration are what a voyage's world strip is mostly about; a ceremonial
 *  court appointment is not. */
export const CATEGORY_WEIGHT: Record<EventCategory, number> = {
  conflict: 1.0,
  politics: 0.9,
  exploration: 1.0,
  trade: 0.8,
  science: 0.8,
  culture: 0.6,
  religion: 0.6,
  disaster: 0.55,
};

export const RELEVANCE_CLASS_ORDER: RelevanceClass[] = ["connected", "route", "world"];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Parses a partial historical date, preserving precision.
 *
 * "1498"        -> { time: <1498-01-01>, precision: "year" }
 * "1498-05"     -> { time: <1498-05-01>, precision: "month" }
 * "1498-05-17"  -> { time: <1498-05-17>, precision: "day" }
 * "-1299"       -> { time: <1300 BC-01-01>, precision: "year" }
 *
 * A single-digit month like "1498-5" is accepted. Anything unparseable returns
 * null rather than guessing. Note that a year-only date anchors to 1 January
 * for ordering; the precision field is what keeps the UI honest.
 */
export function parsePartialDate(
  s: string | null | undefined,
): { time: number; precision: DatePrecision } | null {
  if (!s) return null;
  const m = String(s).trim().match(/^(-?\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return null;
  const y = Number(m[1]);
  if (!Number.isFinite(y)) return null;
  const hasMonth = m[2] !== undefined;
  const hasDay = m[3] !== undefined;
  const mo = hasMonth ? Number(m[2]) - 1 : 0;
  const d = hasDay ? Number(m[3]) : 1;
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  const precision: DatePrecision = hasDay ? "day" : hasMonth ? "month" : "year";
  return { time: utcTimestamp(y, mo, d), precision };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "August 1768", "January 1300 BC". Hand-rolled rather than Intl because the
 * platform formatter drops the era for BCE years without an `era` option and,
 * with it, misreads the two-digit years the Date API already mishandles. This
 * keeps one honest convention everywhere: astronomical years, 1 BC == 0.
 */
export function formatHistoricalMonthYear(time: number): string {
  const d = new Date(time);
  const y = d.getUTCFullYear();
  const month = MONTH_NAMES[d.getUTCMonth()] ?? "";
  return y <= 0 ? `${month} ${1 - y} BC` : `${month} ${y}`;
}

/** Formats a partial date back with the precision it actually has. Handles
 *  negative (BCE) years, whose sign shifts every slice index. */
export function formatPartialDate(s: string, precision: DatePrecision): string {
  const m = String(s).trim().match(/^(-?\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return s;
  const y = m[1].replace(/^(-?)0+(\d)/, "$1$2");
  if (precision === "year") return y;
  const mo = (m[2] ?? "1").padStart(2, "0");
  if (precision === "month") return `${y}-${mo}`;
  const d = (m[3] ?? "1").padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

// ---------------------------------------------------------------------------
// Identity and dedup
// ---------------------------------------------------------------------------

/** A normalised key for deduplication that does not depend on a QID. Lowercases,
 *  strips punctuation and collapses whitespace. */
export function normalizeIdentityPart(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dedup key: QID when present, otherwise the normalised (date, title) pair. */
export function eventIdentity(e: Pick<NormalizedEvent, "qid" | "date" | "title">): string {
  if (e.qid) return `qid:${e.qid}`;
  return `id:${normalizeIdentityPart(e.date)}|${normalizeIdentityPart(e.title)}`;
}

/**
 * Deduplicates a list of events. When two records share an identity the more
 * complete one wins (validated over partial, longer blurb, then the first by
 * deterministic ordering). Ordering of the result is stable by identity so two
 * runs over the same inputs produce the same file.
 */
export function dedupeEvents<T extends NormalizedEvent>(events: T[]): T[] {
  const best = new Map<string, T>();
  for (const e of events) {
    const key = eventIdentity(e);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, e);
      continue;
    }
    if (completeness(e) > completeness(prev)) best.set(key, e);
  }
  return [...best.values()].sort((a, b) =>
    eventIdentity(a) < eventIdentity(b) ? -1 : eventIdentity(a) > eventIdentity(b) ? 1 : 0,
  );
}

function completeness(e: NormalizedEvent): number {
  let n = 0;
  if (e.confidence === "validated") n += 4;
  if (e.qid) n += 2;
  if (e.latitude != null && e.longitude != null) n += 2;
  n += Math.min(3, Math.floor((e.blurb?.length ?? 0) / 80));
  return n;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set<string>(CATEGORY_ORDER);
const VALID_CLASSES = new Set<string>(RELEVANCE_CLASS_ORDER);

/**
 * Validates one normalised event. Returns a list of human-readable problems;
 * an empty list means the record is well-formed. Used by the generator before
 * writing and by the tests against the shipped artifacts.
 */
export function validateEvent(e: Partial<NormalizedEvent>): string[] {
  const problems: string[] = [];
  if (!e.id || typeof e.id !== "string") problems.push("missing id");
  if (!e.title || typeof e.title !== "string") problems.push("missing title");
  if (!e.date || !parsePartialDate(e.date)) problems.push(`unparseable date: ${e.date}`);
  if (e.date_precision && !["day", "month", "year"].includes(e.date_precision)) {
    problems.push(`bad date_precision: ${e.date_precision}`);
  }
  if (e.category && !VALID_CATEGORIES.has(e.category)) {
    problems.push(`unknown category: ${e.category}`);
  }
  if (!e.source_language) problems.push("missing source_language");
  if (!e.retrieved_at) problems.push("missing retrieved_at");
  if (e.confidence && !["validated", "partial"].includes(e.confidence)) {
    problems.push(`bad confidence: ${e.confidence}`);
  }
  return problems;
}

export function validateVoyageEvent(e: Partial<VoyageContextEvent>): string[] {
  const problems = validateEvent(e);
  if (!e.relevance_class || !VALID_CLASSES.has(e.relevance_class)) {
    problems.push(`bad relevance_class: ${e.relevance_class}`);
  }
  if (typeof e.relevance_score !== "number" || !Number.isFinite(e.relevance_score)) {
    problems.push("missing relevance_score");
  }
  if (!e.why || typeof e.why !== "string") problems.push("missing why");
  return problems;
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/** Great-circle distance in kilometres. */
export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ---------------------------------------------------------------------------
// Relevance scoring
// ---------------------------------------------------------------------------

/**
 * Deterministic relevance score for one event against one voyage.
 *
 * The signals, and their weights, are fixed constants so the same inputs always
 * produce the same ranking — the whole point of a deterministic pipeline. No
 * model is consulted at runtime, and no model may invent a date or an event.
 *
 *   temporal     1.0  overlap with the voyage window (decays outside it)
 *   significance 1.5  Wikidata sitelink count (log-scaled notability)
 *   geographic   0.8  proximity to the route/waypoints (sharp decay)
 *   connected    1.5  shared QID with the navigator, a port or a place
 *   thematic     0.8  category weight
 *   quality      0.4  completeness of structured source data
 *
 * The raw weighted sum is scaled to [0, 100].
 */
export function scoreCandidate(
  event: NormalizedEvent,
  voyage: ScoringVoyage,
): { score: number; relevance_class: RelevanceClass; why: string; parts: Record<string, number> } {
  const parsed = parsePartialDate(event.date);
  const evYear = parsed ? new Date(parsed.time).getUTCFullYear() : null;

  const parts: Record<string, number> = {};

  // --- temporal -----------------------------------------------------------
  let temporal = 0;
  if (voyage.start_year != null && voyage.end_year != null && evYear != null) {
    const span = Math.max(1, voyage.end_year - voyage.start_year);
    if (evYear >= voyage.start_year && evYear <= voyage.end_year) {
      temporal = 1;
    } else {
      const gap = evYear < voyage.start_year ? voyage.start_year - evYear : evYear - voyage.end_year;
      temporal = Math.max(0, 1 - gap / (span + 4));
    }
  }
  parts.temporal = temporal;

  // --- significance -------------------------------------------------------
  const sitelinks = event.sitelinks ?? 0;
  parts.significance = sitelinks <= 0 ? 0 : Math.min(1, Math.log(sitelinks + 1) / Math.log(60));

  // --- geographic ---------------------------------------------------------
  let geo = 0;
  if (
    event.latitude != null &&
    event.longitude != null &&
    voyage.waypoints &&
    voyage.waypoints.length > 0
  ) {
    let minKm = Infinity;
    for (const wp of voyage.waypoints) {
      const d = haversineKm(event.latitude, event.longitude, wp.latitude, wp.longitude);
      if (d < minKm) minKm = d;
    }
    // 100 km => ~0.80, 450 km => ~0.37, 1000 km => ~0.11, 3000 km => ~0.001
    geo = Math.exp(-minKm / 450);
  }
  parts.geographic = geo;

  // --- connectedness ------------------------------------------------------
  let connected = 0;
  const text = normalizeIdentityPart(`${event.title} ${event.blurb}`);
  if (event.qid && voyage.navigator_qid && event.qid === voyage.navigator_qid) connected = 1;
  else if (event.qid && voyage.place_qids?.includes(event.qid)) connected = 1;
  else if (voyage.keywords && voyage.keywords.length > 0) {
    let hits = 0;
    for (const kw of voyage.keywords) {
      const k = normalizeIdentityPart(kw);
      if (k.length >= 4 && text.includes(k)) hits++;
    }
    connected = Math.min(1, hits / 3);
  }
  parts.connected = connected;

  // --- thematic -----------------------------------------------------------
  parts.thematic = CATEGORY_WEIGHT[event.category] ?? 0.5;

  // --- data quality -------------------------------------------------------
  let quality = 0;
  if (event.confidence === "validated") quality += 0.4;
  if (event.qid) quality += 0.2;
  if (event.latitude != null && event.longitude != null) quality += 0.2;
  if (event.date_precision === "day") quality += 0.1;
  else if (event.date_precision === "month") quality += 0.05;
  parts.quality = Math.min(1, quality);

  const raw =
    parts.temporal * 1.0 +
    parts.significance * 1.5 +
    parts.geographic * 0.8 +
    parts.connected * 1.5 +
    parts.thematic * 0.8 +
    parts.quality * 0.4;

  const score = Math.round((raw / 6.0) * 1000) / 10;

  // Class assignment: connected beats route beats world. The route threshold is
  // deliberately tight: at 450 km a decaying score of 0.37 marks an event the
  // voyage could plausibly have seen, where the old 1000 km scale swept in half
  // a continent of unrelated politics.
  let relevance_class: RelevanceClass = "world";
  if (connected >= 0.5) relevance_class = "connected";
  else if (geo >= 0.30) relevance_class = "route";

  return { score, relevance_class, why: explain(parts, relevance_class), parts };
}

function explain(parts: Record<string, number>, cls: RelevanceClass): string {
  if (cls === "connected") {
    if (parts.connected >= 0.99) return "Names a person, port or place on this voyage.";
    return "Shares the voyage's people or places.";
  }
  if (cls === "route") {
    if (parts.geographic >= 0.6) return "Took place close to the route.";
    return "Took place in the seas this voyage crossed.";
  }
  if (parts.temporal >= 0.99) return "Happened in the years this voyage was at sea.";
  return "Contemporary with the voyage.";
}

/**
 * Selects and orders the events for one voyage: rank by score, keep a healthy
 * spread across the window, then return chronological order. Capped so the
 * strip is never flooded with trivia.
 */
export function selectVoyageEvents(
  candidates: NormalizedEvent[],
  voyage: ScoringVoyage,
  options: { min?: number; max?: number } = {},
): VoyageContextEvent[] {
  const max = options.max ?? 15;
  const scored = dedupeEvents(candidates).map((e) => {
    const { score, relevance_class, why } = scoreCandidate(e, voyage);
    return { ...e, relevance_class, relevance_score: score, why } as VoyageContextEvent;
  });

  // Deterministic: score desc, then date asc, then id asc.
  scored.sort((a, b) => {
    if (b.relevance_score !== a.relevance_score) return b.relevance_score - a.relevance_score;
    const at = parsePartialDate(a.date)?.time ?? 0;
    const bt = parsePartialDate(b.date)?.time ?? 0;
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const chosen = spread(scored, max).sort((a, b) => {
    const at = parsePartialDate(a.date)?.time ?? 0;
    const bt = parsePartialDate(b.date)?.time ?? 0;
    return at - bt;
  });
  return chosen;
}

/**
 * Keeps the top events without letting one busy year crowd out the rest of the
 * voyage. Walks the ranked list and skips events once a single year has filled
 * its share, until `max` is reached or the list is exhausted.
 */
function spread(ranked: VoyageContextEvent[], max: number): VoyageContextEvent[] {
  const perYear = new Map<string, number>();
  const yearCap = Math.max(2, Math.ceil(max / 3));
  const out: VoyageContextEvent[] = [];
  for (const e of ranked) {
    if (out.length >= max) break;
    const year = (parsePartialDate(e.date) ?? { time: 0 }).time
      ? String(new Date(parsePartialDate(e.date)!.time).getUTCFullYear())
      : "?";
    const n = perYear.get(year) ?? 0;
    if (n >= yearCap) continue;
    perYear.set(year, n + 1);
    out.push(e);
  }
  // If the cap left us short, fill the remainder regardless of year.
  if (out.length < max) {
    const have = new Set(out.map((e) => e.id));
    for (const e of ranked) {
      if (out.length >= max) break;
      if (!have.has(e.id)) out.push(e);
    }
  }
  return out;
}
