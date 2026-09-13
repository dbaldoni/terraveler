import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isPublicIp } from "../lib/cimd";
import { domainOk } from "../lib/gate";
import {
  contentMutationsEnabled, externalAgentEnrollmentEnabled, readLimitedJson,
} from "../lib/externalBetaSecurity";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prior[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const read = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("CIMD rejects private, link-local and IPv4-mapped loopback addresses", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fe80::1", "::ffff:7f00:1"])
    assert.equal(isPublicIp(ip), false, ip);
  assert.equal(isPublicIp("1.1.1.1"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});

test("agent citation URLs require an allowed scheme, host and safe port", () => {
  assert.equal(domainOk("https://www.gutenberg.org/ebooks/1"), true);
  assert.equal(domainOk("javascript:alert(1)"), false);
  assert.equal(domainOk("https://user:pass@gutenberg.org/book"), false);
  assert.equal(domainOk("https://gutenberg.org:8443/book"), false);
  assert.equal(domainOk("https://gutenberg.org.evil.example/book"), false);
});

test("body limit checks actual streamed bytes even without Content-Length", async () => {
  const tooLarge = new Request("https://example.test", {
    method: "POST", body: JSON.stringify({ value: "é".repeat(20) }),
    headers: { "content-type": "application/json" },
  });
  const result = await readLimitedJson(tooLarge, 32);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 413);
});

test("enrollment and content-mutation gates both fail closed absent their own env var", () => {
  withEnv({ MCP_EXTERNAL_ENROLLMENT_ENABLED: undefined, MCP_EXTERNAL_CONTENT_MUTATIONS_ENABLED: undefined,
    MCP_SECURITY_PEPPER: "x".repeat(32) }, () => {
    assert.equal(externalAgentEnrollmentEnabled(), false);
    assert.equal(contentMutationsEnabled(), false);
  });
});

test("both gates fail closed without a dedicated pepper, even when their own switch is on", () => {
  withEnv({ MCP_EXTERNAL_ENROLLMENT_ENABLED: "true", MCP_EXTERNAL_CONTENT_MUTATIONS_ENABLED: "true",
    MCP_SECURITY_PEPPER: undefined }, () => {
    assert.equal(externalAgentEnrollmentEnabled(), false, "missing pepper must keep enrollment disabled");
    assert.equal(contentMutationsEnabled(), false, "missing pepper must keep content mutations disabled");
  });
});

test("enrollment can be enabled independently of content mutations, and vice versa", () => {
  withEnv({ MCP_EXTERNAL_ENROLLMENT_ENABLED: "true", MCP_EXTERNAL_CONTENT_MUTATIONS_ENABLED: undefined,
    MCP_SECURITY_PEPPER: "x".repeat(32) }, () => {
    assert.equal(externalAgentEnrollmentEnabled(), true, "STATE B: enrollment on, content off");
    assert.equal(contentMutationsEnabled(), false);
  });
  withEnv({ MCP_EXTERNAL_ENROLLMENT_ENABLED: undefined, MCP_EXTERNAL_CONTENT_MUTATIONS_ENABLED: "true",
    MCP_SECURITY_PEPPER: "x".repeat(32) }, () => {
    assert.equal(externalAgentEnrollmentEnabled(), false, "one switch enabling the other would defeat the split");
    assert.equal(contentMutationsEnabled(), true);
  });
  withEnv({ MCP_EXTERNAL_ENROLLMENT_ENABLED: "true", MCP_EXTERNAL_CONTENT_MUTATIONS_ENABLED: "true",
    MCP_SECURITY_PEPPER: "x".repeat(32) }, () => {
    assert.equal(externalAgentEnrollmentEnabled(), true, "STATE C: both on");
    assert.equal(contentMutationsEnabled(), true);
  });
});

test("the gate split is not one env var behind two names", async () => {
  const security = await read("../lib/externalBetaSecurity.ts");
  assert.match(security, /MCP_EXTERNAL_ENROLLMENT_ENABLED/);
  assert.match(security, /MCP_EXTERNAL_CONTENT_MUTATIONS_ENABLED/);
  assert.equal(security.includes("process.env.MCP_EXTERNAL_MUTATIONS_ENABLED"), false,
    "the retired single switch must not linger as a silent alias for either gate — mentioning it in prose explaining the migration is fine");
});

test("token issuance for an already-registered client is not gated by enrollment or content state", async () => {
  const token = await read("../app/api/oauth/token/route.ts");
  const fnStart = token.indexOf("async function clientCredentials");
  const fnBody = token.slice(fnStart, token.indexOf("\nasync function POST"));
  // The gate must appear only inside the orphaned-client (no agent_account_id
  // yet) branch — never as an unconditional check at the top of the function
  // or in the POST dispatcher, or every routine re-auth would be blocked
  // whenever enrollment is closed.
  const dispatcher = token.slice(token.indexOf("export async function POST"));
  assert.equal(/externalAgentEnrollmentEnabled\(\)/.test(dispatcher.slice(0, dispatcher.indexOf("clientCredentials(p)"))), false,
    "the POST dispatcher must not gate client_credentials before calling clientCredentials()");
  assert.match(fnBody, /if \(!agentAccountId\) \{[\s\S]*?externalAgentEnrollmentEnabled\(\)/,
    "enrollment gate must be scoped to completing a missing agent identity, not the whole grant");
});

test("client_secret rotation requires the caller's own bearer and is not behind either gate", async () => {
  const rotate = await read("../app/api/oauth/rotate-secret/route.ts");
  assert.match(rotate, /verifyBearer\(req\)/, "rotation must be authorised by the caller's own live token, not by a client_id/secret pair");
  assert.equal(rotate.includes("externalAgentEnrollmentEnabled"), false,
    "rotating an already-issued credential is not enrollment — closing enrollment must not strand a leaked-secret agent");
  assert.equal(rotate.includes("contentMutationsEnabled"), false,
    "rotation touches no atlas content");
  assert.match(rotate, /client_secret_hash/, "must reject a client with no secret to rotate (interactive/PKCE clients)");
});

test("enrollment endpoints do not import the content-mutation gate, and vice versa", async () => {
  const register = await read("../app/api/oauth/register/route.ts");
  const linkToken = await read("../app/api/agent/link-token/route.ts");
  const write = await read("../app/api/agent/write/route.ts");
  assert.match(register, /externalAgentEnrollmentEnabled/);
  assert.equal(register.includes("contentMutationsEnabled"), false);
  assert.match(linkToken, /externalAgentEnrollmentEnabled/);
  assert.equal(linkToken.includes("contentMutationsEnabled"), false);
  assert.match(write, /contentMutationsEnabled/);
  assert.equal(write.includes("externalAgentEnrollmentEnabled"), false);
});

test("database hardening serializes first-use idempotency reservations", async () => {
  const migration = await read("../supabase/mcp_external_beta_hardening.sql");
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(/);
  assert.match(migration, /primary key \(agent_account_id, action, key_hash\)/);
  assert.match(migration, /agent_connections_autonomous_client_key/);
  assert.match(migration, /revoke all on mcp_security_rate_limits/);
});

test("security defaults, middleware and runbook are fail closed", async () => {
  const [security, env, runbook, middleware] = await Promise.all([
    read("../lib/externalBetaSecurity.ts"), read("../.env.example"),
    read("../docs/MCP_EXTERNAL_BETA_SECURITY.md"), read("../middleware.ts"),
  ]);
  const enabledChecks = security.match(/return enabled && securityPepperReady\(\);/g) ?? [];
  assert.equal(enabledChecks.length, 2, "both externalAgentEnrollmentEnabled and contentMutationsEnabled must fail closed");
  assert.match(env, /MCP_EXTERNAL_ENROLLMENT_ENABLED=false/);
  assert.match(env, /MCP_EXTERNAL_CONTENT_MUTATIONS_ENABLED=false/);
  assert.match(env, /MCP_LEGACY_MUTATIONS_ENABLED=false/);
  assert.match(middleware, /LEGACY_MUTATIONS/);
  assert.match(middleware, /MCP_LEGACY_MUTATIONS_ENABLED/);
  assert.match(middleware, /MCP_EXTERNAL_CONTENT_MUTATIONS_ENABLED/,
    "the legacy write lane is content, and must ride on the content gate, not enrollment");
  assert.match(runbook, /MCP_EXTERNAL_ENROLLMENT_ENABLED=false/);
  assert.match(runbook, /MCP_EXTERNAL_CONTENT_MUTATIONS_ENABLED=false/);
});

test("modern agent writes require DB guards and carry replay/concurrency controls", async () => {
  const writer = await read("../app/api/agent/write/route.ts");
  assert.match(writer, /MCP_EXTERNAL_BETA_REQUIRE_DB_GUARDS/);
  assert.match(writer, /beginIdempotent/);
  assert.match(writer, /acquireMutationLease/);
  assert.match(writer, /securityAudit/);
  assert.match(writer, /case "appeal"/);
});

test("standing quota admission is serialized per durable contributor", async () => {
  const sql = await read("../supabase/mcp_oauth_write_functions.sql");
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('mcp-author:' \|\| a\.id/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('mcp-claim:' \|\| a\.id/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('mcp-review:' \|\| a\.id/);
});

test("the unattended Curator bounds and revalidates agent-supplied source URLs", async () => {
  const curator = await read("../scripts/curator.py");
  assert.match(curator, /MAX_FETCH_BYTES = 30 \* 1024 \* 1024/);
  assert.match(curator, /parsed\.scheme not in \{"http", "https"\}/);
  assert.match(curator, /address\.is_global/);
  assert.match(curator, /class _SafeRedirectHandler/);
  assert.match(curator, /r\.read\(MAX_FETCH_BYTES \+ 1\)/);
  assert.match(curator, /_assert_public_source\(r\.geturl\(\)\)/);
});
