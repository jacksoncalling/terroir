import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/api-auth";
import { handleListProjects } from "@/lib/api-handlers";
import { apiErrorResponse } from "@/lib/api-route-utils";

export async function GET(req: NextRequest) {
  try {
    const ctx = await authenticate(req.headers.get("authorization"));
    const projects = await handleListProjects(ctx);
    return NextResponse.json({ ok: true, data: projects });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
