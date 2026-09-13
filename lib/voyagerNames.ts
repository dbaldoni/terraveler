/**
 * Curated callsigns for independently enrolled Terraveler agents.
 *
 * The slug is the public Voyager Name and is deliberately safe wherever a
 * compact identifier is needed. `label` and `region` keep the catalogue
 * human-readable and make its cultural breadth reviewable. Additions belong in
 * this one list; the assertions below prevent an extension from quietly
 * introducing an unsafe or case-insensitive duplicate slug.
 */
export type VoyagerName = {
  slug: string;
  label: string;
  region: string;
};

export const VOYAGER_NAMES: readonly VoyagerName[] = [
  { slug: "xuanzang", label: "Xuanzang", region: "East Asia" },
  { slug: "faxian", label: "Faxian", region: "East Asia" },
  { slug: "yi-jing", label: "Yijing", region: "East Asia" },
  { slug: "zheng-he", label: "Zheng He", region: "East Asia" },
  { slug: "xu-xiake", label: "Xu Xiake", region: "East Asia" },
  { slug: "choe-bu", label: "Choe Bu", region: "East Asia" },

  { slug: "nain-singh", label: "Nain Singh Rawat", region: "South and Central Asia" },
  { slug: "kishen-singh", label: "Kishen Singh Rawat", region: "South and Central Asia" },
  { slug: "kintup", label: "Kintup", region: "South and Central Asia" },
  { slug: "rahul-sankrityayan", label: "Rahul Sankrityayan", region: "South and Central Asia" },
  { slug: "atisa", label: "Atiśa", region: "South and Central Asia" },
  { slug: "pandita-ramabai", label: "Pandita Ramabai", region: "South and Central Asia" },

  { slug: "ibn-battuta", label: "Ibn Battuta", region: "West Asia and North Africa" },
  { slug: "ibn-jubayr", label: "Ibn Jubayr", region: "West Asia and North Africa" },
  { slug: "ibn-fadlan", label: "Ahmad ibn Fadlan", region: "West Asia and North Africa" },
  { slug: "nasir-khusraw", label: "Nasir Khusraw", region: "West Asia and North Africa" },
  { slug: "rabban-bar-sauma", label: "Rabban Bar Sauma", region: "West Asia and North Africa" },
  { slug: "al-masudi", label: "al-Masudi", region: "West Asia and North Africa" },
  { slug: "al-idrisi", label: "al-Idrisi", region: "West Asia and North Africa" },
  { slug: "leo-africanus", label: "Leo Africanus", region: "West Asia and North Africa" },

  { slug: "sidi-mubarak-bombay", label: "Sidi Mubarak Bombay", region: "Africa and the Indian Ocean" },
  { slug: "james-chuma", label: "James Chuma", region: "Africa and the Indian Ocean" },
  { slug: "abdullah-susi", label: "Abdullah Susi", region: "Africa and the Indian Ocean" },
  { slug: "jacob-wainwright", label: "Jacob Wainwright", region: "Africa and the Indian Ocean" },
  { slug: "salim-bin-abakari", label: "Salim bin Abakari", region: "Africa and the Indian Ocean" },
  { slug: "selim-aga", label: "Selim Aga", region: "Africa and the Indian Ocean" },

  { slug: "tupaia", label: "Tupaia", region: "Oceania" },
  { slug: "mai", label: "Mai", region: "Oceania" },
  { slug: "mau-piailug", label: "Mau Piailug", region: "Oceania" },
  { slug: "te-rangi-hiroa", label: "Te Rangi Hīroa", region: "Oceania" },
  { slug: "kupe", label: "Kupe", region: "Oceania" },
  { slug: "ui-te-rangiora", label: "Ui-te-Rangiora", region: "Oceania" },

  { slug: "sacagawea", label: "Sacagawea", region: "The Americas" },
  { slug: "matthew-henson", label: "Matthew Henson", region: "The Americas" },
  { slug: "moncacht-ape", label: "Moncacht-Apé", region: "The Americas" },
  { slug: "estevanico", label: "Estevanico", region: "The Americas" },
  { slug: "tisquantum", label: "Tisquantum", region: "The Americas" },
  { slug: "jean-baptiste-charbonneau", label: "Jean Baptiste Charbonneau", region: "The Americas" },
  { slug: "pedro-teixeira", label: "Pedro Teixeira", region: "The Americas" },
  { slug: "alexander-mackenzie", label: "Alexander Mackenzie", region: "The Americas" },

  { slug: "pytheas", label: "Pytheas", region: "Europe and the Mediterranean" },
  { slug: "egeria", label: "Egeria", region: "Europe and the Mediterranean" },
  { slug: "marco-polo", label: "Marco Polo", region: "Europe and the Mediterranean" },
  { slug: "benjamin-tudela", label: "Benjamin of Tudela", region: "Europe and the Mediterranean" },
  { slug: "jeanne-baret", label: "Jeanne Baret", region: "Europe and the Mediterranean" },
  { slug: "ida-pfeiffer", label: "Ida Pfeiffer", region: "Europe and the Mediterranean" },
  { slug: "isabella-bird", label: "Isabella Bird", region: "Europe and the Mediterranean" },
  { slug: "nellie-bly", label: "Nellie Bly", region: "Europe and the Mediterranean" },
] as const;

export const VOYAGER_NAME_RE = /^[a-z][a-z0-9-]{2,31}$/;

const bySlug = new Map<string, VoyagerName>();
for (const entry of VOYAGER_NAMES) {
  const key = entry.slug.toLowerCase();
  if (!VOYAGER_NAME_RE.test(entry.slug))
    throw new Error(`unsafe Voyager Name in catalogue: ${entry.slug}`);
  if (bySlug.has(key))
    throw new Error(`duplicate Voyager Name in catalogue: ${entry.slug}`);
  bySlug.set(key, entry);
}

/** Input is case-insensitive; stored and returned names are canonical slugs. */
export function resolveVoyagerName(value: unknown): VoyagerName | null {
  if (typeof value !== "string") return null;
  const canonical = value.trim().toLowerCase();
  if (!VOYAGER_NAME_RE.test(canonical)) return null;
  return bySlug.get(canonical) ?? null;
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable pseudo-random order: useful for bounded samples without an oracle. */
export function orderedVoyagerNames(seed: string): VoyagerName[] {
  return [...VOYAGER_NAMES].sort((a, b) =>
    hash(`${seed}:${a.slug}`) - hash(`${seed}:${b.slug}`) || a.slug.localeCompare(b.slug));
}

export function sampleVoyagerNames(seed: string, limit = 12): VoyagerName[] {
  const bounded = Math.max(1, Math.min(12, Math.trunc(limit) || 12));
  return orderedVoyagerNames(seed).slice(0, bounded);
}
