"use client";

import { useMemo, useState } from "react";
import Icon from "@/components/Icon";
import AtlasSearch from "@/components/AtlasSearch";
import DraggableWindow from "@/components/DraggableWindow";
import { ATLAS, voyageLogPath } from "@/lib/voyages";
import type { Voyage, Navigator } from "@/lib/types";

export default function AtlasBrowser({
  onClose,
  voyage,
  navigator,
}: {
  onClose: () => void;
  voyage: Voyage;
  navigator: Navigator;
}) {
  const counts = useMemo(() => {
    const earth = ATLAS.filter((v) => (v.kind ?? "earth") === "earth").length;
    const surface = ATLAS.filter((v) => v.kind === "surface").length;
    const space = ATLAS.filter((v) => v.kind === "space").length;
    return { earth, surface, space, total: ATLAS.length };
  }, []);

  const [activeKind, setActiveKind] = useState<"earth" | "surface" | "space">(() => {
    if (voyage.kind === "space") return "space";
    if (voyage.kind === "surface") return "surface";
    return "earth";
  });

  const [isSearching, setIsSearching] = useState(false);

  const explanation = {
    earth: "Historical maritime expeditions and voyages across Earth.",
    surface: "Surface traverses and overland exploration of other celestial bodies.",
    space: "Deep space missions and robotic exploration of the solar system.",
  }[activeKind];

  const currentVoyageLabel = voyage.kind === "space" ? "CURRENT MISSION" : "CURRENT VOYAGE";

  return (
    <DraggableWindow title="The Atlas" onClose={onClose} width={390} initial={{ left: 72, top: 168 }}>
      <section aria-label="The Atlas" className="atlas-browser">
        {!isSearching && (
          <div className="atlas-browser-orientation">
            <span className="cart-kicker">THE ATLAS</span>
            <div className="atlas-orientation-title">{counts.total} voyages across three realms</div>
          </div>
        )}

        {!isSearching && (
          <div className="atlas-chips">
            <button
              type="button"
              className={`atlas-chip ${activeKind === "earth" ? "cur" : ""}`}
              onClick={() => setActiveKind("earth")}
            >
              Age of Sail · {counts.earth}
            </button>
            <button
              type="button"
              className={`atlas-chip ${activeKind === "surface" ? "cur" : ""}`}
              title="Boots on other worlds"
              onClick={() => setActiveKind("surface")}
            >
              Worlds · {counts.surface}
            </button>
            <button
              type="button"
              className={`atlas-chip ${activeKind === "space" ? "cur" : ""}`}
              title="The probes kept logs too"
              onClick={() => setActiveKind("space")}
            >
              Space · {counts.space}
            </button>
          </div>
        )}

        {!isSearching && <div className="realm-explanation">{explanation}</div>}

        <AtlasSearch
          placeholder="Search voyages, navigators, places…"
          kind={activeKind}
          excludeSlug={voyage.slug}
          onActiveChange={setIsSearching}
          browseAll={false}
        />

        {!isSearching && (
          <div className="current-voyage-section">
            <span className="cart-kicker">{currentVoyageLabel}</span>
            <div className="current-voyage-title">{voyage.title}</div>
            <div className="current-voyage-nav">
              <strong>{navigator.name}</strong>
              {navigator.birth_year
                ? voyage.kind === "space"
                  ? ` (launched ${navigator.birth_year})`
                  : ` (${navigator.birth_year}–${navigator.death_year ?? ""})`
                : ""}
            </div>
            <div className="current-voyage-ships">{voyage.ships}</div>

            <div className="current-voyage-actions">
              <a className="log-full-link" href={voyageLogPath(voyage.slug)}>
                <Icon name="scroll" size={15} /> Read voyage log as text →
              </a>
            </div>
          </div>
        )}

        {!isSearching && (
          <div className="atlas-grow-cta">
            <span className="cart-kicker">HELP THE ATLAS GROW</span>
            <p className="cta-text">
              Know of a missing voyage or unresolved story? Explore open Waypoints in the Chartroom.
            </p>
            <a className="cta-link" href="/contribute">
              Visit the Chartroom →
            </a>
          </div>
        )}
      </section>
    </DraggableWindow>
  );
}
