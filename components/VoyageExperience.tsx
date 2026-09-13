"use client";

import Icon from "@/components/Icon";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEdgeStack } from "@/lib/useEdgeStack";
import { useLayoutMode, isPhoneNow } from "@/lib/layout";
import type { BodyId, MediaItem, Navigator, Voyage, VoyageKind, Waypoint } from "@/lib/types";
import { voyageEventsFor, formatHistoricalMonthYear, parsePartialDate, type VoyageContextEvent } from "@/lib/world-events";
import DraggableWindow from "@/components/DraggableWindow";
import MapTop from "@/components/map/MapTop";
import MapNote from "@/components/map/MapNote";
import TransportBar from "@/components/map/TransportBar";
import ContributePanel from "@/components/ContributePanel";
import { voyageLogPath } from "@/lib/voyages";
import AtlasBrowser from "@/components/AtlasBrowser";
import { OTHER_COLOR, empireColorExpression, epochFor } from "@/lib/historical-maps";
import { basemapStyle, bodyBlurb, TILE_ATTRIBUTION, collapseAttributionOnPhone } from "@/lib/basemaps";
import {
  DAY,
  PLAYBACK_TICK_MS,
  PLAYBACK_SECONDS,
  buildLegs as buildMotionLegs,
  shipStateAt as motionShipStateAt,
  traveledLine as motionTraveledLine,
  type MotionLeg,
} from "@/lib/voyage-motion";

type Lens = "log" | "chart" | "carto" | "plates";

// Great powers and colours now come from the era's entry in lib/historical-maps.

/* What moves along the route. A caravel was crossing the Sea of Tranquillity,
   because this marker is built in JS and so the icon set never reached it.
   A surface traverse is walked, and it leaves the same print the log is
   marked with — the same drawing, filled, at marker size. */
const BOOT_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M8.2 12.4c-.9-2.6-.6-5.2.9-7.6.8-1.3 2-1.9 3.6-1.7 2.2.3 3.6 1.7 4.1 4 .5 2.2.2 4.3-.9 6.2-.6 1-1.5 1.5-2.7 1.5H11c-1.3 0-2.3-.7-2.8-2.4z"/>
  <path d="M9.2 18.6c0-1.3 1.2-2.1 2.9-2.1s2.9.8 2.9 2.1c0 .7-.1 1.4-.4 2-.4.9-1.2 1.4-2.5 1.4s-2.1-.5-2.5-1.4c-.3-.6-.4-1.3-.4-2z"/>
</svg>`;

const SHIP_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M3 15h18l-2.1 4.1a2 2 0 0 1-1.8 1.1H6.9a2 2 0 0 1-1.8-1.1L3 15z"/>
  <path d="M12.6 2.2c2.9 3 3.9 7 3.2 11h-3.2V2.2z"/>
  <path d="M11.4 4.4c-2.4 2-3.4 5-2.9 8.8h2.9V4.4z" opacity="0.72"/>
  <rect x="11.4" y="1.6" width="1.2" height="12"/>
</svg>`;

interface Leg {
  wp: Waypoint;
  lng: number; // unwrapped for continuity across the antimeridian
  lat: number;
  arrival: number;
  departure: number;
}

function toLeg(l: MotionLeg<Waypoint>): Leg {
  return { wp: l.wp, lng: l.x, lat: l.y, arrival: l.arrival, departure: l.departure };
}

function toMotionLeg(l: Leg): MotionLeg<Waypoint> {
  return { wp: l.wp, x: l.lng, y: l.lat, arrival: l.arrival, departure: l.departure };
}

// Thin adapters over lib/voyage-motion: this is the Earth-only lng/lat
// coordinate meaning, unwrapping longitude across the antimeridian for
// continuity — identical logic to the pre-extraction inline version.
function buildLegs(waypoints: Waypoint[]): Leg[] {
  return buildMotionLegs(waypoints, (wp, prevLng) => {
    let lng = wp.longitude;
    if (prevLng !== null) {
      while (lng - prevLng > 180) lng -= 360;
      while (lng - prevLng < -180) lng += 360;
    }
    return { x: lng, y: wp.latitude };
  }).map(toLeg);
}

function shipStateAt(t: number, legs: Leg[]): { lng: number; lat: number; index: number } {
  const s = motionShipStateAt(t, legs.map(toMotionLeg));
  return { lng: s.x, lat: s.y, index: s.index };
}

function traveledLine(t: number, legs: Leg[]): [number, number][] {
  return motionTraveledLine(t, legs.map(toMotionLeg));
}

function lineFeature(coords: [number, number][]) {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: coords },
  };
}

// `showDates` defaults true so every existing (Earth) call site is unchanged.
// Surface voyages whose stops all fall on the same calendar day (a single
// multi-hour EVA, e.g. Apollo 11) pass false: lib/voyage-motion.ts only
// resolves position at day granularity, so those waypoints are given
// distinct synthetic calendar days purely to keep them individually
// reachable on the scrubber — showing that synthetic date here would be
// misleading, so the real clock time (already in date_note) is shown alone.
// This comment described the intention and not the code for a while: the
// separation was written as `arrival < prevTime`, which does nothing when two
// stops carry the SAME date, and Apollo 11's six stops — five of them dated
// 21 July 1969 — collapsed onto two instants. Nothing said so; the rail simply
// drew one leg the width of the bar with four zero-width links stacked at its
// end, which reads as a rail nobody has styled yet rather than as five stages
// gone missing. The comment is now true of the code.
function formatRange(wp: Waypoint, showDates: boolean = true): string {
  const parts: string[] = [];
  if (showDates) {
    if (wp.arrival_date && wp.departure_date && wp.departure_date !== wp.arrival_date) {
      parts.push(`${wp.arrival_date} → ${wp.departure_date}`);
    } else if (wp.arrival_date) {
      parts.push(wp.arrival_date);
    }
  }
  if (wp.date_note) parts.push(wp.date_note);
  return parts.join(" · ");
}

// Great-circle distance in nautical miles.
function haversineNm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371; // km
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(s));
  return km / 1.852;
}

// Deterministic thousands separator (avoids SSR/CSR locale mismatch).
function fmtNm(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " nm";
}

// Same distance (haversineNm returns nautical miles) shown as km for
// non-Earth bodies, where "nautical miles" reads wrong — surface traverses
// are on foot/rover, not at sea.
function fmtKm(nm: number): string {
  return Math.round(nm * 1.852).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " km";
}

function fmtLat(lat: number): string {
  return `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? "N" : "S"}`;
}

export default function VoyageExperience({
  navigator,
  voyage,
  waypoints,
  body = "earth",
  atlasCount,
}: {
  navigator: Navigator;
  voyage: Voyage;
  waypoints: Waypoint[];
  body?: BodyId;
  /** How many voyages the atlas holds. A number, not the list — ATLAS stays
   *  out of this bundle on purpose, and a count is what the imprint needs. */
  atlasCount?: number;
}) {
  const isEarth = body === "earth";
  // Which political reconstruction this voyage is drawn over: the nearest in
  // time, not a fixed year. Stable for the map's lifetime, so the source URL
  // and the legend can both read it.
  const epoch = epochFor(voyage.start_date);
  const voyageYears = [voyage.start_date, voyage.end_date]
    .map((d) => (d ? String(d).slice(0, 4) : ""))
    .filter(Boolean)
    .join("–");
  const legs = useMemo(() => buildLegs(waypoints), [waypoints]);
  const minTime = legs.length ? legs[0].arrival : 0;
  const maxTime = legs.length ? legs[legs.length - 1].departure : 1;

  // Waypoints with photographic plates, in voyage order — feeds the Plates lens.
  const plateWaypoints = useMemo(
    () =>
      [...waypoints]
        .filter((w) => w.media && w.media.length > 0)
        .sort((a, b) => a.seq - b.seq),
    [waypoints]
  );

  // Cumulative sailed distance (nm) up to the start of each leg.
  const cumNm = useMemo(() => {
    const arr: number[] = [0];
    for (let i = 1; i < legs.length; i++) {
      arr[i] =
        arr[i - 1] +
        haversineNm(legs[i - 1].lat, legs[i - 1].lng, legs[i].lat, legs[i].lng);
    }
    return arr;
  }, [legs]);

  // World events within THIS voyage's window, on the same time axis. Read from
  // the checked-in catalogue projection; never fetched in the page path, so the
  // strip survives an upstream Wikimedia outage.
  const events = useMemo(
    () =>
      voyageEventsFor(voyage.slug)
        .map((e) => ({ ...e, time: parsePartialDate(e.date)?.time ?? minTime }))
        .filter((e) => e.time >= minTime && e.time <= maxTime)
        .sort((a, b) => a.time - b.time),
    [voyage.slug, minTime, maxTime]
  );

  const [t, setT] = useState(minTime);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [lens, setLens] = useState<Lens>("log");
  const [showHist, setShowHist] = useState(true);
  const [autopause, setAutopause] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [stripHover, setStripHover] = useState(false);
  /* Which timeline the phone's one rail is showing. Wide screens never see the
     switch, because the world has its own strip up there. */
  const [track, setTrack] = useState("voyage");
  /* Where playback put itself down, on a phone. Null while sailing. */
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const isMobile = useLayoutMode() === "phone";
  /* The bottom edge of a phone carries four things that each anchored to it
     with a hand-picked number: the launcher had four competing `bottom`
     declarations, one per collision someone patched. Four numbers cannot be
     held consistent by hand, and on a phone they weren't — the note ran into
     both the bar and the launcher, and MapLibre's attribution sat under the
     bar entirely. The heights are measured and published instead, so the
     stack is derived rather than guessed — see lib/useEdgeStack.ts. */
  const barRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLDivElement | null>(null);
  const [railOpen, setRailOpen] = useState(false);

  /* The welcome cartouche is a sibling mounted by the page, at a higher
     z-index, and the two knew nothing about each other — so opening the atlas
     put the panel underneath the very card that was pointing at it. The
     announcement now travels with the atlas door, in MapImprint, because only
     this experience ever made it. */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [atlasFilter, setAtlasFilter] = useState<VoyageKind>(voyage.kind ?? "earth");
  const [lightbox, setLightbox] = useState<{ item: MediaItem; place: string } | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [contribute, setContribute] = useState<{
    waypoint: Waypoint;
    contentType: "log" | "image";
    media?: MediaItem;
  } | null>(null);

  // Contribute buttons show only to signed-in users — same session check AccountPanel uses.
  useEffect(() => {
    fetch("/api/desk/me")
      .then((r) => r.json())
      .then((d) => setSignedIn(!!d?.signed_in))
      .catch(() => setSignedIn(false));
  }, []);

  // Esc closes the plate lightbox.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);


  const containerRef = useRef<HTMLDivElement>(null);
  useEdgeStack({ bar: barRef, note: noteRef, container: containerRef });
  const mapRef = useRef<any>(null);
  const shipMarkerRef = useRef<any>(null);
  const legsRef = useRef(legs);
  legsRef.current = legs;
  const tRef = useRef(t);
  tRef.current = t;
  const setTRef = useRef(setT);
  setTRef.current = setT;
  // Open the Log window at a specific landfall (used by route dots & timeline ticks).
  const openLogRef = useRef<(arrival: number) => void>(() => {});
  openLogRef.current = (arrival: number) => {
    setT(arrival);
    setLens("log");
    setPanelOpen(true);
  };

  /* The other half of the autopause-becomes-behaviour trade: having stopped,
     the phone SHOWS you why it stopped. Without this the voyage would simply
     halt on a map with no explanation, which is worse than the checkbox was. */
  useEffect(() => {
    if (pausedAt === null || !isMobile) return;
    setLens("log");
    setPanelOpen(true);
  }, [pausedAt, isMobile]);

  // Initialise the map once.
  useEffect(() => {
    let cancelled = false;
    let map: any;

    (async () => {
      const mod = await import("maplibre-gl");
      const gl: any = (mod as any).default ?? mod;
      if (cancelled || !containerRef.current) return;

      const L = legsRef.current;
      /* The route is painted by MapLibre onto a canvas, so it never passes
         through the cascade and a theme cannot reach it. It was a literal, and
         so the Moon's traverse ran in Age-of-Sail oxide. Read the token the
         theme actually resolved to and hand it over. */
      const routeColor =
        getComputedStyle(containerRef.current).getPropertyValue("--route").trim() || "#7a2e1d";
      map = new gl.Map({
        container: containerRef.current,
        style: basemapStyle(body),
        center: [L[0]?.lng ?? 0, L[0]?.lat ?? 0],
        zoom: 2,
        /* World copies are right for Earth, where a Pacific crossing runs off
           one edge and back on the other. On another body they tile it: the
           Moon was rendering MARE CRISIUM, MARE MARGINIS and MARE AUSTRALE
           twice each, which reads as wallpaper rather than as a world, and is
           the actual reason it did not look like the Moon. */
        renderWorldCopies: isEarth,
      });
      mapRef.current = map;

      map.on("load", () => {
        if (!map) return;
        /* MapLibre builds its own attribution, so it is reachable only after
           the map says it is ready — the same reason useEdgeStack has to
           measure that element rather than be told its height. */
        collapseAttributionOnPhone(containerRef.current);
        const full = L.map((l) => [l.lng, l.lat] as [number, number]);

        if (body === "earth") {
          // The political world nearest in time to THIS voyage — see epoch above.
          map.addSource("hist", { type: "geojson", data: epoch.file });
          const empireColor: any = empireColorExpression(epoch);
          map.addLayer({
            id: "hist-fill",
            type: "fill",
            source: "hist",
            paint: { "fill-color": empireColor, "fill-opacity": 0.5 },
          });
          map.addLayer({
            id: "hist-line",
            type: "line",
            source: "hist",
            paint: { "line-color": "#6b4a2a", "line-width": 0.8, "line-opacity": 0.55 },
          });

          // Hover a territory to reveal its name and sovereign of the era.
          const esc = (s: string) =>
            s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
          const histPopup = new gl.Popup({
            closeButton: false,
            closeOnClick: false,
            className: "hist-popup",
            offset: 8,
          });
          map.on("mousemove", "hist-fill", (e: any) => {
            const f = e.features && e.features[0];
            const p = (f && f.properties) || {};
            const name = String(p.NAME || "").trim();
            if (!name) {
              histPopup.remove();
              return;
            }
            const emp = p.EMPIRE && p.EMPIRE !== "Other" ? String(p.EMPIRE) : "";
            histPopup
              .setLngLat(e.lngLat)
              .setHTML(
                `<strong>${esc(name)}</strong>${emp ? `<span class="hp-emp"> · ${esc(emp)}</span>` : ""}`
              )
              .addTo(map);
          });
          map.on("mouseleave", "hist-fill", () => histPopup.remove());
        }

        map.addSource("route-full", { type: "geojson", data: lineFeature(full) });
        map.addSource("route-done", { type: "geojson", data: lineFeature([]) });

        map.addLayer({
          id: "route-full",
          type: "line",
          source: "route-full",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": routeColor,
            "line-width": 1.5,
            "line-opacity": 0.35,
            "line-dasharray": [2, 3],
          },
        });
        map.addLayer({
          id: "route-done",
          type: "line",
          source: "route-done",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": routeColor, "line-width": 3 },
        });

        // Waypoint markers (click to jump there in time).
        L.forEach((l) => {
          const el = document.createElement("div");
          const hasMedia = !!l.wp.media && l.wp.media.length > 0;
          el.className = `wp-dot conf-${l.wp.confidence}${hasMedia ? " has-media" : ""}`;
          el.title = l.wp.place_historical ?? l.wp.place_modern ?? "";
          el.addEventListener("click", () => openLogRef.current(l.arrival));
          new gl.Marker({ element: el }).setLngLat([l.lng, l.lat]).addTo(map!);
        });

        // The moving ship.
        const shipEl = document.createElement("div");
        shipEl.className = "ship-marker";
        shipEl.innerHTML = isEarth ? SHIP_SVG : BOOT_SVG;
        shipMarkerRef.current = new gl.Marker({ element: shipEl })
          .setLngLat([L[0].lng, L[0].lat])
          .addTo(map);

        // Frame the whole voyage.
        const bounds = new gl.LngLatBounds();
        full.forEach((c) => bounds.extend(c));
        /* Apollo 11's whole traverse is a few hundred metres wide, so framing
           it exactly puts the reader on the ground with no way to tell which
           ground. Off Earth the opening view stays far enough out that the
           maria are legible and the body identifies itself; the scrubber and
           the waypoints are how you go down to the surface. */
        /* A PHONE CANNOT HOLD THE WHOLE WORLD, so it stops pretending to.
           Framed to the whole voyage on a 412px screen, a circumnavigation is
           a thumbnail arc in one corner and the rest is empty ocean — the map
           was drawing the extent of the journey rather than the journey. Here
           it opens on the ship at a zoom where a coast is legible, and follows
           her while she sails (see the effect that moves the marker). Wide
           screens keep the whole-voyage frame: there the extent IS readable,
           and it is the better first sentence. */
        if (isPhoneNow()) {
          map.jumpTo({ center: [L[0].lng, L[0].lat], zoom: isEarth ? 3.2 : 2.4 });
        } else {
          map.fitBounds(bounds, { padding: 70, duration: 0, ...(isEarth ? {} : { maxZoom: 3 }) });
        }

        setReady(true);
      });
    })();

    return () => {
      cancelled = true;
      if (map) map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw the traveled route and reposition the ship whenever time changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const L = legsRef.current;
    const src = map.getSource("route-done");
    if (src) src.setData(lineFeature(traveledLine(t, L)));
    const ship = shipStateAt(t, L);
    shipMarkerRef.current?.setLngLat([ship.lng, ship.lat]);
    /* The camera travels with her, but ONLY while she is under way. Paused,
       the map belongs to the reader — dragging it somewhere and being hauled
       back is the behaviour of a thing that will not let you look.
       On a wide screen too, now. The phone got this because it cannot hold a
       whole ocean; a desktop was given the whole ocean and, having it, showed
       a two-pixel marker inching across an empty one. Following is not a
       small-screen compromise — it is what makes the passage legible.
       Held off while the closing ease is running: setCenter is a jump, and a
       jump every 40ms during an animated approach cancels the approach. */
    if (playing && !map.isEasing?.()) map.setCenter([ship.lng, ship.lat]);
    /* `playing` is read here, so it is declared here. It happened to work
       without it — t changes on every tick, so the closure was never stale for
       long — which is the kind of thing that works until the tick stops.
       `isMobile` has left the list with the branch that read it: following is
       no longer a property of the arrangement. */
  }, [t, ready, playing]);

  /* THE APPROACH, on a wide screen. Pressing play closes the distance once,
     over the better part of a second, and then the camera simply travels.
     Deliberately FARTHER OUT than the phone's (3.2 on Earth, 2.4 elsewhere):
     a wide screen holds several times the ground at the same zoom, and this
     view has to keep the coast the ship is leaving and the water ahead of her
     in the same frame — that relation IS the passage. Closer, it becomes a
     marker on a texture.
     Never zooms OUT: if the reader has gone in to look at something, the ship
     comes to them. And nothing is undone on pause, because the map belongs to
     the reader the moment she stops. */
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !playing || isMobile) return;
    const ship = shipStateAt(tRef.current, legsRef.current);
    map.easeTo({
      center: [ship.lng, ship.lat],
      zoom: Math.max(map.getZoom(), isEarth ? 2.4 : 2),
      duration: 900,
    });
  }, [playing, ready, isMobile, isEarth]);

  // Playback loop — the pace lives in lib/voyage-motion.
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
        /* On a phone this is not a setting. The checkbox that turned it on
           cost a whole row of a 165px bar to ask a question you answer once,
           so the answer became the behaviour: the voyage always stops, the log
           opens, and the log carries the button that sails on. That is a
           control in context instead of a preference in the abstract — and it
           is what let the row go rather than be hidden, which was tried once
           and left a naked checkbox nobody could read.

           The price, taken deliberately: a phone can no longer watch a voyage
           play through unattended. On a screen where the reading is the log
           and the map is a thumbnail, that is the cheaper half. */
        if (autopause || isMobile) {
          const nextLeg = legs.find((l) => l.arrival > prev + 1)?.arrival ?? Infinity;
          /* ON A PHONE, ONLY A LANDFALL STOPS THE SHIP.
             The wide arrangement halts at the next milestone on EITHER
             timeline, which is right there because both are on screen and the
             checkbox says so. Here it was wrong and it showed: the ship stopped
             at the Fall of Ayutthaya and opened the SHIP'S LOG, which has
             nothing to say about Ayutthaya. Every stop looked identical and
             none of them explained itself.
             A world event is something that happened elsewhere while the ship
             sailed; it is not a place the ship arrived at, so it cannot be a
             stop on a journey whose whole grammar is arrive-read-sail on. It
             stays on the rail and in the caption, where it is context rather
             than an interruption. */
          const nextEv = isMobile
            ? Infinity
            : events.find((e) => e.time > prev + 1)?.time ?? Infinity;
          const stop = Math.min(nextLeg, nextEv);
          if (Number.isFinite(stop) && next >= stop) {
            setPlaying(false);
            /* Recorded rather than acted on here: opening the log from inside
               a state updater would nest one setState in another, and the
               updater is re-run under StrictMode. The effect below does it. */
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
  }, [playing, minTime, maxTime, autopause, legs, events]);

  useEffect(() => {
    if (playing && t >= maxTime) setPlaying(false);
  }, [t, playing, maxTime]);

  // Toggle the 1715 political overlay (Earth only — non-Earth bodies never
  // add the "hist-*" layers, see the map.on("load") block above).
  useEffect(() => {
    const map = mapRef.current;
    if (!isEarth || !ready || !map) return;
    const vis = showHist ? "visible" : "none";
    ["hist-fill", "hist-line"].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
    });
  }, [showHist, ready, isEarth]);

  // Ship state + navigation figures for the current instant.
  const shipNow = shipStateAt(t, legs);
  const idx = shipNow.index;
  const current = legs[idx]?.wp;
  const partialNm = legs.length
    ? haversineNm(legs[idx].lat, legs[idx].lng, shipNow.lat, shipNow.lng)
    : 0;
  const totalNm = (cumNm[idx] ?? 0) + partialNm;
  const legNm = idx > 0 ? cumNm[idx] - cumNm[idx - 1] : 0;
  const daysAtSea = Math.max(0, Math.round((t - minTime) / DAY));

  // Hand-rolled so BCE and two-digit years are honest (Intl drops the era or
  // reads "42" as 1942). Same convention as the rest of the Atlas.
  const dateLabel = formatHistoricalMonthYear(t);
  const pct = maxTime > minTime ? ((t - minTime) / (maxTime - minTime)) * 100 : 0;

  // Current world event = the most recent one on or before the ship's date.
  let worldNow: (VoyageContextEvent & { time: number }) | null = null;
  for (const e of events) {
    if (e.time <= t) worldNow = e;
    else break;
  }
  const pctOf = (time: number) =>
    Math.max(
      0,
      Math.min(100, maxTime > minTime ? ((time - minTime) / (maxTime - minTime)) * 100 : 0)
    );

  /* Step to the next landfall. It lives here rather than on the bar because
     the buttons live on the LOG — you are already reading the place they move
     between, which is the argument for moving them off the map at all.

     A day of tolerance: `t` sits exactly on an arrival when a stepper put it
     there and a hair off when the scrubber did, and without the margin a
     second press from a scrubbed position finds the stop it is on. Clamped
     rather than wrapping — a voyage has a first landfall and a last. */
  const stepStop = (dir: 1 | -1) => {
    setPlaying(false);
    setPausedAt(null);
    const at = legs.map((l) => l.arrival);
    const next =
      dir === 1 ? at.find((x) => x > t + DAY) : [...at].reverse().find((x) => x < t - DAY);
    openLogRef.current(next ?? (dir === 1 ? maxTime : minTime));
  };


  function togglePlay() {
    setPanelOpen(true);
    if (!playing) {
      if (t >= maxTime) setT(minTime);
      setPlaying(true);
    } else {
      setPlaying(false);
    }
  }

  const placeName = current?.place_historical || current?.place_modern || "";
  const panelTitle =
    lens === "log"
      ? "Ship's Log"
      : lens === "chart"
      ? "Navigation Chart"
      : lens === "plates"
      ? "Plates"
      : "Cartographer";

  return (
    /* This component draws two of the three atlases. Which one is a property
       of the BODY, not of the renderer: a surface traverse reaches MapLibre by
       the same road an Age-of-Sail voyage does, and used to arrive wearing its
       parchment. data-body carries the accent; see .worlds in globals.css. */
    <div
      className={isEarth ? undefined : "worlds"}
      data-body={isEarth ? undefined : body}
      style={{ position: "relative", height: "100dvh", overflow: "hidden" }}
    >
      <h1 className="sr-only">{voyage.title} — {navigator.name} — Terraveler</h1>

      {/* Three classes of thing live on this map and they are told apart by
          material, not by where they sit.

          The IMPRINT says whose chart this is. It is not a control, so it has
          no container: ink straight onto the map, which measures 11:1 against
          the basemap where white measured 1.41.

          A DOOR takes you somewhere else. Doors are round and dark — the one
          material nothing else on the map uses — so the atlas door stops being
          read as the wordmark's symbol, which is exactly what it was.

          INSTRUMENTS change what you see of this voyage and stay parchment
          plates: the lens rail, the transport bar, the world strip.

          The strapline used to sit under the wordmark. It was decoration on
          the one surface with no room for any: what a newcomer needs to know
          is that this is one chart of many, and how to see the others. */}
      <MapTop
        title={voyage.title}
        atlasCount={atlasCount}
        pickerOpen={pickerOpen}
        onTogglePicker={() => setPickerOpen((o) => !o)}
      />

      {/* Vertical lens rail — left edge, vertically centred. On mobile it
          collapses to a single small button showing the active lens. */}
      <div className="lens-rail" role="group" aria-label="View lens">
        {isMobile && !railOpen ? (
          <button
            className="lens-btn lens-btn-ico rail-toggle"
            aria-label="Open tools"
            title="Tools"
            onClick={() => setRailOpen(true)}
          >
            <Icon name={lens === "log" ? "anchor" : lens === "chart" ? "map" : lens === "plates" ? "plates" : "compass"} size={19} />
          </button>
        ) : (
          <>
            <button
              className={`lens-btn lens-btn-ico ${lens === "log" ? "active" : ""}`}
              title="Ship's Log — the journal at each landfall"
              aria-label="Ship's Log"
              onClick={() => {
                setLens("log");
                setPanelOpen(true);
                setRailOpen(false);
              }}
            >
              {/* An anchor is a thing you drop in water. */}
              <Icon name={isEarth ? "anchor" : "bootprint"} size={19} />
            </button>
            <button
              className={`lens-btn lens-btn-ico ${lens === "chart" ? "active" : ""}`}
              title="Navigation Chart — the voyage's instruments"
              aria-label="Navigation Chart"
              onClick={() => {
                setLens("chart");
                setPanelOpen(true);
                setRailOpen(false);
              }}
            >
              <Icon name="map" size={19} />
            </button>
            <button
              className={`lens-btn lens-btn-ico ${lens === "carto" ? "active" : ""}`}
              title="Cartographer — map layers and legend"
              aria-label="Cartographer"
              onClick={() => {
                setLens("carto");
                setPanelOpen(true);
                setRailOpen(false);
              }}
            >
              <Icon name="compass" size={19} />
            </button>
            <button
              className={`lens-btn lens-btn-ico ${lens === "plates" ? "active" : ""}`}
              title="Plates — period images from the log"
              aria-label="Plates"
              onClick={() => {
                setLens("plates");
                setPanelOpen(true);
                setRailOpen(false);
              }}
            >
              <Icon name="plates" size={19} />
            </button>
            {/* A moai rather than a feather. The feather is pan-ethnic shorthand
                that belongs to no actual people — it says "native" the way a
                silhouette says "person". The moai belongs to Rapa Nui and to
                nobody else, and it carries what this lens is for: Roggeveen
                found the statues already standing in 1722, no European ever saw
                one raised, and the people who raised them explained themselves
                in stone because no journal of theirs survives. Art outliving
                the record is the whole argument. See issue #11. */}
            <button className="lens-btn lens-btn-ico" disabled title="Peoples — coming soon" aria-label="Peoples (coming soon)">
              <Icon name="antiquity" size={19} />
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

      {/* The Atlas panel */}
      {pickerOpen && (
        <AtlasBrowser
          onClose={() => setPickerOpen(false)}
          voyage={voyage}
          navigator={navigator}
        />
      )}


      {/* World-events strip: dots always, words only when there is something to
          say — and on a wide screen only. On a phone this was a 45px band at
          the top of the map encoding the same time axis as the bar at the
          bottom, which is two timelines at opposite ends of a small screen. It
          moves into the bar's switch there. It also opens on hover, which does
          not exist under a finger, so down there it had nothing to say anyway. */}
      {!isMobile && (
      <div
        className="world-strip"
        onMouseEnter={() => setStripHover(true)}
        onMouseLeave={() => setStripHover(false)}
      >
        <div className="ws-kicker">Meanwhile in the world</div>
        {events.length === 0 ? (
          <div className="ws-empty">
            No validated contemporary events are cached for this voyage yet.
          </div>
        ) : (
          <>
            <div className="wt-track">
              {events.map((ev) => (
                <button
                  key={ev.id}
                  className={`wt-dot cat-${ev.category} ${
                    worldNow && ev.id === worldNow.id ? "active" : ""
                  }`}
                  style={{ left: `${pctOf(ev.time)}%` }}
                  title={`${ev.date} · ${ev.title} · ${ev.category}`}
                  aria-label={ev.title}
                  data-qid={ev.qid ?? undefined}
                  data-relevance-class={ev.relevance_class}
                  data-relevance-score={ev.relevance_score}
                  onClick={() => {
                    setPlaying(false);
                    setT(ev.time);
                  }}
                />
              ))}
              <div className="wt-playhead" style={{ left: `${pct}%` }} />
            </div>
            {worldNow && (stripHover || t - worldNow.time < 45 * DAY) && (
              <div className="ws-card" data-qid={worldNow.qid ?? undefined}>
                <strong>{worldNow.title}</strong> — {worldNow.blurb}{" "}
                {worldNow.why && <span className="ws-why">{worldNow.why}</span>}{" "}
                {(worldNow.wikipedia_url || worldNow.wikidata_url) && (
                  <a
                    href={(worldNow.wikipedia_url || worldNow.wikidata_url) as string}
                    target="_blank"
                    rel="noreferrer"
                    className="wt-src"
                  >
                    {worldNow.wikipedia_url ? "Wikipedia" : "Wikidata"}
                  </a>
                )}{" "}
                {worldNow.qid && (
                  <a
                    href={worldNow.wikidata_url as string}
                    target="_blank"
                    rel="noreferrer"
                    className="wt-src"
                  >
                    {worldNow.qid}
                  </a>
                )}{" "}
                <span className="wt-attrib">Wikipedia / Wikidata · CC BY-SA</span>
              </div>
            )}
          </>
        )}
      </div>
      )}

      <div style={{ position: "absolute", inset: 0 }}>
        <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

        {isEarth && (
          <MapNote
            className="hist-note"
            ref={noteRef}
            label={`World c. ${epoch.year}`}
            short={String(epoch.year)}
          >
            World c.&nbsp;{epoch.year} — the nearest reconstruction to this voyage
            {voyageYears ? ` (${voyageYears})` : ""}; great powers coloured, key in the
            Cartographer lens. A reconstruction; precision varies.{" "}
            <a href="https://github.com/aourednik/historical-basemaps" target="_blank" rel="noreferrer">
              Borders: aourednik, CC&nbsp;BY-SA&nbsp;4.0
            </a>
          </MapNote>
        )}

        {/* Below the door cluster, not behind it. With no anchor the log fell to
            DraggableWindow's top-right default — which is precisely where the
            menu and account doors sit, so it opened underneath them. */}
        {current && panelOpen && (
          <DraggableWindow
            title={panelTitle}
            onClose={() => setPanelOpen(false)}
            initial={{ right: 16, top: 68 }}
          >
            {lens === "carto" ? (
              isEarth ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--brass)", letterSpacing: "0.08em" }}>
                    Map key
                  </span>
                  <span className="conf-badge">c. {epoch.year}</span>
                </div>
                <h2 style={{ margin: "4px 0 6px", fontSize: "1.3rem" }}>The great powers of the era</h2>
                <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink-soft)", margin: "0 0 10px" }}>
                  {epoch.blurb} Colours mark this era&rsquo;s great powers; most of the
                  globe was still independent states and peoples.
                </p>
                <div className="legend">
                  {epoch.powers.map(({ label, color }) => (
                    <div className="legend-row" key={label}>
                      <span className="legend-sw" style={{ background: color }} />
                      <span>{label}</span>
                    </div>
                  ))}
                  <div className="legend-row">
                    <span className="legend-sw" style={{ background: OTHER_COLOR }} />
                    <span>Independent states &amp; peoples</span>
                  </div>
                </div>
                <label className="hist-toggle">
                  <input
                    type="checkbox"
                    checked={showHist}
                    onChange={(e) => setShowHist(e.target.checked)}
                  />
                  Show period borders &amp; territories
                </label>
              </>
              ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--brass)", letterSpacing: "0.08em" }}>
                    Map key
                  </span>
                  <span className="conf-badge" style={{ textTransform: "capitalize" }}>{body}</span>
                </div>
                <h2 style={{ margin: "4px 0 6px", fontSize: "1.3rem" }}>
                  {body === "moon" ? "The Moon" : body === "mars" ? "Mars" : body}
                </h2>
                <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink-soft)", margin: "0 0 10px" }}>
                  {bodyBlurb(body)}
                </p>
                <p style={{ fontSize: 12, color: "var(--ink-soft)", fontStyle: "italic" }}>
                  {TILE_ATTRIBUTION[body]}
                </p>
              </>
              )
            ) : lens === "plates" ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--brass)", letterSpacing: "0.08em" }}>
                    The plates
                  </span>
                  <span className="conf-badge">{plateWaypoints.length} landfalls</span>
                </div>
                <h2 style={{ margin: "4px 0 6px", fontSize: "1.3rem" }}>Images from the log</h2>
                {plateWaypoints.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--ink-soft)", fontStyle: "italic" }}>
                    No plates recorded for this voyage yet.
                  </div>
                ) : (
                  plateWaypoints.map((wp) => (
                    <div className="plates-group" key={wp.id}>
                      <div className="contrib-plates-head">
                        <h3 className="plates-place">
                          {wp.place_historical || wp.place_modern}
                        </h3>
                        {signedIn && (
                          <button
                            type="button"
                            className="contrib-btn"
                            onClick={() => setContribute({ waypoint: wp, contentType: "image" })}
                            title={`Suggest an image or source for ${wp.place_historical || wp.place_modern}`}
                          >
                            <Icon name="quill" size={15} /> Open Waypoint
                          </button>
                        )}
                      </div>
                      <div className="plates-grid">
                        {(wp.media ?? []).map((m, i) => (
                          <figure className="plates-thumb" key={i}>
                            <button
                              type="button"
                              className="plates-thumb-btn"
                              onClick={() =>
                                setLightbox({
                                  item: m,
                                  place: wp.place_historical || wp.place_modern || "",
                                })
                              }
                              aria-label={`View larger: ${m.caption}`}
                            >
                              <img src={m.url} alt={m.caption} loading="lazy" />
                            </button>
                            <figcaption>
                              <div className="plates-caption">{m.caption}</div>
                              {/* When the image was made, which is regularly not
                                  when the stage happened. Printed beside the
                                  credit because a plate set next to a dated
                                  stage asserts they share that date unless the
                                  page says otherwise. */}
                              {m.date && <div className="plates-date">{m.date}</div>}
                              {m.credit && <div className="plates-credit">{m.credit}</div>}
                              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                                {m.source_url && (
                                  <a
                                    href={m.source_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="plates-source"
                                  >
                                    source
                                  </a>
                                )}
                                {signedIn && (
                                  <button
                                    type="button"
                                    className="plates-contrib-mini"
                                    onClick={() =>
                                      setContribute({ waypoint: wp, contentType: "image", media: m })
                                    }
                                    aria-label={`Suggest a fix or replacement for: ${m.caption}`}
                                    title="Suggest a fix or replacement for this image"
                                  >
                                    <Icon name="quill" size={15} />
                                  </button>
                                )}
                              </div>
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
                    Landfall {current.seq}
                  </span>
                  <span className="conf-badge">{current.confidence}</span>
                </div>
                <h2 style={{ margin: "4px 0 2px", fontSize: "1.3rem" }}>{placeName}</h2>

                {lens === "log" ? (
              <>
                {signedIn && (
                  <div style={{ display: "flex", justifyContent: "flex-end", margin: "0 0 4px" }}>
                    <button
                      type="button"
                      className="contrib-btn"
                      onClick={() => setContribute({ waypoint: current, contentType: "log" })}
                      title="Suggest a source, correction, or detail for this stop"
                    >
                      <Icon name="quill" size={15} /> Open Waypoint
                    </button>
                  </div>
                )}
                {current.place_modern &&
                  current.place_historical &&
                  current.place_modern !== current.place_historical && (
                    <div style={{ color: "var(--ink-soft)", fontSize: 13, fontStyle: "italic" }}>
                      {current.place_modern}
                    </div>
                  )}
                <div style={{ color: "var(--ink-soft)", fontSize: 13, margin: "6px 0" }}>
                  {formatRange(current, isEarth)}
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
                    No verified journal excerpt for this landfall yet.
                  </div>
                )}
                {/* The whole journal, as a plain readable page — the reader is
                    already reading one entry; offer them all of them. */}
                <a className="log-full-link" href={voyageLogPath(voyage.slug)}>
                  <Icon name="scroll" size={16} /> Read the whole log as text →
                </a>
              </>
            ) : (
              <>
                <div style={{ color: "var(--ink-soft)", fontSize: 13, margin: "2px 0 4px" }}>
                  {current.place_modern}
                </div>
                <div className="instruments">
                  <div>
                    <span>Latitude</span>
                    <strong>{fmtLat(shipNow.lat)}</strong>
                  </div>
                  <div>
                    <span>{isEarth ? "Days at sea" : "Days on the surface"}</span>
                    <strong>{daysAtSea}</strong>
                  </div>
                  <div>
                    <span>{isEarth ? "Sailed so far" : "Traveled so far"}</span>
                    <strong>{isEarth ? fmtNm(totalNm) : fmtKm(totalNm)}</strong>
                  </div>
                  <div>
                    <span>Last passage</span>
                    <strong>{legNm ? (isEarth ? fmtNm(legNm) : fmtKm(legNm)) : "—"}</strong>
                  </div>
                  <div>
                    <span>{isEarth ? "Ports made" : "Stops made"}</span>
                    <strong>
                      {idx + 1} / {legs.length}
                    </strong>
                  </div>
                  <div>
                    <span>Position certainty</span>
                    <strong style={{ textTransform: "capitalize" }}>{current.confidence}</strong>
                  </div>
                </div>
                {current.date_note && (
                  <p className="surveyor-note">Surveyor&rsquo;s note: {current.date_note}</p>
                )}
              </>
            )}
              </>
            )}

            {/* WHAT THE BAR GAVE UP. On a phone the log is a page, not a
                window, so it is where you already are when the voyage stops —
                which makes it the right place for the controls that move
                between stops, and the only honest home for the one that sails
                on. Sailing on closes the log: the point of continuing is to
                watch the ship move, and it cannot be watched from behind a
                full-bleed sheet. */}
            {isMobile && lens === "log" && (
              <div className="log-actions">
                <button
                  className="vt-step"
                  onClick={() => stepStop(-1)}
                  aria-label="Previous landfall"
                >
                  <Icon name="stage-prev" size={18} />
                </button>
                {/* One forward button, not two. There was also a "next
                    landfall" stepper here that JUMPED — same destination,
                    arrived at instantly. On a map whose whole subject is the
                    passage between two places, a cut is the wrong verb: this
                    one closes the log, sails, and opens the log again when it
                    gets there. Going back stays a jump, because nobody watches
                    a ship un-sail. */}
                <button
                  className="log-sail"
                  onClick={() => {
                    setPausedAt(null);
                    setPanelOpen(false);
                    setPlaying(true);
                  }}
                >
                  Sail on
                  <Icon name="stage-next" size={16} />
                </button>
              </div>
            )}
          </DraggableWindow>
        )}

        {contribute && (
          <ContributePanel
            voyageSlug={voyage.slug}
            voyageTitle={voyage.title}
            waypoint={contribute.waypoint}
            contentType={contribute.contentType}
            media={contribute.media}
            onClose={() => setContribute(null)}
          />
        )}
      </div>

      <TransportBar
        barRef={barRef}
        playing={playing}
        onTogglePlay={togglePlay}
        dateLabel={dateLabel}
        /* Two tracks on one axis. The world's events reach this bar only on a
           phone — on a wide screen the strip above still has room of its own,
           and moving it down there would buy nothing. */
        tracks={[
          {
            key: "voyage",
            tab: "Voyage",
            caption: placeName ? `Off ${placeName}` : "",
            marks: legs.map((l) => ({
              id: l.wp.id,
              at: l.arrival,
              label: l.wp.place_historical ?? l.wp.place_modern ?? "landfall",
            })),
            segmented: true,
            onMark: (at) => {
              setPlaying(false);
              openLogRef.current(at);
            },
          },
          ...(isMobile
            ? [
                {
                  key: "world",
                  tab: "World",
                  /* The caption is the caption OF THE TRACK, so switching the
                     rail switches what the date is telling you about. */
                  caption: worldNow ? worldNow.title : "",
                  marks: events.map((ev) => ({
                    id: ev.id,
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
          timeline: "Voyage timeline",
          autopause: "Pause at each stop & event",
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
              {lightbox.item.date && (
                <div className="plates-lightbox-credit">Made {lightbox.item.date}</div>
              )}
              {lightbox.item.credit && (
                <div className="plates-lightbox-credit">{lightbox.item.credit}</div>
              )}
              {/* The holder's terms, where they differ from the work's licence:
                  the engraving is public domain and the library still asserts
                  something about its scan. Shown here rather than on the thumb
                  because it is a paragraph, and the lightbox is where a plate
                  is actually being examined. */}
              {lightbox.item.rights_note && (
                <div className="plates-lightbox-rights">{lightbox.item.rights_note}</div>
              )}
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
