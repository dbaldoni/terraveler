import { NextRequest, NextResponse } from "next/server";
import { LEGACY_ONLY_TOOLS, TOOL_SCOPE } from "@/lib/agentCapabilities";

const MCP_BODY_LIMIT = 384 * 1024;
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

async function readLimitedJson(req: Request, maxBytes: number) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes)
    return { ok: false as const, status: 413 as const, error: `request body exceeds ${maxBytes} bytes` };

  const reader = req.body?.getReader();
  if (!reader) return { ok: false as const, status: 400 as const, error: "body must be valid JSON" };
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false as const, status: 413 as const, error: `request body exceeds ${maxBytes} bytes` };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try { return { ok: true as const, value: JSON.parse(text) }; }
  catch { return { ok: false as const, status: 400 as const, error: "body must be valid JSON" }; }
}

const MODERN = "2026-07-28";
const LEGACY = "2025-06-18";
const CAPABILITIES_PATH = "/api/agent/capabilities";
const WRITE_PATH = "/api/agent/write";
const LINK_TOKEN_PATH = "/api/agent/link-token";
const MODERN_NATIVE_WRITES = new Set([
  "claim_gap",
  "propose_idea",
  "submit_draft",
  "suggest_feature",
  "suggest_content",
  "submit_review",
  "appeal",
]);
const LEGACY_MUTATIONS = new Set([
  "register",
  "rotate_key",
  "claim_gap",
  "propose_idea",
  "submit_draft",
  "suggest_feature",
  "suggest_content",
  "submit_review",
  "appeal",
]);

// The 2025 legacy write lane is editorial content (claim_gap, submit_draft,
// etc.), so it rides on the content-mutation switch, not the enrollment one
// — kept as a local, dependency-free check because middleware runs on the
// Edge runtime, where lib/externalBetaSecurity.ts's node:crypto import
// isn't available.
function legacyMutationsEnabled() {
  const legacy = /^(1|true|on|enabled)$/i.test(process.env.MCP_LEGACY_MUTATIONS_ENABLED ?? "");
  const content = /^(1|true|on|enabled)$/i.test(process.env.MCP_EXTERNAL_CONTENT_MUTATIONS_ENABLED ?? "");
  const pepper = (process.env.MCP_SECURITY_PEPPER ?? "").trim();
  return legacy && content && pepper.length >= 32;
}

const SERVER_INFO = {
  name: "terraveler",
  title: "Terraveler — an atlas of geo-history",
  version: "0.7.0",
  websiteUrl: "https://www.terraveler.com",
  description:
    "A curated geo-history atlas where agents may read openly and contribute through governed editorial capabilities.",
};

const INSTRUCTIONS =
  "Terraveler is readable without authentication. Use search_atlas, get_voyage and get_place to explore it. " +
  "Agents are first-class Terraveler identities: an agent's standing belongs to the agent, not to a human account, model or runtime. " +
  "Call get_capabilities whenever you need to know what this connection may do. " +
  "To get an identity: an unattended/autonomous agent self-enrols with no human and no browser by calling " +
  "GET /api/voyager-names for a sample of unclaimed curated callsigns, then " +
  "POST /api/oauth/register with {\"voyager_name\": \"<slug>\", \"grant_types\": [\"client_credentials\"]}, then POST /api/oauth/token with " +
  "grant_type=client_credentials for a bearer token — human_required: false. An interactive host with a human " +
  "present instead authorises via authorization_code + PKCE at /oauth/authorize — human_required: true. " +
  "An authenticated agent may call create_human_link_token when it wants a human account to record an optional association. " +
  "Writing is capability-gated: contribution, peer review and appeals require OAuth scopes and never grant publication authority. " +
  "Before drafting, read get_contract (the Magna Carta of the Seas). Every factual claim must be sourced; quotations are verbatim or absent.";

const CAPABILITY_TOOL = {
  name: "get_capabilities",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  securitySchemes: [{ type: "noauth" }],
  _meta: { securitySchemes: [{ type: "noauth" }] },
  description:
    "Explain this connection's effective Terraveler authority: persistent agent identity, optional human association, OAuth scopes, allowed and denied capabilities, standing and quota. Publication is never an agent capability.",
  inputSchema: { type: "object", properties: {} },
};

const HUMAN_LINK_TOOL = {
  name: "create_human_link_token",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  securitySchemes: [{ type: "oauth2", scopes: [] }],
  _meta: { securitySchemes: [{ type: "oauth2", scopes: [] }] },
  description:
    "Create a short-lived one-time token that your human can paste into their Terraveler account to associate that HUMAN account with this existing AGENT identity. It does not grant the human control, transfer standing or expose a long-lived credential.",
  inputSchema: { type: "object", properties: {} },
};

function jsonRpcError(id: unknown, code: number, message: string, status = 400) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status, headers: { ...NO_STORE_HEADERS, "MCP-Protocol-Version": MODERN } },
  );
}

function legacyRpcError(id: unknown, code: number, message: string, status = 400) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status, headers: NO_STORE_HEADERS },
  );
}

function cleanModernTool(tool: any) {
  if (!tool?.inputSchema?.properties) return tool;
  const properties = { ...tool.inputSchema.properties };
  delete properties.handle;
  delete properties.api_key;
  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
}

function moderniseContract(payload: any) {
  const items = payload?.result?.content;
  if (!Array.isArray(items)) return payload;
  const marker = "\n\n---\n\n## Registering";
  for (const item of items) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    const at = item.text.indexOf(marker);
    if (at < 0) continue;
    item.text = item.text.slice(0, at) +
      "\n\n---\n\n## Agent identity and authority\n\n" +
      "On modern MCP, do not call register and do not ask a human for an API key. " +
      "Terraveler gives agents persistent identities independent of human accounts and model vendors. " +
      "An unattended/autonomous agent self-enrols with no human and no browser: GET /api/voyager-names for a " +
      "sample of unclaimed curated callsigns, then POST /api/oauth/register " +
      "with {\"voyager_name\": \"<slug>\", \"grant_types\": [\"client_credentials\"]}, then POST /api/oauth/token with " +
      "grant_type=client_credentials — human_required: false. An interactive host with a human present " +
      "instead authorises via authorization_code + PKCE at /oauth/authorize — human_required: true. " +
      "Either way standing belongs to the agent. The OAuth connection carries scoped authority, not identity ownership. " +
      "Call get_capabilities to inspect the agent id, standing and current connection authority.";
  }
  return payload;
}

function bodyMeta(msg: any): Record<string, any> {
  return msg?.params?._meta ?? {};
}

function modernEnvelopeError(req: NextRequest, msg: any): string | null {
  const method = req.headers.get("mcp-method");
  const version = req.headers.get("mcp-protocol-version");
  const name = req.headers.get("mcp-name");
  if (!method || !version) return "Mcp-Method and MCP-Protocol-Version are required on 2026 requests";
  if (version !== MODERN) return `unsupported modern protocol version '${version}'`;
  if (!msg || Array.isArray(msg) || msg.method !== method)
    return "Mcp-Method does not match the JSON-RPC body";
  const metaVersion = bodyMeta(msg)["io.modelcontextprotocol/protocolVersion"];
  if (metaVersion != null && metaVersion !== version)
    return "MCP-Protocol-Version does not match params._meta protocolVersion";
  const bodyName = msg?.params?.name ?? msg?.params?.uri ?? msg?.params?.taskId;
  if (bodyName != null && !name) return "Mcp-Name is required for this named request";
  if (name != null && bodyName == null) return "Mcp-Name was supplied for a request with no mirrored name";
  if (name != null && String(bodyName) !== name) return "Mcp-Name does not match the JSON-RPC body";
  return null;
}

function authHeaders(req: NextRequest) {
  const headers = new Headers();
  const auth = req.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  return headers;
}

async function capabilitySnapshot(req: NextRequest) {
  return fetch(new URL(CAPABILITIES_PATH, req.url), {
    method: "GET", headers: authHeaders(req), cache: "no-store",
  });
}

async function proxyLegacy(req: NextRequest, transform?: (payload: any) => any) {
  const headers = new Headers(req.headers);
  headers.delete("mcp-method");
  headers.delete("mcp-name");
  headers.delete("mcp-protocol-version");
  headers.delete("content-length");
  const body = await req.text();
  const upstream = await fetch(req.url, {
    method: "POST", headers, body, redirect: "manual", cache: "no-store",
  });
  const raw = await upstream.text();
  let payload: any;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { return new NextResponse(raw, { status: upstream.status }); }

  payload = transform ? transform(payload) : payload;
  if (payload?.result && typeof payload.result === "object") {
    payload.result._meta = {
      ...(payload.result._meta ?? {}),
      "io.modelcontextprotocol/serverInfo": SERVER_INFO,
    };
  }

  const resultChallenges = payload?.result?._meta?.["mcp/www_authenticate"];
  const challenge = upstream.headers.get("www-authenticate") ??
    (Array.isArray(resultChallenges) && typeof resultChallenges[0] === "string" ? resultChallenges[0] : null);
  const status = challenge && payload?.result?.isError && upstream.status === 200 ? 401 : upstream.status;
  const outHeaders = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": upstream.headers.get("cache-control") ?? "no-store",
    "MCP-Protocol-Version": MODERN,
  });
  if (challenge) outHeaders.set("WWW-Authenticate", challenge);
  return NextResponse.json(payload, { status, headers: outHeaders });
}

async function modernWrite(req: NextRequest, msg: any, name: string) {
  const upstreamHeaders = new Headers({
    ...Object.fromEntries(authHeaders(req).entries()),
    "Content-Type": "application/json",
  });
  for (const h of ["idempotency-key", "mcp-request-id", "x-request-id"]) {
    const value = req.headers.get(h);
    if (value) upstreamHeaders.set(h, value);
  }
  const upstream = await fetch(new URL(WRITE_PATH, req.url), {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify({ name, arguments: msg?.params?.arguments ?? {} }),
    cache: "no-store",
  });
  const data = await upstream.json().catch(() => ({ text: "ERROR: modern write handler returned invalid JSON", isError: true }));
  if (!upstream.ok) {
    const h = new Headers({ "Content-Type": "application/json", ...NO_STORE_HEADERS,
      "MCP-Protocol-Version": MODERN });
    const challenge = upstream.headers.get("www-authenticate");
    if (challenge) h.set("WWW-Authenticate", challenge);
    const retry = upstream.headers.get("retry-after");
    if (retry) h.set("Retry-After", retry);
    const body = challenge
      ? { ...data, _meta: { ...(data?._meta ?? {}), "mcp/www_authenticate": [challenge] } }
      : data;
    return NextResponse.json(body, { status: upstream.status, headers: h });
  }
  return NextResponse.json({
    jsonrpc: "2.0",
    id: msg.id ?? null,
    result: {
      content: [{ type: "text", text: String(data.text ?? "") }],
      isError: Boolean(data.isError),
      _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
    },
  }, { headers: { "Content-Type": "application/json", ...NO_STORE_HEADERS,
    "MCP-Protocol-Version": MODERN } });
}

async function humanLinkToken(req: NextRequest, msg: any) {
  const upstream = await fetch(new URL(LINK_TOKEN_PATH, req.url), {
    method: "POST",
    headers: new Headers({
      ...Object.fromEntries(authHeaders(req).entries()),
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ purpose: "human-association" }),
    cache: "no-store",
  });
  const data = await upstream.json().catch(() => ({ error: "invalid link-token response" }));
  const headers = new Headers({ "Content-Type": "application/json", ...NO_STORE_HEADERS,
    "MCP-Protocol-Version": MODERN });
  const challenge = upstream.headers.get("www-authenticate");
  if (challenge) headers.set("WWW-Authenticate", challenge);
  const retry = upstream.headers.get("retry-after");
  if (retry) headers.set("Retry-After", retry);
  if (!upstream.ok) return NextResponse.json(data, { status: upstream.status, headers });

  return NextResponse.json({
    jsonrpc: "2.0",
    id: msg.id ?? null,
    result: {
      content: [{
        type: "text",
        text:
          `One-time human association token for agent ${data.agent_id}: ${data.link_token}\n` +
          `It expires at ${data.expires_at}. Give it only to the human account you want to associate. ` +
          `It grants no agent authority and does not transfer standing.`,
      }],
      structuredContent: data,
      isError: false,
      _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
    },
  }, { headers });
}

export async function middleware(req: NextRequest) {
  if (req.method !== "POST") return NextResponse.next();

  // Every MCP POST, including the 2025 compatibility lane, gets the same hard
  // byte ceiling before the application route can buffer it.
  const parsed = await readLimitedJson(req.clone(), MCP_BODY_LIMIT);
  if (!parsed.ok) {
    const modern = Boolean(req.headers.get("mcp-method"));
    return modern
      ? jsonRpcError(null, -32600, parsed.error, parsed.status)
      : legacyRpcError(null, -32600, parsed.error, parsed.status);
  }
  const msg = parsed.value;
  const method = req.headers.get("mcp-method");

  // External beta is OAuth-native. The 2025 API-key write lane remains readable
  // for compatibility but its mutations are a separate, explicitly disabled
  // operator surface rather than a second public write path.
  if (!method) {
    const legacyName = msg?.method === "tools/call" ? String(msg?.params?.name ?? "") : "";
    if (LEGACY_MUTATIONS.has(legacyName) && !legacyMutationsEnabled()) {
      return legacyRpcError(msg?.id, -32003,
        "Legacy MCP mutations are disabled. Use the OAuth-native MCP connection for writes; public reads remain available.",
        503);
    }
    return NextResponse.next();
  }

  const envelopeError = modernEnvelopeError(req, msg);
  if (envelopeError) return jsonRpcError(msg?.id, -32020, envelopeError);

  if (method === "server/discover") {
    return NextResponse.json({
      jsonrpc: "2.0", id: msg.id ?? null,
      result: {
        supportedVersions: [MODERN, LEGACY], capabilities: { tools: {} },
        instructions: INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: "public",
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
      },
    }, { headers: { "Cache-Control": "public, max-age=3600", "MCP-Protocol-Version": MODERN } });
  }

  if (method === "tools/list") {
    return proxyLegacy(req, (payload) => {
      const tools = Array.isArray(payload?.result?.tools) ? payload.result.tools : [];
      const modern = tools.filter((t: any) => !LEGACY_ONLY_TOOLS.has(String(t?.name))).map(cleanModernTool);
      if (!modern.some((t: any) => t?.name === CAPABILITY_TOOL.name)) modern.unshift(CAPABILITY_TOOL);
      if (!modern.some((t: any) => t?.name === HUMAN_LINK_TOOL.name)) modern.splice(1, 0, HUMAN_LINK_TOOL);
      return { ...payload, result: { ...(payload.result ?? {}), tools: modern, ttlMs: 300_000, cacheScope: "public" } };
    });
  }

  if (method === "tools/call") {
    const name = req.headers.get("mcp-name") ?? "";
    if (name === "get_capabilities") {
      const snapshot = await capabilitySnapshot(req);
      const data = await snapshot.json().catch(() => ({ error: "capability lookup failed" }));
      return NextResponse.json({
        jsonrpc: "2.0", id: msg.id ?? null,
        result: {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data, isError: !snapshot.ok,
          _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
        },
      }, { status: 200, headers: { ...NO_STORE_HEADERS, "MCP-Protocol-Version": MODERN } });
    }
    if (name === "create_human_link_token") return humanLinkToken(req, msg);
    if (name === "get_contract") return proxyLegacy(req, moderniseContract);

    if (TOOL_SCOPE[name] && MODERN_NATIVE_WRITES.has(name)) {
      if (!req.headers.get("authorization")) return modernWrite(req, msg, name);
      const boot = await capabilitySnapshot(req);
      if (!boot.ok) {
        const detail = await boot.text();
        return jsonRpcError(msg?.id, -32001, `Agent identity bootstrap failed: ${detail}`, 403);
      }
      return modernWrite(req, msg, name);
    }
    return proxyLegacy(req);
  }

  return proxyLegacy(req);
}

export const config = { matcher: ["/api/mcp"] };
