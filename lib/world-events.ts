/**
 * The runtime loader for contextual world events.
 *
 * The pure model — dates, dedup, validation, scoring, selection — lives in
 * `lib/world-events-core.ts`, which has no data import and therefore runs in
 * Node tests and in the catalogue build step. This file is the only place the
 * checked-in cache is read, and it is the only part the browser bundle needs.
 *
 * It never fetches. Acquisition lives in `scripts/build_world_events.py`;
 * ranking/selection lives in `scripts/build_world_event_projection.ts`. If the
 * cache is missing or empty for a voyage, the strip honestly says so.
 */

import worldEventsData from "@/data/world_events.json";
import {
  parsePartialDate,
  validateEvent,
  type NormalizedEvent,
  type VoyageContextEvent,
  type VoyageEventProjection,
} from "./world-events-core";

export * from "./world-events-core";

function isProjection(data: unknown): data is VoyageEventProjection {
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    typeof (data as VoyageEventProjection).voyages === "object"
  );
}

function byTime(a: NormalizedEvent, b: NormalizedEvent): number {
  return (parsePartialDate(a.date)?.time ?? 0) - (parsePartialDate(b.date)?.time ?? 0);
}

/**
 * The events a voyage's strip renders, from the checked-in cache. Never
 * fetches. Returns a stable empty array when there is no validated data — the
 * empty state is honest rather than fabricated.
 */
export function voyageEventsFor(slug: string): VoyageContextEvent[] {
  const data = worldEventsData as unknown;
  if (isProjection(data)) {
    const list = data.voyages?.[slug];
    return Array.isArray(list) ? [...list].sort(byTime) : [];
  }
  // Backward compatibility: the pre-catalogue flat array was global, not
  // per-voyage. It is returned as-is so an old artifact never renders nothing
  // by accident during a rollout; the generator replaces it.
  if (Array.isArray(data)) {
    return (data as NormalizedEvent[])
      .filter((e) => validateEvent(e).length === 0)
      .sort(byTime) as unknown as VoyageContextEvent[];
  }
  return [];
}

/** The catalogue the coverage report is built from — not imported by the UI. */
export function catalogueEvents(): NormalizedEvent[] {
  const data = worldEventsData as unknown;
  if (isProjection(data)) return [];
  if (Array.isArray(data)) return data as NormalizedEvent[];
  return [];
}
