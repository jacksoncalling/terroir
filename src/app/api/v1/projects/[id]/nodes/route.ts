import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/api-auth";
import { handleAddNode } from "@/lib/api-handlers";
import { apiErrorResponse } from "@/lib/api-route-utils";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json() as {
      label?: string;
      type?: string;
      description?: string;
      hubId?: string;
    };

    if (!body.label?.trim()) {
      return NextResponse.json({ ok: false, error: "label is required" }, { status: 400 });
    }
    if (!body.type?.trim()) {
      return NextResponse.json({ ok: false, error: "type is required" }, { status: 400 });
    }

    const ctx = await authenticate(req.headers.get("authorization"));
    const result = await handleAddNode(ctx, id, {
      label: body.label,
      type: body.type,
      description: body.description,
      hubId: body.hubId,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
