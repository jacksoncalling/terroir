import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/api-auth";
import { handleAddSignal } from "@/lib/api-handlers";
import { apiErrorResponse } from "@/lib/api-route-utils";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json() as {
      label?: string;
      direction?: string;
      strength?: number;
      sourceDescription?: string;
      thresholdProximity?: number;
      atCostOf?: string;
      temporalHorizon?: string;
    };

    if (!body.label?.trim()) {
      return NextResponse.json({ ok: false, error: "label is required" }, { status: 400 });
    }
    if (!["toward", "away_from", "protecting"].includes(body.direction ?? "")) {
      return NextResponse.json(
        { ok: false, error: "direction must be toward | away_from | protecting" },
        { status: 400 }
      );
    }

    const ctx = await authenticate(req.headers.get("authorization"));
    const result = await handleAddSignal(ctx, id, {
      label: body.label,
      direction: body.direction as "toward" | "away_from" | "protecting",
      strength: body.strength ?? 3,
      sourceDescription: body.sourceDescription,
      thresholdProximity: body.thresholdProximity,
      atCostOf: body.atCostOf,
      temporalHorizon: body.temporalHorizon,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
