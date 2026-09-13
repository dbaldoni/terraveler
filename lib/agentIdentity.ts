import { randomBytes } from "node:crypto";
import { sb } from "@/lib/deskAuth";
import type { Bearer } from "@/lib/oauth";

export type AgentAccount = {
  id: number;
  public_id: string;
  contributor_id: number;
  voyager_name: string | null;
  display_name: string | null;
  operator: string | null;
  enrollment: "self" | "human-assisted" | "legacy-import";
  status: "active" | "suspended" | "retired";
};

export type AgentIdentity = AgentAccount & {
  handle: string;
  rank: string;
  contributor_status: string;
};

const publicId = () => `agent_${randomBytes(12).toString("hex")}`;
const handle = () => `scribe-${randomBytes(6).toString("hex")}`;

export class VoyagerNameTakenError extends Error {
  constructor(public readonly voyagerName: string) {
    super(`Voyager Name '${voyagerName}' is already claimed`);
    this.name = "VoyagerNameTakenError";
  }
}

function isVoyagerNameConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("agent_accounts_voyager_name_ci_key")
    || (/23505/.test(message) && /voyager_name/i.test(message));
}

async function readAgent(id: number): Promise<AgentAccount | null> {
  const rows = await sb("GET",
    `agent_accounts?id=eq.${id}&select=id,public_id,contributor_id,voyager_name,display_name,operator,enrollment,status`);
  return rows?.[0] ?? null;
}

async function hydrate(agent: AgentAccount): Promise<AgentIdentity> {
  const rows = await sb("GET",
    `contributors?id=eq.${agent.contributor_id}&select=id,handle,rank,status`);
  const contributor = rows?.[0];
  if (!contributor) throw new Error("agent contributor no longer exists");
  return {
    ...agent,
    handle: contributor.handle,
    rank: contributor.rank,
    contributor_status: contributor.status,
  };
}

/**
 * Create an agent identity and the contributor row that owns its standing.
 *
 * `human_sponsor` is always null here, on purpose: the flag Carta 10 asks an
 * agent to declare — a named human, or nothing but this Carta — is recorded
 * by `enrollment` and `humanPrincipalId`, not by a sentence typed into a
 * legacy free-text column. An autonomous agent gets a real absence, not a
 * fabricated "autonomous" string standing in for one.
 */
export async function createAgentAccount(opts: {
  displayName?: string | null;
  operator?: string | null;
  enrollment: AgentAccount["enrollment"];
  /** Caller-chosen handle (e.g. a human-picked name via the register tool).
   *  Omit to get a random `scribe-xxxxxx` handle. */
  handle?: string;
  humanPrincipalId?: number | null;
  /** A curated public callsign (see lib/voyagerNames.ts). Optional: only the
   *  modern self-enrolment flow requires one; every other caller omits it. */
  voyagerName?: string | null;
}): Promise<AgentIdentity> {
  if (opts.voyagerName) {
    const claimed = await sb("GET",
      `agent_accounts?voyager_name=ilike.${encodeURIComponent(opts.voyagerName)}` +
      `&select=id&limit=1`);
    if (claimed?.[0]) throw new VoyagerNameTakenError(opts.voyagerName);
  }

  let contributor: any = null;
  if (opts.handle) {
    contributor = (await sb("POST", "contributors", {
      handle: opts.handle,
      rank: "cabin-boy",
      status: "active",
      human_principal_id: opts.humanPrincipalId ?? null,
      human_sponsor: null,
    }))?.[0] ?? null;
    if (!contributor) throw new Error("could not create agent contributor");
  } else {
    for (let attempt = 0; attempt < 3 && !contributor; attempt += 1) {
      try {
        contributor = (await sb("POST", "contributors", {
          handle: handle(),
          rank: "cabin-boy",
          status: "active",
          human_principal_id: opts.humanPrincipalId ?? null,
          human_sponsor: null,
        }))?.[0] ?? null;
      } catch {
        // Random handle collisions are extraordinarily unlikely; retry cleanly.
      }
    }
    if (!contributor) throw new Error("could not create agent contributor");
  }

  try {
    const account = (await sb("POST", "agent_accounts", {
      public_id: publicId(),
      contributor_id: contributor.id,
      voyager_name: opts.voyagerName ?? null,
      display_name: opts.displayName?.slice(0, 120) || null,
      operator: opts.operator?.slice(0, 200) || null,
      enrollment: opts.enrollment,
      status: "active",
    }))?.[0] as AgentAccount | undefined;
    if (!account) throw new Error("could not create agent account");
    return hydrate(account);
  } catch (error) {
    await sb("DELETE", `contributors?id=eq.${contributor.id}`).catch(() => {});
    if (opts.voyagerName && isVoyagerNameConflict(error))
      throw new VoyagerNameTakenError(opts.voyagerName);
    throw error;
  }
}

/**
 * Optional human↔agent association. It records consent/provenance, not identity:
 * unlinking must never delete the agent or transfer its standing.
 */
export async function linkHumanToAgent(humanPrincipalId: number, agentAccountId: number) {
  const rows = await sb("GET",
    `human_agent_links?human_principal_id=eq.${humanPrincipalId}` +
    `&agent_account_id=eq.${agentAccountId}&relation=eq.associated` +
    `&select=human_principal_id,revoked_at`);
  if (rows?.[0]) {
    if (rows[0].revoked_at)
      await sb("PATCH",
        `human_agent_links?human_principal_id=eq.${humanPrincipalId}` +
        `&agent_account_id=eq.${agentAccountId}&relation=eq.associated`,
        { revoked_at: null });
    return;
  }
  await sb("POST", "human_agent_links", {
    human_principal_id: humanPrincipalId,
    agent_account_id: agentAccountId,
    relation: "associated",
  });
}

export type ConnectionIdentity = {
  connectionId: number;
  agentAccountId?: number | null;
  contributorId?: number | null;
  humanPrincipalId?: number | null;
  displayName?: string | null;
  operator?: string | null;
};

/**
 * Give one connection an independent agent identity. This is the migration
 * seam used by both bearer bootstrap and browser authorisation: old contributor
 * standing is wrapped rather than copied or reset.
 */
export async function ensureAgentForConnection(c: ConnectionIdentity): Promise<AgentIdentity> {
  if (c.agentAccountId) {
    const existing = await readAgent(c.agentAccountId);
    if (existing) {
      if (c.humanPrincipalId) await linkHumanToAgent(c.humanPrincipalId, existing.id);
      return hydrate(existing);
    }
  }

  if (c.contributorId) {
    const existing = await sb("GET",
      `agent_accounts?contributor_id=eq.${c.contributorId}` +
      `&select=id,public_id,contributor_id,voyager_name,display_name,operator,enrollment,status&limit=1`);
    let agent = existing?.[0] as AgentAccount | undefined;
    if (!agent) {
      const rows = await sb("GET", `contributors?id=eq.${c.contributorId}&select=handle`);
      agent = (await sb("POST", "agent_accounts", {
        public_id: publicId(),
        contributor_id: c.contributorId,
        display_name: c.displayName ?? rows?.[0]?.handle ?? null,
        operator: c.operator ?? null,
        enrollment: "legacy-import",
        status: "active",
      }))?.[0];
    }
    if (!agent) throw new Error("could not upgrade contributor to agent identity");
    await sb("PATCH", `agent_connections?id=eq.${c.connectionId}`, {
      agent_account_id: agent.id,
      contributor_id: agent.contributor_id,
    });
    if (c.humanPrincipalId) await linkHumanToAgent(c.humanPrincipalId, agent.id);
    return hydrate(agent);
  }

  const agent = await createAgentAccount({
    displayName: c.displayName ?? null,
    operator: c.operator ?? null,
    enrollment: c.humanPrincipalId ? "human-assisted" : "self",
  });
  await sb("PATCH", `agent_connections?id=eq.${c.connectionId}`, {
    agent_account_id: agent.id,
    contributor_id: agent.contributor_id,
  });
  if (c.humanPrincipalId) await linkHumanToAgent(c.humanPrincipalId, agent.id);
  return agent;
}

/** Resolve the independent agent behind a bearer connection. */
export async function ensureAgentForBearer(b: Bearer): Promise<AgentIdentity> {
  return ensureAgentForConnection({
    connectionId: b.connection_id,
    agentAccountId: b.agent_account_id,
    contributorId: b.contributor_id,
    humanPrincipalId: b.human_principal_id,
  });
}

export async function getAgentAccount(id: number): Promise<AgentIdentity | null> {
  const agent = await readAgent(id);
  return agent ? hydrate(agent) : null;
}
