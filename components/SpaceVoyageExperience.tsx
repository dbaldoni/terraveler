"use client";

import Icon from "@/components/Icon";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEdgeStack } from "@/lib/useEdgeStack";
import { useLayoutMode } from "@/lib/layout";
import dynamic from "next/dynamic";
import type { MediaItem, Navigator, Voyage, VoyageKind, SpaceWaypoint } from "@/lib/types";
import spaceEventsData from "@/data/space_events.json";
import DraggableWindow from "@/components/DraggableWindow";
import MapTop from "@/components/map/MapTop";
import MapNote from "@/components/map/MapNote";
import TransportBar from "@/components/map/TransportBar";
import { type MilestonePoint, type ScaleMode } from "@/lib/orrery-scale";
import type { CameraMode } from "@/components/SolarSystem3D";
import { voyageLogPath } from "@/lib/voyages";
import AtlasBrowser from "@/components/AtlasBrowser";
import {
  DAY,
  PLAYBACK_TICK_MS,
  PLAYBACK_SECONDS,
  parseHistoricalDate,
  buildLegs,
  shipStateAt,
  traveledLine,
  type MotionLeg,
} from "@/lib/voyage-motion";

// The immersive three.js orrery replaces the flat SVG map as the primary
// renderer; it self-detects WebGL and falls back to rendering the retained
// SolarSystemMap (SVG) internally if unavailable — so this is the ONLY map
// import the parent needs now. ssr:false because it touches window/document
// and builds a three.js scene; a starfield-colored skeleton (matching
// SolarSystem3D's own "detecting" placeholder) fills the gap while it loads.
const SolarSystem3D = dynamic(() => import("@/components/SolarSystem3D"), {
  ssr: false,
  loading: () => <div style={{ position: "absolute", inset: 0 }} />,
});

type Lens = "log" | "chart" | "carto" | "plates";

type SpaceEvent = {
  date: string;
  title: string;
  blurb: string;
  category: string;
  region: string;
  source_url: string;
};

/**
 * The Space twin of VoyageExperience: identical scrubber, playback loop, lens
 * rail, DraggableWindow panels, transport bar and world-events strip — only
 * the map is different (an inline SVG orrery, SolarSystemMap, instead of a
 * MapLibre <div>). All time/motion math is shared via lib/voyage-motion; only
 * the coordinate meaning (heliocentric AU-plane instead of lng/lat) and the
 * renderer differ.
 */

// Thin adapter over lib/voyage-motion: converts each waypoint's heliocentric
// polar position (r_au, theta_deg) into true Cartesian AU-plane coordinates.
// Unlike longitude, this needs no "unwrap for continuity" step — sin/cos are
// already continuous, so prevX is unused.
function buildSpaceLegs(waypoints: SpaceWaypoint[]): MotionLeg<SpaceWaypoint>[] {
  return buildLegs(waypoints, (wp) => {
    const rad = (wp.theta_deg * Math.PI) / 180;
    return { x: wp.r_au * Math.cos(rad), y: wp.r_au * Math.sin(rad) };
  });
}

function formatRange(wp: SpaceWaypoint): string {
  const parts: string[] = [];
  if (wp.arrival_date && wp.departure_date && wp.departure_date !== wp.arrival_date) {
    parts.push(`${wp.arrival_date} → ${wp.departure_date}`);
  } else if (wp.arrival_date) {
    parts.push(wp.arrival_date);
  }
  if (wp.date_note) parts.push(wp.date_note);
  return parts.join(" · ");
}

function fmtAu(n: number): string {
  return `${n.toFixed(2)} AU`;
}

// One-way light time: r_au * 499 seconds (499s ≈ light travel time for 1 AU).
function fmtLightTime(rAu: number): string {
  const totalSec = Math.round(rAu * 499);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

export default function SpaceVoyageExperience({
  navigator,
  voyage,
  waypoints,
  atlasCount,
}: {
  navigator: Navigator;
  voyage: Voyage;
  waypoints: SpaceWaypoint[];
  /** A number, not the list — ATLAS stays out of this bundle. */
  atlasCount?: number;
}) {
  const legs = useMemo(() => buildSpaceLegs(waypoints), [waypoints]);
  const minTime = legs.length ? legs[0].arrival : 0;
  const maxTime = legs.length ? legs[legs.length - 1].departure : 1;

  // Milestones: real flybys + the heliopause marker — anything with imagery.
  // Cruise-phase filler points (added only to bend the drawn path) have none
  // and are not independently clickable, mirroring the Earth map's
  // "wp-dot.has-media" treatment.
  const milestoneLegs = useMemo(
    () => legs.filter((l) => l.wp.media && l.wp.media.length > 0),
    [legs]
  );
  const flybyLegs = useMemo(() => legs.filter((l) => l.wp.is_flyby === true), [legs]);

  // Waypoints with images, in voyage order — feeds the Imagery lens.
  const plateWaypoints = useMemo(
    () =>
      [...waypoints]
        .filter((w) => w.media && w.media.length > 0)
        .sort((a, b) => a.seq - b.seq),
    [waypoints]
  );

  // Cumulative AU flown up to the start of each leg (straight-line AU
  // distance between successive positions — schematic, not orbital arc).
  const cumAu = useMemo(() => {
    const arr: number[] = [0];
    for (let i = 1; i < legs.length; i++) {
      arr[i] = arr[i - 1] + Math.hypot(legs[i].x - legs[i - 1].x, legs[i].y - legs[i - 1].y);
    }
    return arr;
  }, [legs]);

  // World events within THIS voyage's (much longer) window, same time axis.
  const events = useMemo(
    () =>
      (spaceEventsData as SpaceEvent[])
        .map((e) => ({ ...e, time: parseHistoricalDate(e.date) ?? minTime }))
        .filter((e) => e.time >= minTime && e.time <= maxTime)
        .sort((a, b) => a.time - b.time),
    [minTime, maxTime]
  );

  const [t, setT] = useState(minTime);
  const [playing, setPlaying] = useState(false);
  const [lens, setLens] = useState<Lens>("log");
  const [showOrbits, setShowOrbits] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [scaleMode, setScaleMode] = useState<ScaleMode>("log");
  const [cameraMode, setCameraMode] = useState<CameraMode>("cinematic");
  const [autopause, setAutopause] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [stripHover, setStripHover] = useState(false);
  /* Which timeline the phone rail shows — see VoyageExperience for why. */
  const [track, setTrack] = useState("voyage");
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const isMobile = useLayoutMode() === "phone";
  /* The same derived bottom stack the Earth map uses. This component had the
     same defect for the same reason: its note anchored to bottom:14px, which
     is where the transport bar also is. */
  const barRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLDivElement | null>(null);

  useEdgeStack({ bar: barRef, note: noteRef });
  const [railOpen, setRailOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [atlasFilter, setAtlasFilter] = useState<VoyageKind>(voyage.kind ?? "space");
  const [lightbox, setLightbox] = useState<{ item: MediaItem; place: string } | null>(null);

  // Esc closes the imagery lightbox.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  /* Step between flybys — lives here because the buttons live on the log. */
  function stepStop(dir: 1 | -1) {
    setPlaying(false);
    setPausedAt(null);
    const at = milestoneLegs.map((l) => l.arrival);
    const next =
      dir === 1 ? at.find((x) => x > t + DAY) : [...at].reverse().find((x) => x < t - DAY);
    openLog(next ?? (dir === 1 ? maxTime : minTime));
  }

  // Open the Mission Log at a specific flyby (used by waypoint dots & ticks).
  function openLog(arrival: number) {
    setT(arrival);
    setLens("log");
    setPanelOpen(true);
  }

  /* Having stopped, the phone shows WHY it stopped. Without this the mission
     halts on a starfield with no explanation, which is worse than the checkbox
     it replaces. */
  useEffect(() => {
    if (pausedAt === null || !isMobile) return;
    setLens("log");
    setPanelOpen(true);
  }, [pausedAt, isMobile]);

  // Playback loop — the pace lives in lib/voyage-motion — identical formula to the
  // Earth experience; autopause stops at milestones only (real flybys + the
  // heliopause), not at the invisible cruise-phase filler points.
  useEffect(() => {
    if (!playing) return;
    const span = maxTime - minTime || 1;
    /* The step is whatever time really passed, not whatever the timer was
       asked for — see PLAYBACK_SECONDS. */
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setT((prev) => {
        const next = prev + span * (dt / (PLAYBACK_SECONDS * 1000));
        /* Not a setting on a phone — see VoyageExperience for the argument.
           The log carries the button that sails on. */
        if (autopause || isMobile) {
          const nextLeg = milestoneLegs.find((l) => l.arrival > prev + 1)?.arrival ?? Infinity;
          const nextEv = events.find((e) => e.time > prev + 1)?.time ?? Infinity;
          const stop = Math.min(nextLeg, nextEv);
          if (Number.isFinite(stop) && next >= stop) {
            setPlaying(false);
            /* Recorded, not acted on: opening the log from inside a state
               updater nests one setState in another. The effect does it. */
            if (isMobile) setPausedAt(stop);
            return stop;
          }
        }
        if (next >= maxTime) {
          setPlaying(false);
          return maxTime;
        }
        return next;
      });
    }, PLAYBACK_TICK_MS);
    return () => clearInterval(id);
  }, [playing, minTime, maxTime, autopause, milestoneLegs, events]);

  useEffect(() => {
    if (playing && t >= maxTime) setPlaying(false);
  }, [t, playing, maxTime]);

  // Ship state (AU-plane) + navigation figures for the current instant.
  const shipNow = shipStateAt(t, legs);
  const rNow = Math.hypot(shipNow.x, shipNow.y);
  const idx = shipNow.index;
  const partialAu = legs.length ? Math.hypot(shipNow.x - legs[idx].x, shipNow.y - legs[idx].y) : 0;
  const totalAu = (cumAu[idx] ?? 0) + partialAu;
  const daysSince = Math.max(0, Math.round((t - minTime) / DAY));
  const flybysMade = flybyLegs.filter((l) => l.arrival <= t).length;

  // "Current" for the lens panels is the most recent milestone reached —
  // Mission Log content only changes at a real flyby, even though the probe
  // marker and traveled path animate smoothly through the cruise filler
  // points in between.
  let missionIdx = 0;
  for (let i = 0; i < milestoneLegs.length; i++) {
    if (milestoneLegs[i].arrival <= t) missionIdx = i;
    else break;
  }
  const current = milestoneLegs[missionIdx]?.wp;

  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(t));
  const pct = maxTime > minTime ? ((t - minTime) / (maxTime - minTime)) * 100 : 0;

  let worldNow: (SpaceEvent & { time: number }) | null = null;
  for (const e of events) {
    if (e.time <= t) worldNow = e;
    else break;
  }
  const pctOf = (time: number) =>
    Math.max(
      0,
      Math.min(100, maxTime > minTime ? ((time - minTime) / (maxTime - minTime)) * 100 : 0)
    );

  function togglePlay() {
    setPanelOpen(true);
    if (!playing) {
      if (t >= maxTime) setT(minTime);
      setPlaying(true);
    } else {
      setPlaying(false);
    }
  }

  const bodyName = current?.body || "";
  const panelTitle =
    lens === "log"
      ? "Mission Log"
      : lens === "chart"
      ? "Telemetry"
      : lens === "plates"
      ? "Imagery"
      : "Orrery";

  const fullPath = useMemo(() => legs.map((l) => [l.x, l.y] as [number, number]), [legs]);
  const donePath = useMemo(() => traveledLine(t, legs), [t, legs]);
  const dotPoints: MilestonePoint[] = useMemo(
    () => milestoneLegs.map((l) => ({ arrival: l.arrival, x: l.x, y: l.y, wp: l.wp })),
    [milestoneLegs]
  );

  return (
    <div className="space" style={{ position: "relative", height: "100dvh", overflow: "hidden" }}>
      <h1 className="sr-only">
        {voyage.title} — {navigator.name} — Terraveler
      </h1>
      {/* The imprint did not exist on this theme at all: no wordmark, no
          count, no caption — only a bare emblem. The map's three classes are
          the map's three classes whichever body it is showing. */}
      <MapTop
        title={voyage.title}
        atlasCount={atlasCount}
        pickerOpen={pickerOpen}
        onTogglePicker={() => setPickerOpen((o) => !o)}
      />

      <div className="lens-rail" role="group" aria-label="View lens">
        {isMobile && !railOpen ? (
          <button
            className="lens-btn lens-btn-ico rail-toggle"
            aria-label="Open tools"
            title="Tools"
            onClick={() => setRailOpen(true)}
          >
            <Icon name={lens === "log" ? "antenna" : lens === "chart" ? "chart" : lens === "plates" ? "plates" : "orrery"} size={19} />
          </button>
        ) : (
          <>
            <button
              className={`lens-btn lens-btn-ico ${lens === "log" ? "active" : ""}`}
              title="Mission Log — the record at each flyby"
              aria-label="Mission Log"
              onClick={() => {
                setLens("log");
                setPanelOpen(true);
                setRailOpen(false);
              }}
            >
              <Icon name="antenna" size={19} />
            </button>
            <button
              className={`lens-btn lens-btn-ico ${lens === "chart" ? "active" : ""}`}
              title="Telemetry — the probe's instruments"
              aria-label="Telemetry"
              onClick={() => {
                setLens("chart");
                setPanelOpen(true);
                setRailOpen(false);
              }}
            >
              <Icon name="chart" size={19} />
            </button>
            <button
              className={`lens-btn lens-btn-ico ${lens === "carto" ? "active" : ""}`}
              title="Orrery — orbit rings, labels and scale"
              aria-label="Orrery"
              onClick={() => {
                setLens("carto");
                setPanelOpen(true);
                setRailOpen(false);
              }}
            >
              <Icon name="orrery" size={19} />
            </button>
            <button
              className={`lens-btn lens-btn-ico ${lens === "plates" ? "active" : ""}`}
              title="Imagery — pictures from the flybys"
              aria-label="Imagery"
              onClick={() => {
                setLens("plates");
                setPanelOpen(true);
                setRailOpen(false);
              }}
            >
              <Icon name="plates" size={19} />
            </button>
            <button className="lens-btn lens-btn-ico" disabled title="Golden Record — coming soon" aria-label="Golden Record (coming soon)">
              <Icon name="record" size={19} />
            </button>
            {isMobile && (
              <button
                className="lens-btn lens-btn-ico rail-close"
                aria-label="Collapse tools"
                title="Collapse"
                onClick={() => setRailOpen(false)}
              >
                ×
              </button>
            )}
          </>
        )}
      </div>

      {pickerOpen && (
        <AtlasBrowser
          onClose={() => setPickerOpen(false)}
          voyage={voyage}
          navigator={navigator}
        />
      )}


      {/* Wide only: on a phone this band encodes the same axis as the bar at
          the other end of the screen, and moves into the bar’s switch. */}
      {!isMobile && (
        <div
          className="world-strip"
          onMouseEnter={() => setStripHover(true)}
          onMouseLeave={() => setStripHover(false)}
        >
          <div className="ws-kicker">\n            {events.length > 0 ? "Meanwhile on Earth" : "No Earth events catalogued for this mission"}\n          </div>
          <div className="wt-track">
            {events.map((ev) => (
              <button
                key={ev.title}
                className={`wt-dot cat-${ev.category} ${
                  worldNow && ev.title === worldNow.title ? "active" : ""
                }`}
                style={{ left: `${pctOf(ev.time)}%` }}
                title={`${ev.date} · ${ev.title}`}
                aria-label={ev.title}
                onClick={() => {
                  setPlaying(false);
                  setT(ev.time);
                }}
              />
            ))}
            <div className="wt-playhead" style={{ left: `${pct}%` }} />
          </div>
          {worldNow && (stripHover || t - worldNow.time < 200 * DAY) && (
            <div className="ws-card">
              <strong>{worldNow.title}</strong> — {worldNow.blurb}{" "}
              {worldNow.source_url && (
                <a href={worldNow.source_url} target="_blank" rel="noreferrer" className="wt-src">
                  source
                </a>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ position: "absolute", inset: 0 }}>
        <div style={{ position: "absolute", inset: 0 }}>
          <SolarSystem3D
            fullPath={fullPath}
            donePath={donePath}
            shipAu={{ x: shipNow.x, y: shipNow.y }}
            waypoints={dotPoints}
            activeArrival={milestoneLegs[missionIdx]?.arrival ?? -1}
            scale={scaleMode}
            showOrbits={showOrbits}
            showLabels={showLabels}
            onWaypointClick={openLog}
            t={t}
            cameraMode={cameraMode}
            onCameraModeChange={setCameraMode}
            playing={playing}
          />
        </div>

        <MapNote className="orbit-note" ref={noteRef} label="How these positions were got">
          Flyby positions are computed from J2000 mean-longitude orbital elements (planet
          position on the encounter date); cruise-phase points between flybys are
          interpolated for the drawn path, not measured. Distances shown on a compressed
          scale — open the Orrery lens to switch to linear.
        </MapNote>

        {current && panelOpen && (
          <DraggableWindow title={panelTitle} onClose={() => setPanelOpen(false)}>
            {lens === "carto" ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--brass)", letterSpacing: "0.08em" }}>
                    Orrery
                  </span>
                  <span className="conf-badge">{scaleMode}</span>
                </div>
                <h2 style={{ margin: "4px 0 6px", fontSize: "1.3rem" }}>Map layers &amp; scale</h2>
                <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink-soft)", margin: "0 0 10px" }}>
                  A log-radial projection compresses outer distances so Mercury through the
                  heliopause fit on one canvas. Switch to linear to see why that compression
                  is necessary — almost the whole tour collapses near the Sun.
                </p>
                <label className="hist-toggle">
                  <input type="checkbox" checked={showOrbits} onChange={(e) => setShowOrbits(e.target.checked)} />
                  Show orbit rings
                </label>
                <label className="hist-toggle" style={{ marginTop: 8 }}>
                  <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
                  Show planet labels
                </label>
                <div className="scale-toggle" role="radiogroup" aria-label="Distance scale">
                  <button
                    type="button"
                    className={`scale-opt ${scaleMode === "log" ? "active" : ""}`}
                    onClick={() => setScaleMode("log")}
                  >
                    Log scale
                  </button>
                  <button
                    type="button"
                    className={`scale-opt ${scaleMode === "linear" ? "active" : ""}`}
                    onClick={() => setScaleMode("linear")}
                  >
                    Linear scale
                  </button>
                </div>
                <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink-soft)", margin: "10px 0 4px" }}>
                  Cinematic mode holds a slow orbiting camera on the probe, pulling in close at
                  each flyby. Free look lets you drag to orbit and scroll to zoom — drag to
                  switch, or wait a few seconds / press play to hand the camera back.
                </p>
                <div className="scale-toggle" role="radiogroup" aria-label="Camera mode">
                  <button
                    type="button"
                    className={`scale-opt ${cameraMode === "cinematic" ? "active" : ""}`}
                    onClick={() => setCameraMode("cinematic")}
                  >
                    Cinematic
                  </button>
                  <button
                    type="button"
                    className={`scale-opt ${cameraMode === "free" ? "active" : ""}`}
                    onClick={() => setCameraMode("free")}
                  >
                    Free look
                  </button>
                </div>
              </>
            ) : lens === "plates" ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--brass)", letterSpacing: "0.08em" }}>
                    Imagery
                  </span>
                  <span className="conf-badge">{plateWaypoints.length} flybys</span>
                </div>
                <h2 style={{ margin: "4px 0 6px", fontSize: "1.3rem" }}>Pictures from the mission</h2>
                {plateWaypoints.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--ink-soft)", fontStyle: "italic" }}>
                    No imagery recorded for this voyage yet.
                  </div>
                ) : (
                  plateWaypoints.map((wp) => (
                    <div className="plates-group" key={wp.id}>
                      <h3 className="plates-place">{wp.body}</h3>
                      <div className="plates-grid">
                        {(wp.media ?? []).map((m, i) => (
                          <figure className="plates-thumb" key={i}>
                            <button
                              type="button"
                              className="plates-thumb-btn"
                              onClick={() => setLightbox({ item: m, place: wp.body })}
                              aria-label={`View larger: ${m.caption}`}
                            >
                              <img src={m.url} alt={m.caption} loading="lazy" />
                            </button>
                            <figcaption>
                              <div className="plates-caption">{m.caption}</div>
                              {m.credit && <div className="plates-credit">{m.credit}</div>}
                              {m.source_url && (
                                <a href={m.source_url} target="_blank" rel="noreferrer" className="plates-source">
                                  source
                                </a>
                              )}
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--brass)", letterSpacing: "0.08em" }}>
                    Milestone {current.seq}
                  </span>
                  <span className="conf-badge">{current.confidence}</span>
                </div>
                <h2 style={{ margin: "4px 0 2px", fontSize: "1.3rem" }}>{bodyName}</h2>

                {lens === "log" ? (
                  <>
                    <div style={{ color: "var(--ink-soft)", fontSize: 13, fontStyle: "italic" }}>
                      {fmtAu(current.r_au)} from the Sun · θ {current.theta_deg.toFixed(1)}°
                    </div>
                    <div style={{ color: "var(--ink-soft)", fontSize: 13, margin: "6px 0" }}>
                      {formatRange(current)}
                    </div>
                    {current.event && <p style={{ margin: "8px 0", lineHeight: 1.5 }}>{current.event}</p>}

                    {current.diary_excerpt ? (
                      <>
                        <blockquote
                          style={{
                            margin: "12px 0 6px",
                            paddingLeft: 12,
                            borderLeft: "3px solid var(--brass)",
                            fontStyle: "italic",
                            lineHeight: 1.55,
                          }}
                        >
                          “{current.diary_excerpt}”
                        </blockquote>
                        {current.diary_source_citation && (
                          <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                            —{" "}
                            {current.diary_source_url ? (
                              <a href={current.diary_source_url} target="_blank" rel="noreferrer">
                                {current.diary_source_citation}
                              </a>
                            ) : (
                              current.diary_source_citation
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <div style={{ fontSize: 12, color: "var(--ink-soft)", fontStyle: "italic" }}>
                        No verified mission note for this flyby yet.
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="instruments">
                      <div>
                        <span>Distance from Sun</span>
                        <strong>{fmtAu(rNow)}</strong>
                      </div>
                      <div>
                        <span>One-way light time</span>
                        <strong>{fmtLightTime(rNow)}</strong>
                      </div>
                      <div>
                        <span>Days since launch</span>
                        <strong>{daysSince.toLocaleString("en-GB")}</strong>
                      </div>
                      <div>
                        <span>Distance flown</span>
                        <strong>{fmtAu(totalAu)}</strong>
                      </div>
                      <div>
                        <span>Flybys made</span>
                        <strong>
                          {flybysMade} / {flybyLegs.length}
                        </strong>
                      </div>
                      <div>
                        <span>Position certainty</span>
                        <strong style={{ textTransform: "capitalize" }}>{current.confidence}</strong>
                      </div>
                    </div>
                    {current.date_note && <p className="surveyor-note">Mission note: {current.date_note}</p>}
                  </>
                )}
              </>
            )}

            {/* The controls the bar gave up. On a phone the log is a page, so
                it is where you already are when the mission stops — which
                makes it the home for stepping between flybys and the only
                honest place for the one that carries on. */}
            {isMobile && lens === "log" && (
              <div className="log-actions">
                <button className="vt-step" onClick={() => stepStop(-1)} aria-label="Previous flyby">
                  <Icon name="stage-prev" size={18} />
                </button>
                <button
                  className="log-sail"
                  onClick={() => {
                    setPausedAt(null);
                    setPanelOpen(false);
                    setPlaying(true);
                  }}
                >
                  Carry on
                  <Icon name="stage-next" size={16} />
                </button>
              </div>
            )}
          </DraggableWindow>
        )}
      </div>

      <TransportBar
        barRef={barRef}
        playing={playing}
        onTogglePlay={togglePlay}
        dateLabel={dateLabel}
        tracks={[
          {
            key: "voyage",
            tab: "Mission",
            caption: bodyName ? `Near ${bodyName}` : "",
            marks: milestoneLegs.map((l) => ({ id: l.wp.id, at: l.arrival, label: l.wp.body })),
            segmented: true,
            onMark: (at) => {
              setPlaying(false);
              openLog(at);
            },
          },
          ...(isMobile
            ? [
                {
                  key: "world",
                  tab: "World",
                  caption: worldNow ? worldNow.title : "",
                  marks: events.map((ev) => ({
                    id: ev.title,
                    at: ev.time,
                    label: ev.title,
                    className: `cat-${ev.category}`,
                  })),
                },
              ]
            : []),
        ]}
        activeTrack={track}
        onTrack={setTrack}
        t={t}
        min={minTime}
        max={maxTime}
        step={DAY}
        onScrub={(next) => {
          setPlaying(false);
          setT(next);
        }}
        autopause={autopause}
        onAutopause={setAutopause}
        lexicon={{
          timeline: "Mission timeline",
          autopause: "Pause at each flyby & event",
        }}
        phone={isMobile}
      />

      {lightbox && (
        <div className="plates-lightbox" onClick={() => setLightbox(null)}>
          <div className="plates-lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <button
              className="plates-lightbox-close"
              onClick={() => setLightbox(null)}
              aria-label="Close"
              title="Close"
            >
              ×
            </button>
            <img src={lightbox.item.url} alt={lightbox.item.caption} />
            <div className="plates-lightbox-cap">
              <div>
                <strong>{lightbox.place}</strong> — {lightbox.item.caption}
              </div>
              {lightbox.item.credit && <div className="plates-lightbox-credit">{lightbox.item.credit}</div>}
              {lightbox.item.source_url && (
                <a href={lightbox.item.source_url} target="_blank" rel="noreferrer">
                  source
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
