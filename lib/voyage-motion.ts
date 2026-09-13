/**
 * Pure time/motion helpers shared by every voyage experience — Earth
 * (longitude/latitude) and Space (heliocentric AU-plane coordinates alike.
 *
 * These were extracted verbatim from components/VoyageExperience.tsx (the
 * Earth-only original) and generalized from lng/lat to an abstract {x, y}
 * plane. VoyageExperience re-imports them through a thin lng/lat adapter, so
 * its behavior is unchanged — see the `buildLegs`/`shipStateAt`/
 * `traveledLine` wrappers near the top of that file.
 *
 * The generalisation is deliberately shallow: callers own coordinate meaning
 * (geographic degrees for Earth, true heliocentric AU-plane position for
 * Space) and are responsible for projecting {x, y} onto whatever they render
 * (a MapLibre `<div>` for Earth, an inline SVG orrery for Space). This file
 * only knows about time and straight-line interpolation between waypoints.
 */

export const DAY = 86_400_000;

/* How long a voyage takes to play, in one place instead of two — and in
 * SECONDS, which is the change that matters.
 *
 * It used to be a tick count: `span / 600` every 40ms, which reads as 24
 * seconds and is not. setInterval does not promise 40ms, it promises "no
 * sooner than", and under a map that is rendering it drifts badly. Measured on
 * the deployed site, the nominal 48-second version took 106. So the pace was
 * never a pace: it was however fast the device happened to be, and a slow
 * phone sailed a slower ocean than a fast desktop.
 *
 * Driven by the clock now. Each tick advances by the time that actually
 * elapsed, so this number is the real duration on any device, and it can be
 * argued about in the units anyone would argue in.
 */
export const PLAYBACK_TICK_MS = 40;
export const PLAYBACK_SECONDS = 60;

/** "1768", "399", "-1299" — partial ISO dates, as used in the data files.
 *  Negative years are astronomical (year 0 exists), so 1 BC is -1. */
export function parseHistoricalDate(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/^(-?\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) - 1 : 0;
  const d = m[3] ? Number(m[3]) : 1;
  return utcTimestamp(y, mo, d);
}

/**
 * A UTC timestamp that is correct for EVERY year, including 0-99 and negatives.
 *
 * `Date.UTC(42, 0, 1)` is not year 42: the Date constructor's two-digit rule
 * maps 0-99 to 1900+y, so every early voyage silently became a 20th-century
 * one. `setUTCFullYear` has no such rule, and handles BCE years (negative)
 * directly. This is the one place the epoch is built; nothing else should call
 * `Date.UTC` with a year from the data.
 */
export function utcTimestamp(year: number, monthIndex = 0, day = 1): number {
  const d = new Date(0);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCFullYear(year, monthIndex, day);
  return d.getTime();
}

export interface MotionLeg<T> {
  wp: T;
  x: number;
  y: number;
  arrival: number;
  departure: number;
}

interface DatedPoint {
  seq: number;
  arrival_date: string | null;
  departure_date: string | null;
}

/**
 * Builds ordered "legs" (one per waypoint, sorted by seq) with resolved
 * arrival/departure timestamps and a plane position.
 *
 * `getXY` converts each waypoint into {x, y}; it receives the previous
 * point's resolved x so callers that need continuity across a coordinate
 * wrap (e.g. longitude across the antimeridian) can unwrap there — exactly
 * as the original Earth-only implementation did inline.
 */
export function buildLegs<T extends DatedPoint>(
  waypoints: T[],
  getXY: (wp: T, prevX: number | null) => { x: number; y: number }
): MotionLeg<T>[] {
  const sorted = [...waypoints].sort((a, b) => a.seq - b.seq);
  const legs: MotionLeg<T>[] = [];
  let prevX: number | null = null;
  let prevTime = -Infinity;

  for (const wp of sorted) {
    const { x, y } = getXY(wp, prevX);
    let arrival = parseHistoricalDate(wp.arrival_date);
    if (arrival === null) arrival = prevTime === -Infinity ? 0 : prevTime + 14 * DAY;
    /* STRICTLY LATER THAN THE ONE BEFORE, and the `<=` is the whole fix.
       This resolves position at day granularity, so two stops recorded on the
       same calendar day landed on the same instant — and everything drawn on
       the time axis then drew them on top of each other. The Moon showed it
       worst: Apollo 11's six stops are one EVA of two and a half hours, five
       of them dated 21 July 1969, so the rail was ONE leg spanning the whole
       width with four zero-width links stacked at its end. A chain of stages
       that renders as an empty bar is not a rail with a styling problem; it is
       six stages the reader cannot see or reach.
       The bump is synthetic time, never shown: the log prints the date STRING
       from the record (see formatRange), and a surface voyage inside one day
       prints its real clock times from date_note instead. Six voyages had
       collided stops — Pizarro's march had six of them — and only Apollo's
       overall span moves at all, because elsewhere the day is absorbed by the
       next real date. */
    if (arrival <= prevTime) arrival = prevTime + DAY;
    let departure = parseHistoricalDate(wp.departure_date);
    if (departure === null || departure < arrival) departure = arrival;

    legs.push({ wp, x, y, arrival, departure });
    prevX = x;
    prevTime = departure;
  }
  return legs;
}

/** Interpolated position + the index of the leg the ship is currently in/at. */
export function shipStateAt<T>(
  t: number,
  legs: MotionLeg<T>[]
): { x: number; y: number; index: number } {
  if (legs.length === 0) return { x: 0, y: 0, index: 0 };
  if (t <= legs[0].arrival) return { x: legs[0].x, y: legs[0].y, index: 0 };

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (t <= leg.departure) return { x: leg.x, y: leg.y, index: i };
    const next = legs[i + 1];
    if (next && t < next.arrival) {
      const f = (t - leg.departure) / (next.arrival - leg.departure);
      return {
        x: leg.x + (next.x - leg.x) * f,
        y: leg.y + (next.y - leg.y) * f,
        index: i,
      };
    }
  }
  const last = legs[legs.length - 1];
  return { x: last.x, y: last.y, index: legs.length - 1 };
}

/** The traveled portion of the route as a polyline, up to time t. */
export function traveledLine<T>(t: number, legs: MotionLeg<T>[]): [number, number][] {
  const ship = shipStateAt(t, legs);
  const coords: [number, number][] = [];
  for (let i = 0; i <= ship.index; i++) coords.push([legs[i].x, legs[i].y]);
  const last = coords[coords.length - 1];
  if (!last || last[0] !== ship.x || last[1] !== ship.y) {
    coords.push([ship.x, ship.y]);
  }
  return coords;
}
