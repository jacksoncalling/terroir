import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/api-auth";
import { handleGetEvaluativeField } from "@/lib/api-handlers";
import { apiErrorResponse } from "@/lib/api-route-utils";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const sp = req.nextUrl.searchParams;

    const direction = sp.get("direction") as "toward" | "away_from" | "protecting" | null;
    const temporalHorizon = sp.get("temporal_horizon") ?? undefined;
    const minStrength = sp.get("min_strength") ? Number(sp.get("min_strength")) : undefined;
    const nearThreshold = sp.get("near_threshold") === "true" ? true : undefined;

    const ctx = await authenticate(req.headers.get("authorization"));
    const result = await handleGetEvaluativeField(ctx, id, {
      direction: direction ?? undefined,
      temporalHorizon,
      minStrength,
      nearThreshold,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
