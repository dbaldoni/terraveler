import { NextResponse } from "next/server";
import { readCookie, getUserEmail, editorEmail } from "@/lib/deskAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cleanEnv = (v?: string) => (v ?? "").replace(/[\s\u200B-\u200D\uFEFF]+/g, "").replace(/\/+$/, "");
const SB_URL = cleanEnv(process.env.SUPABASE_URL);
const SB_KEY = cleanEnv(process.env.SUPABASE_SERVICE_KEY);

async function sb(method: string, path: string): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json"
    }
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Supabase query failed with status ${r.status}: ${body}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : [];
}

/**
 * Backend query contract for unresolved governance items.
 * Exposes needs_human_review, quarantined sources, recent rejects, and material drift events.
 * Accessible only to authorized human editors.
 */
export async function GET(req: Request) {
  // 1. Authorize human editor session
  const token = readCookie(req);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  
  const email = await getUserEmail(token);
  if (!email || email.toLowerCase() !== editorEmail()) {
    return NextResponse.json({ error: "Forbidden: editor privileges required" }, { status: 403 });
  }

  try {
    // 2. Fetch needs_human_review and quarantined sources
    const endpoints = await sb("GET", "source_endpoints?status=in.(needs_human_review,quarantined)&select=id,host_pattern,match_type,status,trust_mode,last_verified_at");
    
    // 3. Fetch recent policy rejects
    const rejects = await sb("GET", "source_policy_decisions?decision_outcome=eq.reject&select=id,endpoint_id,trust_mode,rights_class,rights_identifier,reason,timestamp&order=timestamp.desc&limit=20");
    
    // 4. Fetch recent material drift evaluations
    const drifts = await sb("GET", "source_drift_evaluations?drift_detected=eq.true&select=id,reverification_id,subject_type,subject_id,drift_class,drift_codes,old_material_fingerprint,new_material_fingerprint,recommended_action,created_at&order=created_at.desc&limit=20");

    return NextResponse.json({
      success: true,
      queue: {
        review_required_endpoints: endpoints,
        recent_rejects: rejects,
        recent_material_drifts: drifts
      }
    });
  } catch (e: any) {
    return NextResponse.json({ error: `Failed to query governance queue: ${e.message}` }, { status: 500 });
  }
}
