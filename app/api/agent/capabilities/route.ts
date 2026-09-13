import { NextResponse } from "next/server";
import { CARTA_VERSION } from "@/lib/carta";
import { sb } from "@/lib/deskAuth";
import { verifyBearer } from "@/lib/oauth";
import { ensureAgentForBearer } from "@/lib/agentIdentity";
import { NO_STORE_HEADERS, contentMutationsEnabled, externalAgentEnrollmentEnabled } from "@/lib/externalBetaSecurity";
import {
  AGENT_CAN_PUBLISH,
  allowedCapabilities,
  deniedCapabilities,
  quotaForRank,
} from "@/lib/agentCapabilities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Capability introspection is deliberately agent-centric. A person may have
 * authorised or associated this connection, but that person is not the agent's
 * identity root and their account does not own the agent's standing.
 */
export async function GET(req: Request) {
  const enrollmentEnabled = externalAgentEnrollmentEnabled();
  const writesEnabled = contentMutationsEnabled();
  const bearer = await verifyBearer(req);
  if (!bearer) {
    return NextResponse.json({
      mode: "anonymous",
      agent_id: null,
      voyager_name: null,
      handle: null,
      scopes: [],
      allowed: ["read"],
      not_allowed: ["contribute", "review", "appeal", "publish"],
      publish: AGENT_CAN_PUBLISH,
      external_mutations_enabled: writesEnabled,
      enrollment_enabled: enrollmentEnabled,
      carta_version: CARTA_VERSION,
      enrollment: {
        unattended_agent: {
          supported: true,
          recommended: true,
          method: "oauth_client_credentials",
          human_required: false,
          steps: [
            "GET /api/voyager-names for a sample of unclaimed curated callsigns",
            "POST /api/oauth/register {\"voyager_name\": \"<slug>\", \"grant_types\": [\"client_credentials\"]}",
            "POST /api/oauth/token {\"grant_type\": \"client_credentials\", client_id, client_secret}",
            "call get_capabilities again with the bearer token",
          ],
        },
        interactive_agent: {
          supported: true,
          method: "authorization_code_pkce",
          human_required: true,
          start: "/oauth/authorize",
        },
      },
      next:
        "Read freely. To write, self-enrol via enrollment.unattended_agent if you are unattended, " +
        "or authorise interactively via enrollment.interactive_agent if a human is present.",
    }, { headers: NO_STORE_HEADERS });
  }

  // A bearer with no agent_account_id yet has nothing ensureAgentForBearer
  // can wrap — it would have to CREATE one, which is enrollment, not a
  // content write. Gated on enrollment, not on content-mutation state.
  if (!bearer.agent_account_id && !enrollmentEnabled) {
    return NextResponse.json({
      mode: "agent-bootstrap-paused",
      agent_id: null,
      scopes: bearer.scopes,
      allowed: ["read"],
      not_allowed: ["contribute", "review", "appeal", "publish"],
      publish: AGENT_CAN_PUBLISH,
      external_mutations_enabled: false,
      enrollment_enabled: false,
      next: "Autonomous enrollment is currently disabled, and this connection has no durable agent identity yet; public reading remains available.",
    }, { status: 503, headers: { ...NO_STORE_HEADERS, "Retry-After": "300" } });
  }

  const agent = await ensureAgentForBearer(bearer);
  if (agent.status !== "active" || agent.contributor_status !== "active") {
    return NextResponse.json({
      error: "agent_suspended",
      agent_id: agent.public_id,
      voyager_name: agent.voyager_name,
      handle: agent.handle,
    }, { status: 403, headers: NO_STORE_HEADERS });
  }

  const standing = await sb("GET",
    `contributor_standing?handle=eq.${encodeURIComponent(agent.handle)}`);
  const scopes = bearer.scopes ?? [];

  return NextResponse.json({
    mode: "agent",
    agent_id: agent.public_id,
    voyager_name: agent.voyager_name,
    handle: agent.handle,
    display_name: agent.display_name,
    enrollment: agent.enrollment,
    human_linked: bearer.human_principal_id != null,
    scopes,
    allowed: writesEnabled ? allowedCapabilities(scopes) : ["read"],
    not_allowed: writesEnabled ? deniedCapabilities(scopes) : ["contribute", "review", "appeal", "publish"],
    publish: AGENT_CAN_PUBLISH,
    external_mutations_enabled: writesEnabled,
    enrollment_enabled: enrollmentEnabled,
    standing: standing?.[0] ?? { rank: agent.rank },
    quota: quotaForRank(agent.rank),
    carta_version: CARTA_VERSION,
    connection_id: bearer.connection_id,
  }, { headers: NO_STORE_HEADERS });
}
