import { NextResponse } from "next/server";
import { sb } from "@/lib/deskAuth";
import { secret, sha256, verifyBearer } from "@/lib/oauth";
import { NO_STORE_HEADERS, enforceLimits, requestSource, securityAudit } from "@/lib/externalBetaSecurity";

/**
 * A self-enrolled agent replacing its own client_secret.
 *
 * /api/oauth/revoke (RFC 7009) and /api/oauth/connections/revoke kill tokens,
 * but neither touches oauth_clients.client_secret_hash — a leaked secret stays
 * valid for minting fresh client_credentials tokens until someone rotates it.
 * This is the missing rotation: the caller proves it currently holds a live
 * connection, and every future token request must use the new secret. Already
 * -issued access tokens are untouched; they die on their own short TTL.
 *
 * Not enrollment (no new identity, no new agent_account) and not a content
 * mutation, so — like re-authenticating with client_credentials — it is not
 * behind either kill switch: closing enrollment must not strand an agent that
 * suspects its secret leaked.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const bearer = await verifyBearer(req);
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE_HEADERS });

  const source = requestSource(req);
  const admission = await enforceLimits("oauth-rotate-secret", 3600, [
    { dimension: "client", subject: bearer.client_id, limit: 5 },
  ]);
  if (!admission.allowed)
    return NextResponse.json({ error: "temporarily_unavailable", error_description: "Rotation rate limit exceeded." },
      { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(admission.retryAfter) } });

  const rows = await sb("GET",
    `oauth_clients?client_id=eq.${encodeURIComponent(bearer.client_id)}&select=client_id,client_secret_hash`);
  const client = rows?.[0];
  if (!client?.client_secret_hash)
    return NextResponse.json({
      error: "invalid_client",
      error_description: "this client has no client_secret to rotate — it authenticates via authorization_code + PKCE, not a shared secret.",
    }, { status: 400, headers: NO_STORE_HEADERS });

  const client_secret = secret();
  await sb("PATCH", `oauth_clients?client_id=eq.${encodeURIComponent(bearer.client_id)}`,
    { client_secret_hash: sha256(client_secret) });

  await securityAudit({
    source, action: "oauth-rotate-secret", outcome: "accepted", status: 200,
    agentId: bearer.agent_id, agentAccountId: bearer.agent_account_id, connectionId: bearer.connection_id,
    clientId: bearer.client_id,
  });

  return NextResponse.json({
    client_id: bearer.client_id,
    client_secret,
    note: "The previous client_secret no longer works for new client_credentials token requests. Tokens already issued keep working until they expire; the agent identity and standing are unchanged.",
  }, { status: 200, headers: NO_STORE_HEADERS });
}
