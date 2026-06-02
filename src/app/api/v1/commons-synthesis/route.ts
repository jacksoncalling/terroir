import { NextRequest, NextResponse } from "next/server";
import { authenticate, AuthError } from "@/lib/api-auth";
import { handleCommonsSynthesis } from "@/lib/api-handlers";
import type { SharingScope } from "@/types";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const ctx = await authenticate(req.headers.get("authorization"));
    const body = await req.json();

    const { projectIds, scope } = body as {
      projectIds?: string[];
      scope?: SharingScope;
    };

    if (!Array.isArray(projectIds) || projectIds.length < 2) {
      return NextResponse.json(
        { ok: false, error: "projectIds must be an array of at least 2 project UUIDs" },
        { status: 400 }
      );
    }

    const validScopes: Array<import("@/types").SharingScope> = ["private", "team", "division", "company"];
    if (scope && !validScopes.includes(scope)) {
      return NextResponse.json(
        { ok: false, error: `Invalid scope "${scope}". Must be one of: ${validScopes.join(", ")}` },
        { status: 400 }
      );
    }

    const result = await handleCommonsSynthesis(ctx, projectIds, scope ?? "team");
    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
