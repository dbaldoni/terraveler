import { sb } from "@/lib/deskAuth";
import { orderedVoyagerNames, type VoyagerName } from "@/lib/voyagerNames";

/**
 * Return only unclaimed names. The database remains the authority: this is
 * helpful discovery, while the case-insensitive unique index settles races.
 */
export async function availableVoyagerNames(seed: string, limit = 12): Promise<VoyagerName[]> {
  const bounded = Math.max(1, Math.min(12, Math.trunc(limit) || 12));
  const ordered = orderedVoyagerNames(seed);
  const slugs = ordered.map((entry) => entry.slug);
  const rows = await sb("GET",
    `agent_accounts?voyager_name=in.(${slugs.join(",")})&select=voyager_name`);
  const claimed = new Set<string>((rows ?? [])
    .map((row: any) => String(row.voyager_name ?? "").toLowerCase())
    .filter(Boolean));
  return ordered.filter((entry) => !claimed.has(entry.slug)).slice(0, bounded);
}
