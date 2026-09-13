import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PHONE_MAX, PHONE_QUERY, LAYOUT_SCRIPT } from "../lib/layout";

/* Two guards on the layout layer.
 *
 * The first says the boundary is written once. It was written three times —
 * twice as a matchMedia string in TypeScript and twenty-seven times in the
 * stylesheet — and the TypeScript half is what this closes now.
 *
 * The second is a ratchet, not a clean bill. Six selectors are still declared
 * in more than one responsive block, which is how `.pig-launch` came to have
 * three competing `bottom` values 1300 lines apart. Cleaning them up is the
 * migration to `[data-layout]`; until then this freezes the count so the debt
 * can only shrink. A test that passes while the number grows is worth nothing.
 */

const ROOT = join(import.meta.dirname, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

test("the phone boundary is spelled in exactly one file", () => {
  const offenders: string[] = [];
  for (const path of sources(ROOT)) {
    const rel = path.slice(ROOT.length + 1).replaceAll("\\", "/");
    if (rel === "lib/layout.ts" || rel.startsWith("test/")) continue;
    const src = readFileSync(path, "utf8");
    /* A width query written out by hand — the thing lib/layout.ts exists to
       replace. Anything responsive in TypeScript reads PHONE_QUERY or the
       hook; nothing spells the number. */
    for (const m of src.matchAll(/["'`][^"'`]*(?:max|min)-width\s*:[^"'`]*["'`]/g)) {
      offenders.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a viewport width is written by hand outside lib/layout.ts:\n  ${offenders.join("\n  ")}`,
  );
});

test("the layout script carries the one boundary and keeps the attribute true", () => {
  assert.ok(LAYOUT_SCRIPT.includes(String(PHONE_MAX)), "the script must be built from PHONE_MAX");
  assert.ok(LAYOUT_SCRIPT.includes(PHONE_QUERY), "the script must use the shared query");
  /* It sets the attribute AND follows the boundary afterwards: the stylesheet
     depends on it, so a rotation must not leave the page in the other mode. */
  assert.match(LAYOUT_SCRIPT, /addEventListener\("change"/);
  assert.match(LAYOUT_SCRIPT, /"data-layout"/);
});

/* Blank the comments but keep the newlines, so line numbers still identify a
   block. Scanning around them instead cost a wrong answer once already: a
   multi-line comment ran into the selector buffer, and `.transport-bar`'s
   declaration inside the derived-stack block went unseen because the prose
   above it contained a comma. */
function uncommented(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

/* The shells that PRESENT the navigation. A page may link to /contribute in
   its prose; a shell may not spell the list, because it will go stale and did:
   the destinations were written four times — the header, the footer and both
   map experiences — and three of the four were behind. The maps still offered
   /search after the reform that removed it and never gained /crew; the footer
   never gained /crew either. Only the header was current, which is why nobody
   saw it. */
const SHELLS = [
  "components/SiteHeader.tsx",
  "components/SiteFooter.tsx",
  "components/map/MapDoors.tsx",
];

test("no shell spells the destinations it presents", async () => {
  const { ALL } = await import("../lib/nav");
  const offenders: string[] = [];
  for (const shell of SHELLS) {
    const src = readFileSync(join(ROOT, shell), "utf8");
    for (const d of ALL) {
      if (src.includes(`"${d.href}"`)) offenders.push(`${shell} spells ${d.href}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a shell holds its own copy of the navigation:\n  ${offenders.join("\n  ")}`,
  );
});

test("the retired door is not offered anywhere", async () => {
  const { ALL } = await import("../lib/nav");
  /* Search stopped being a destination in 20f321a — it is an action that opens
     in the bar and lands in the atlas. The maps kept offering it for weeks. */
  assert.equal(ALL.find((d) => d.href === "/search"), undefined);
  for (const shell of SHELLS) {
    assert.ok(
      !readFileSync(join(ROOT, shell), "utf8").includes('"/search"'),
      `${shell} still offers /search as a destination`,
    );
  }
});

/* Every hover rule must sit inside @media (hover: hover).
 *
 * On a touch screen a :hover fires on tap and then STICKS until something else
 * is tapped, so a control keeps its pressed appearance while the finger is long
 * gone. All 78 rules here are visual feedback rather than revealed content, so
 * nothing is lost by withholding them — but nothing was withholding them.
 *
 * This one is a capability query rather than an attribute on <html>, and the
 * distinction is worth stating because the arrangement rule went the other way.
 * A viewport media query FORCES the compact rule to be written far from the one
 * it replaces, and its boundary is a number TypeScript also needs; neither is
 * true here. There is nothing to share, nothing in TypeScript reads it, and the
 * wrapper leaves the rule exactly where it was. It also cannot drift, which a
 * hand-written 680 could.
 */
const STYLESHEETS = ["app/globals.css", "app/specimen/specimen.css"];

test("no hover rule fires where there is no pointer", () => {
  const naked: string[] = [];

  for (const sheet of STYLESHEETS) {
    const lines = uncommented(readFileSync(join(ROOT, sheet), "utf8")).split("\n");
    /* One entry per open brace, true where that brace was the hover gate, so a
       rule nested any distance inside it still counts as covered. */
    const open: boolean[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const gate = /@media \(hover: hover\)/.test(line);
      if (line.includes(":hover") && !open.some(Boolean)) {
        naked.push(`${sheet}:${i + 1}: ${line.trim()}`);
      }
      for (let n = (line.match(/\{/g) ?? []).length; n > 0; n--) open.push(gate && n === 1);
      for (let n = (line.match(/\}/g) ?? []).length; n > 0; n--) open.pop();
    }
  }

  assert.deepEqual(
    naked,
    [],
    `a :hover rule is not inside @media (hover: hover), so it will stick on ` +
      `tap:\n  ${naked.join("\n  ")}`,
  );
});

test("map doors use the accent hover language", () => {
  const css = uncommented(readFileSync(join(ROOT, "app/globals.css"), "utf8"));
  const buttonRules = [...css.matchAll(/\.tr-btn:hover\s*\{([^}]*)\}/g)];

  assert.ok(buttonRules.length > 0, "the top-right doors need a hover state");
  for (const [, declarations] of buttonRules) {
    assert.match(declarations, /background:\s*var\(--accent\)/);
    assert.match(declarations, /color:\s*var\(--parchment\)/);
  }
  assert.match(css, /\.map-atlas-door:hover\s*\{[^}]*background:\s*var\(--accent\)/);
});

test("phone timelines stay integrated while wide Atlas chrome floats", () => {
  const earth = readFileSync(join(ROOT, "components/VoyageExperience.tsx"), "utf8");
  const space = readFileSync(join(ROOT, "components/SpaceVoyageExperience.tsx"), "utf8");
  const atlas = readFileSync(join(ROOT, "components/AtlasBrowser.tsx"), "utf8");
  const css = uncommented(readFileSync(join(ROOT, "app/globals.css"), "utf8"));

  for (const experience of [earth, space]) {
    assert.match(experience, /\{!isMobile\s*&&\s*\(/);
    assert.doesNotMatch(experience, /events\.length\s*>\s*0\s*&&\s*!isMobile/);
    assert.match(experience, /\.\.\.\(isMobile\s*\?\s*\[/);
    assert.match(experience, /key:\s*["']world["']/);
  }

  assert.match(atlas, /<DraggableWindow/);
  assert.doesNotMatch(atlas, /inset:\s*["']0 auto 0 0["']/);
  assert.match(css, /\.world-strip\s*\{[\s\S]*?z-index:\s*11/);
  assert.match(css, /\[data-layout="phone"\]\s+\.win\s*\{[\s\S]*?position:\s*fixed[\s\S]*?inset:\s*0/);
});

/* The press highlight is recoloured rather than removed, so it is a token, and
   a token every register must re-declare — ink at a tenth is invisible on a
   starfield. This is the rule that `--state-changes` broke by shipping at
   3.29:1 inside .space, one layer down. */
test("every register that re-declares the ink re-declares the press flash", () => {
  const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
  const missing: string[] = [];

  for (const m of uncommented(css).matchAll(/^(\.[a-z-]+|:root)\s*\{([\s\S]*?)^\}/gm)) {
    const [, selector, body] = m;
    if (!/--ink\s*:/.test(body)) continue;
    if (!/--tap-flash\s*:/.test(body)) missing.push(selector);
  }

  assert.deepEqual(
    missing,
    [],
    `these registers set their own ink and inherit someone else's press ` +
      `flash: ${missing.join(", ")}`,
  );
});

/* `vh` is the browser's promise about a bar that moves; the phone units are the
 * truth, and which one is right is a decision rather than a default:
 *
 *   dvh — must fit the screen AS IT IS NOW. Overlays, dropdowns, scroll panes.
 *   svh — must NOT move when the bar does. Section floors, padding, and images
 *         in the flow, where re-sizing mid-scroll is jitter the reader sees.
 *
 * The one that survived longest was `.win-body`, which had 60vh inside a min()
 * against 100dvh — so a retracting bar grew one term and left the other, and
 * which of the two was the real cap could change halfway through a scroll.
 */
test("no bare vh survives, where a phone unit was meant", () => {
  const bare: string[] = [];

  for (const sheet of STYLESHEETS) {
    const lines = uncommented(readFileSync(join(ROOT, sheet), "utf8")).split("\n");
    lines.forEach((line, i) => {
      /* Only a value: `60vh`. Not `60dvh`, and not the word inside prose,
         which is why the comments are blanked first — the rule this guard
         exists for is explained in a comment that quotes the old value. */
      for (const m of line.matchAll(/(?<![a-z])[0-9.]+vh\b/g)) {
        bare.push(`${sheet}:${i + 1}: ${m[0]} — ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    bare,
    [],
    `a bare vh is left; choose dvh (must fit now) or svh (must not ` +
      `move):\n  ${bare.join("\n  ")}`,
  );
});

/* The insets are worth nothing without the viewport that turns them on, and
   worse than nothing the other way round: `cover` alone runs the map's chrome
   under the notch and the home indicator. They travel together or not at all. */
test("the safe area is asked for and answered", () => {
  const layout = readFileSync(join(ROOT, "app/layout.tsx"), "utf8");
  const css = uncommented(readFileSync(join(ROOT, "app/globals.css"), "utf8"));

  const cover = /viewportFit:\s*["']cover["']/.test(layout);
  const uses = /var\(--safe-[trbl]\)/.test(css);

  assert.equal(
    cover,
    uses,
    cover
      ? "viewportFit is cover but nothing reads --safe-*: the chrome is now " +
        "under the notch."
      : "something reads --safe-* but the viewport never asks for the whole " +
        "screen, so env() resolves to zero and the insets do nothing.",
  );
  /* And the tokens themselves have to come from env(), not from a number
     somebody measured on their own handset. */
  assert.match(css, /--safe-b:\s*env\(safe-area-inset-bottom/);
});

/** Selectors declared inside each responsive block of the stylesheet. */
function blocksOf(source: string) {
  const lines = uncommented(source).split("\n");
  const found: { cond: string; line: number; selectors: string[] }[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith("@media")) continue;
    const cond = lines[i].trim().replace(/\s*\{\s*$/, "");
    if (!/(max|min)-width/.test(cond)) continue;

    let depth = 0;
    let j = i;
    do {
      depth += (lines[j].match(/\{/g) ?? []).length;
      depth -= (lines[j].match(/\}/g) ?? []).length;
      j++;
    } while (j < lines.length && depth > 0);

    /* Selectors may run over several lines, so accumulate until the brace. */
    const selectors: string[] = [];
    let buffer = "";
    for (const text of lines.slice(i + 1, j - 1)) {
      if (text.includes("{")) {
        buffer += text.slice(0, text.indexOf("{"));
        for (const one of buffer.split(",")) {
          const sel = one.trim();
          if (sel.startsWith(".") || sel.startsWith("#")) selectors.push(sel);
        }
        buffer = "";
      } else if (text.includes("}")) {
        buffer = "";
      } else {
        buffer += " " + text;
      }
    }
    found.push({ cond, line: i + 1, selectors });
    i = j - 1;
  }
  return found;
}

/* Frozen on the day the layout layer landed. Every entry is a selector whose
   arrangement is decided by which of two distant blocks comes last in the
   file. The migration to [data-layout] empties this; nothing may be added. */
const KNOWN_SPLIT: Record<string, number> = {
  ".autopause-toggle": 2,
  /* Down from four. `bottom: 150px !important` in the 680 block is gone: it
     was the only reason the derived stack's own rule needed a bang of its own,
     and both lost it together when the launcher was put on a named rung. */
  ".pig-launch": 3,
  ".transport-bar": 3,
  ".world-strip": 3,
  /* .win and .win-body are repaid: a panel is a page on a phone, declared
     once under [data-layout] beside the base rule instead of twice in two
     media blocks 1500 lines apart. */
};

test("no selector is newly split across responsive blocks", () => {
  const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
  const where = new Map<string, Set<number>>();

  for (const block of blocksOf(css)) {
    for (const sel of new Set(block.selectors)) {
      if (!where.has(sel)) where.set(sel, new Set());
      where.get(sel)!.add(block.line);
    }
  }

  const split: Record<string, number> = {};
  for (const [sel, lines] of where) if (lines.size > 1) split[sel] = lines.size;

  for (const [sel, count] of Object.entries(split)) {
    const allowed = KNOWN_SPLIT[sel];
    assert.ok(
      allowed !== undefined,
      `${sel} is now declared in ${count} responsive blocks. Put the compact ` +
        `arrangement beside the base rule under [data-layout="phone"] instead.`,
    );
    assert.ok(
      count <= allowed,
      `${sel} went from ${allowed} responsive blocks to ${count}.`,
    );
  }

  /* And when one is repaid, this list must be trimmed in the same commit —
     a stale debt list tells the next agent the sweep is done when it is not. */
  for (const [sel, allowed] of Object.entries(KNOWN_SPLIT)) {
    assert.equal(
      split[sel] ?? 0,
      allowed,
      `${sel} is down to ${split[sel] ?? 0} blocks — remove it from KNOWN_SPLIT.`,
    );
  }
});
