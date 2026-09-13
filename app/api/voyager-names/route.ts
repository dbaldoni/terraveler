import { NextResponse } from "next/server";
import { availableVoyagerNames } from "@/lib/voyagerNameAvailability";
import { VOYAGER_NAMES } from "@/lib/voyagerNames";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAMPLE_SIZE = 12;

/**
 * A deliberately bounded discovery surface, not a name-availability oracle.
 * It accepts no search/name parameter and holds one stable sample for the day;
 * registration plus the database constraint remains the authority.
 */
export async function GET() {
  const day = new Date().toISOString().slice(0, 10);
  const names = await availableVoyagerNames(`public:${day}`, SAMPLE_SIZE);
  return NextResponse.json({
    names,
    sample_size: names.length,
    catalogue_size: VOYAGER_NAMES.length,
    note:
      "A limited daily sample of currently unclaimed Voyager Names. " +
      "Submit one as voyager_name during client_credentials registration; availability is confirmed atomically then.",
  }, {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600",
    },
  });
}
