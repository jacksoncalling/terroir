import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/api-auth";
import { handleRunSynthesis } from "@/lib/api-handlers";
import { apiErrorResponse } from "@/lib/api-route-utils";

export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ctx = await authenticate(req.headers.get("authorization"));
    const result = await handleRunSynthesis(ctx, id);
    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
