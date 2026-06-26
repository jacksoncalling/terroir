import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * PATCH /api/reflect
 *
 * Writes reflection scores for a single evaluative signal.
 * Called by the Reflect tab on each score/note change (auto-save pattern).
 *
 * This is a dedicated endpoint — intentionally separate from saveOntology —
 * so reflect writes are immediate and include a server-stamped `reflected_at`.
 *
 * Body: { signalId, projectId, resonance?, userNote? }
 * Returns: { ok: true, reflectedAt: string }
 */
export async function PATCH(req: NextRequest) {
  let body: {
    signalId: string;
    projectId: string;
    resonance?: "dissonant" | "equivocal" | "resonant" | null;
    userNote?: string | null;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { signalId, projectId, resonance, userNote } = body;

  if (!signalId || !projectId) {
    return NextResponse.json(
      { error: "signalId and projectId are required" },
      { status: 400 }
    );
  }

  // Build the update patch — only include fields that were provided
  const patch: Record<string, unknown> = {
    reflected_at: new Date().toISOString(), // server-stamped
  };
  if (resonance !== undefined) patch.resonance = resonance;
  if (userNote !== undefined)  patch.user_note = userNote;

  const { error } = await supabase
    .from("evaluative_signals")
    .update(patch)
    .eq("id", signalId)
    .eq("project_id", projectId); // scope to project for safety

  if (error) {
    console.error("reflect PATCH error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, reflectedAt: patch.reflected_at });
}
