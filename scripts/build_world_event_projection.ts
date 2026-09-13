#!/usr/bin/env tsx
/**
 * Rank the shared catalogue per voyage and write the client projection.
 *
 * This is deliberately a separate step from acquisition: the Python generator
 * collects and normalises, this selects with the very same deterministic
 * scorer the tests exercise. One scorer, one ranking, tested and shipped.
 *
 * Inputs:
 *   data/historical-events.json   — normalised shared catalogue
 *   data/world-events-voyages.json — per-voyage scoring inputs
 *
 * Outputs:
 *   data/world_events.json              — per-voyage projection (client imports)
 *   data/world-events-coverage.json     — coverage report, uncovered voyages named
 *
 * Usage: npx tsx scripts/build_world_event_projection.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  dedupeEvents,
  selectVoyageEvents,
  validateVoyageEvent,
  type NormalizedEvent,
  type ScoringVoyage,
  type VoyageContextEvent,
} from "../lib/world-events-core";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));

const catalogue = read("data/historical-events.json") as {
  generated_at?: string;
  source?: string;
  attribution?: string;
  events: NormalizedEvent[];
};
const voyageInputs = read("data/world-events-voyages.json") as Record<string, ScoringVoyage>;

const catalogueEvents = dedupeEvents(catalogue.events ?? []);
console.log(`catalogue events: ${catalogueEvents.length}`);

const voyages: Record<string, VoyageContextEvent[]> = {};
const coverage: {
  generated_at: string;
  source: string;
  attribution: string;
  catalogue_events: number;
  voyages: Record<string, { count: number; classes: Record<string, number>; years: string; uncovered: boolean }>;
  uncovered: string[];
} = {
  generated_at: catalogue.generated_at ?? "",
  source: catalogue.source ?? "",
  attribution: catalogue.attribution ?? "",
  catalogue_events: catalogueEvents.length,
  voyages: {},
  uncovered: [],
};

for (const slug of Object.keys(voyageInputs).sort()) {
  const input = voyageInputs[slug];
  // Candidate pool: events whose year falls in the voyage window, generously
  // widened. The scorer's temporal signal does the fine ranking.
  const s = input.start_year ?? 0;
  const e = input.end_year ?? s;
  const lo = s - 6;
  const hi = e + 6;
  const candidates = catalogueEvents.filter((ev) => {
    const m = String(ev.date).match(/^(-?\d{1,4})/);
    const y = m ? Number(m[1]) : NaN;
    return Number.isFinite(y) && y >= lo && y <= hi;
  });

  const selected = selectVoyageEvents(candidates, input, { max: 15 });

  // Schema validation before writing. A malformed event must never ship.
  const problems: string[] = [];
  for (const ev of selected) {
    const p = validateVoyageEvent(ev);
    if (p.length) problems.push(`${ev.id}: ${p.join(", ")}`);
  }
  if (problems.length) {
    console.error(`! ${slug} produced invalid events:`);
    for (const p of problems) console.error(`    ${p}`);
    process.exitCode = 1;
  }

  voyages[slug] = selected;
  const classes: Record<string, number> = { world: 0, route: 0, connected: 0 };
  for (const ev of selected) classes[ev.relevance_class] = (classes[ev.relevance_class] ?? 0) + 1;
  coverage.voyages[slug] = {
    count: selected.length,
    classes,
    years: `${s}–${e}`,
    uncovered: selected.length === 0,
  };
  if (selected.length === 0) coverage.uncovered.push(slug);
}

const projection = {
  _meta: {
    generated_at: catalogue.generated_at,
    source: catalogue.source,
    attribution: catalogue.attribution,
    catalogue: catalogueEvents.length,
  },
  voyages,
};

writeFileSync(resolve(ROOT, "data/world_events.json"), JSON.stringify(projection, null, 1) + "\n");
writeFileSync(
  resolve(ROOT, "data/world-events-coverage.json"),
  JSON.stringify(coverage, null, 1) + "\n",
);

console.log("\nCoverage by voyage:");
for (const slug of Object.keys(coverage.voyages)) {
  const v = coverage.voyages[slug];
  const mark = v.uncovered ? "  UNCOVERED" : "";
  console.log(
    `  ${slug.padEnd(18)} ${String(v.count).padStart(2)}  (${v.years})  ` +
      `world=${v.classes.world ?? 0} route=${v.classes.route ?? 0} connected=${v.classes.connected ?? 0}${mark}`,
  );
}
if (coverage.uncovered.length) {
  console.log(`\n${coverage.uncovered.length} voyage(s) with no validated contextual events.`);
}
