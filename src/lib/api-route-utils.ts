import { NextResponse } from "next/server";
import { AuthError, RateLimitError } from "./api-auth";

export function apiErrorResponse(err: unknown): NextResponse {
  if (err instanceof RateLimitError) {
    return NextResponse.json(
      { ok: false, error: err.message, reset_at: err.resetAt },
      { status: 429 }
    );
  }
  if (err instanceof AuthError) {
    return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
  }
  return NextResponse.json(
    { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
    { status: 500 }
  );
}
