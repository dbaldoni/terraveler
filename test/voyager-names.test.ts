import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  VOYAGER_NAMES,
  VOYAGER_NAME_RE,
  resolveVoyagerName,
  sampleVoyagerNames,
} from "../lib/voyagerNames";

const read = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("the curated Voyager Name catalogue is bounded, slug-safe and culturally broad", () => {
  assert.ok(VOYAGER_NAMES.length >= 40 && VOYAGER_NAMES.length <= 60);
  const slugs = VOYAGER_NAMES.map((entry) => entry.slug);
  assert.equal(new Set(slugs.map((slug) => slug.toLowerCase())).size, slugs.length,
    "names must also be unique under the database's case-insensitive comparison");
  for (const entry of VOYAGER_NAMES) {
    assert.match(entry.slug, VOYAGER_NAME_RE);
    assert.ok(entry.label.length > 1);
    assert.ok(entry.region.length > 1);
  }
  assert.ok(new Set(VOYAGER_NAMES.map((entry) => entry.region)).size >= 6,
    "the catalogue should not collapse voyage history into one region");
});

test("selection is case-insensitive but only curated names resolve", () => {
  assert.equal(resolveVoyagerName("  ZHENG-HE ")?.slug, "zheng-he");
  assert.equal(resolveVoyagerName("a-valid-but-uncurated-slug"), null);
  assert.equal(resolveVoyagerName("unsafe name"), null);
  assert.equal(resolveVoyagerName(null), null);
});

test("public sampling is stable and never returns more than twelve names", () => {
  assert.deepEqual(sampleVoyagerNames("2026-09-10"), sampleVoyagerNames("2026-09-10"));
  assert.equal(sampleVoyagerNames("2026-09-10", 500).length, 12);
  assert.equal(sampleVoyagerNames("2026-09-10", 3).length, 3);
  assert.notDeepEqual(
    sampleVoyagerNames("2026-09-10").map((entry) => entry.slug),
    sampleVoyagerNames("2026-09-11").map((entry) => entry.slug),
  );
});

test("the VPS migration enforces slug shape and case-insensitive uniqueness", async () => {
  const migration = await read("../supabase/voyager_names.sql");
  assert.match(migration, /add column if not exists voyager_name text/);
  assert.match(migration, /check \(voyager_name is null or voyager_name ~ '\^\[a-z\]/);
  assert.match(migration, /create unique index if not exists agent_accounts_voyager_name_ci_key/);
  assert.match(migration, /lower\(voyager_name\)/);
  assert.match(migration, /PostgreSQL database on the Terraveler VPS/);
});

test("new client_credentials identities must choose a name while runtime binding preserves one", async () => {
  const registration = await read("../app/api/oauth/register/route.ts");
  assert.match(registration, /selfEnrollingAgent && !runtimeLinkToken && !requestedVoyagerName/);
  assert.match(registration, /resolveVoyagerName\(body\.voyager_name\)/);
  assert.match(registration, /voyagerName: requestedVoyagerName!\.slug/);
  assert.match(registration, /error: "voyager_name_taken"/);
  assert.match(registration, /status: 409/);
  assert.match(registration, /agent_id: agent\.public_id,[\s\S]*voyager_name: agent\.voyager_name/);
});

test("anonymous discovery is a bounded sample, not a queryable availability oracle", async () => {
  const route = await read("../app/api/voyager-names/route.ts");
  assert.match(route, /const SAMPLE_SIZE = 12/);
  assert.match(route, /export async function GET\(\)/,
    "the endpoint should accept no caller-selected name or search parameter");
  assert.equal(route.includes("export async function POST"), false);
  assert.match(route, /public, max-age=300, s-maxage=3600/);
});

test("capabilities and agent instructions keep callsign separate from durable identity", async () => {
  const capabilities = await read("../app/api/agent/capabilities/route.ts");
  const skill = await read("../public/skill.md");
  const connect = await read("../components/ConnectPanel.tsx");
  assert.match(capabilities, /agent_id: agent\.public_id,[\s\S]*voyager_name: agent\.voyager_name/);
  assert.match(skill, /does not replace the durable\s+`agent_id`/);
  assert.match(skill, /GET https:\/\/www\.terraveler\.com\/api\/voyager-names/);
  assert.match(connect, /"voyager_name":"tupaia"/);
});
