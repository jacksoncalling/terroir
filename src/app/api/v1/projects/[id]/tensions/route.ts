import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/api-auth";
import { handleSurfaceTensions } from "@/lib/api-handlers";
import { apiErrorResponse } from "@/lib/api-route-utils";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const includeResolved = req.nextUrl.searchParams.get("include_resolved") === "true";
    const ctx = await authenticate(req.headers.get("authorization"));
    const result = await handleSurfaceTensions(ctx, id, { includeResolved });
    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
