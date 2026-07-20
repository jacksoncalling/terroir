import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/api-auth";
import { handleAddSource } from "@/lib/api-handlers";
import { apiErrorResponse } from "@/lib/api-route-utils";

export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json() as { text?: string; title?: string };

    if (!body.text?.trim()) {
      return NextResponse.json({ ok: false, error: "text is required" }, { status: 400 });
    }

    const ctx = await authenticate(req.headers.get("authorization"));
    const result = await handleAddSource(ctx, id, body.text, body.title);
    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
