import { NextRequest, NextResponse } from "next/server";
import { getSharedProjectPayload, logSession } from "@/lib/supabase";
import { synthesizeAcrossProjects } from "@/lib/gemini";
import type { SharingScope } from "@/types";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      projectIds?: string[];
      scope?: SharingScope;
    };

    const { projectIds, scope = "team" } = body;
    const validScopes: SharingScope[] = ["private", "team", "division", "company"];

    if (!Array.isArray(projectIds) || projectIds.length < 2) {
      return NextResponse.json(
        { error: "projectIds must be an array of at least 2 project UUIDs" },
        { status: 400 }
      );
    }

    if (scope && !validScopes.includes(scope)) {
      return NextResponse.json(
        { error: `Invalid scope "${scope}". Must be one of: ${validScopes.join(", ")}` },
        { status: 400 }
      );
    }

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY is not configured" },
        { status: 500 }
      );
    }

    const payloads = await Promise.allSettled(
      projectIds.map((pid) => getSharedProjectPayload(pid, scope))
    );

    const projects = payloads
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof getSharedProjectPayload>>> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((p) => p.nodes.length > 0 || p.signals.length > 0);

    if (projects.length < 2) {
      return NextResponse.json(
        { error: `Only ${projects.length} project(s) have shared data at scope "${scope}". Mark nodes or signals as shared first.` },
        { status: 400 }
      );
    }

    const result = await synthesizeAcrossProjects(projects);

    logSession({
      project_id: projectIds[0],
      type: "synthesis",
      agent: "gemini",
      summary: `Commons synthesis — ${projects.length} projects, scope: ${scope}`,
      raw_output: {
        projectIds,
        scope,
        convergenceCount: result.convergence.length,
        contactPointCount: result.contactPoints.length,
      },
    }).catch((err) => console.warn("[commons-synthesis] Session log failed:", err));

    return NextResponse.json(result);
  } catch (err) {
    console.error("[commons-synthesis] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
