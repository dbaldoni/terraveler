import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { rpc, sb } from "@/lib/deskAuth";
import { VoyagerNameTakenError, createAgentAccount, getAgentAccount } from "@/lib/agentIdentity";
import { sha256 } from "@/lib/oauth";
import { CARTA_VERSION } from "@/lib/carta";
import { availableVoyagerNames } from "@/lib/voyagerNameAvailability";
import { resolveVoyagerName } from "@/lib/voyagerNames";
import {
  ENROLLMENT_BODY_LIMIT, NO_STORE_HEADERS, enforceLimits, enrollmentGuardReason,
  externalAgentEnrollmentEnabled, readLimitedJson, requestSource, securityAudit,
} from "@/lib/externalBetaSecurity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PER_SOURCE_PER_HOUR = 10;
const GLOBAL_PER_HOUR = 2000;

function badRequest(error: string, description: string) {
  return NextResponse.json({ error, error_description: description }, { status: 400, headers: NO_STORE_HEADERS });
}

async function nameTaken(voyagerName: string) {
  const suggestions = await availableVoyagerNames(`taken:${voyagerName}`, 5);
  return NextResponse.json({
    error: "voyager_name_taken",
    error_description:
      `Voyager Name '${voyagerName}' has already been claimed. Choose one of the suggested names or request another public sample.`,
    voyager_name: voyagerName,
    suggestions: suggestions.map((entry) => entry.slug),
    catalogue: "https://www.terraveler.com/api/voyager-names",
  }, { status: 409, headers: NO_STORE_HEADERS });
}

export async function POST(req: Request) {
  const request = requestSource(req);
  const parsedBody = await readLimitedJson(req, ENROLLMENT_BODY_LIMIT);
  if (!parsedBody.ok)
    return NextResponse.json({ error: "invalid_client_metadata", error_description: parsedBody.error },
      { status: parsedBody.status, headers: NO_STORE_HEADERS });
  const body = parsedBody.value;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return badRequest("invalid_client_metadata", "body must be a JSON object");

  if (!externalAgentEnrollmentEnabled()) {
    const reason = enrollmentGuardReason() ?? "external enrollment guard unavailable";
    await securityAudit({ source: request, action: "oauth-register", outcome: "rejected", status: 503, reason });
    return NextResponse.json({ error: "temporarily_unavailable",
      error_description: "Autonomous enrollment is currently disabled; public MCP reading remains available." },
      { status: 503, headers: { ...NO_STORE_HEADERS, "Retry-After": "300" } });
  }

  const wantsCC = Array.isArray(body.grant_types)
    && body.grant_types.map(String).includes("client_credentials");
  const uris: unknown = body.redirect_uris ?? (wantsCC ? [] : undefined);
  if (!Array.isArray(uris) || (!uris.length && !wantsCC))
    return badRequest("invalid_redirect_uri", "redirect_uris is required and must be a non-empty array");

  const clean: string[] = [];
  for (const u of uris) {
    let parsed: URL;
    try {
      parsed = new URL(String(u));
    } catch {
      return badRequest("invalid_redirect_uri", `not a URL: ${String(u).slice(0, 120)}`);
    }
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (parsed.protocol !== "https:" && !loopback && !parsed.protocol.includes("."))
      return badRequest("invalid_redirect_uri",
        `${parsed.protocol}//… is neither https nor a loopback nor an app scheme`);
    if (parsed.hash)
      return badRequest("invalid_redirect_uri", "a redirect URI may not carry a fragment");
    clean.push(parsed.toString());
  }

  const admission = await enforceLimits("oauth-register", 3600, [
    { dimension: "ip", subject: request.sourceHash, limit: PER_SOURCE_PER_HOUR },
    { dimension: "network", subject: request.networkHash, limit: 40 },
    { dimension: "global", subject: "all", limit: GLOBAL_PER_HOUR },
  ]);
  if (!admission.allowed) {
    await securityAudit({ source: request, action: "oauth-register", outcome: "rejected", status: 429,
      reason: `rate limit exceeded for ${admission.dimension}` });
    return NextResponse.json({ error: "temporarily_unavailable",
      error_description: "Registration rate limit exceeded. Retry after the indicated delay." },
      { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(admission.retryAfter) } });
  }

  const grants: string[] = Array.isArray(body.grant_types)
    ? body.grant_types.map(String)
    : ["authorization_code", "refresh_token"];
  const selfEnrollingAgent = grants.includes("client_credentials");
  const runtimeLinkToken = typeof body.agent_link_token === "string"
    ? body.agent_link_token.trim()
    : "";
  if (runtimeLinkToken && !selfEnrollingAgent)
    return badRequest("invalid_agent_link", "agent_link_token is only valid for a client_credentials runtime");

  const requestedVoyagerName = resolveVoyagerName(body.voyager_name);
  if (selfEnrollingAgent && !runtimeLinkToken && !requestedVoyagerName) {
    return badRequest(
      "invalid_voyager_name",
      "A new self-enrolled agent must choose a voyager_name from the curated catalogue. " +
        "Fetch a limited public sample at https://www.terraveler.com/api/voyager-names.",
    );
  }

  const client_id = `tv_${randomBytes(16).toString("hex")}`;
  const client_secret = selfEnrollingAgent ? randomBytes(32).toString("base64url") : null;
  const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 120) : null;
  const agentName = typeof body.agent_name === "string" ? body.agent_name.slice(0, 120) : clientName;
  const operator = typeof body.operator === "string" ? body.operator.slice(0, 200) : null;

  let agent: Awaited<ReturnType<typeof createAgentAccount>> | null = null;
  let createdAgent = false;
  let reboundExistingAgent = false;

  if (selfEnrollingAgent && runtimeLinkToken) {
    const claimed = await rpc("claim_agent_link_token", {
      p_token_hash: sha256(runtimeLinkToken),
      p_purpose: "runtime-binding",
    });
    const agentAccountId = claimed?.[0]?.agent_account_id;
    if (!agentAccountId)
      return badRequest("invalid_agent_link", "this runtime-binding token is unknown, expired, already used or for another purpose");
    agent = await getAgentAccount(Number(agentAccountId));
    if (!agent || agent.status !== "active" || agent.contributor_status !== "active")
      return badRequest("invalid_agent_link", "the agent identity behind this token is not active");
    reboundExistingAgent = true;
  } else if (selfEnrollingAgent) {
    try {
      agent = await createAgentAccount({
        voyagerName: requestedVoyagerName!.slug,
        displayName: agentName || requestedVoyagerName!.label,
        operator,
        enrollment: "self",
      });
    } catch (error) {
      if (error instanceof VoyagerNameTakenError) {
        await securityAudit({ source: request, action: "oauth-register", outcome: "rejected", status: 409,
          reason: "voyager name taken" });
        return nameTaken(error.voyagerName);
      }
      throw error;
    }
    createdAgent = true;
  }

  try {
    await sb("POST", "oauth_clients", {
      client_id,
      client_name: clientName,
      redirect_uris: clean,
      registered_via: selfEnrollingAgent ? "client_credentials" : "dcr",
      source_hash: request.sourceHash,
      client_secret_hash: client_secret ? sha256(client_secret) : null,
      operator,
      carta_version: CARTA_VERSION,
      agent_account_id: agent?.id ?? null,
    });
  } catch (error) {
    if (createdAgent && agent) {
      await sb("DELETE", `agent_accounts?id=eq.${agent.id}`).catch(() => {});
      await sb("DELETE", `contributors?id=eq.${agent.contributor_id}`).catch(() => {});
    }
    throw error;
  }

  await securityAudit({ source: request, action: "oauth-register", outcome: "accepted", status: 201,
    agentId: agent?.public_id, agentAccountId: agent?.id, clientId: client_id });

  return NextResponse.json(
    {
      client_id,
      client_name: body.client_name ?? undefined,
      redirect_uris: clean,
      ...(client_secret && agent
        ? {
            agent_id: agent.public_id,
            voyager_name: agent.voyager_name,
            handle: agent.handle,
            client_secret,
            token_endpoint_auth_method: "client_secret_post",
            grant_types: ["client_credentials"],
            identity_binding: reboundExistingAgent ? "existing-agent" : "new-agent",
            note: reboundExistingAgent
              ? "This new runtime is bound to the existing Terraveler agent. Its identity and standing were preserved; only the runtime credential is new."
              : "This registration created an independent Terraveler agent identity. Keep agent_id as the durable identity and client_secret as the software credential; the credential may rotate and the model/runtime may change without changing the agent or its standing.",
          }
        : {
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            note:
              "This registered an OAuth client only. If a signed-in human authorises it, Terraveler will create or associate a separate agent identity; the human account does not become that agent.",
          }),
      carta_version: CARTA_VERSION,
      carta: "https://www.terraveler.com/magna-carta",
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    { status: 201, headers: NO_STORE_HEADERS },
  );
}
