import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/api-auth";
import { handleGetProject } from "@/lib/api-handlers";
import { apiErrorResponse } from "@/lib/api-route-utils";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ctx = await authenticate(req.headers.get("authorization"));
    const result = await handleGetProject(ctx, id);
    if (!result) {
      return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
