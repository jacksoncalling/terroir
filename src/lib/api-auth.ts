/**
 * Bearer token authentication for /api/v1/ routes.
 *
 * Tokens are stored hashed (SHA-256) in the api_tokens table.
 * The consumer sends the plaintext token; we hash it on the way in and
 * compare against token_hash. Plaintext is never stored.
 *
 * Mint tokens with: npm run mint-token (scripts/mint-token.ts)
 */

import { createClient } from "@supabase/supabase-js";

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  // Prefer service key — RLS blocks anon reads on api_tokens, by design.
  // Falls back to anon key for environments where SUPABASE_SERVICE_KEY isn't set.
  const key =
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    "";
  if (!url || !key) throw new AuthError(401, "Auth not configured — missing Supabase env vars");
  return createClient(url, key);
}

export interface AuthContext {
  tokenId: string;
  name: string;
  scopes: string[];
  projectScope: string | null;
}

export class AuthError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Daily call budget per token. Generous enough for a real working session;
// stops a runaway loop or accidental overnight ingest.
const DAILY_CAP = 200;

export class RateLimitError extends Error {
  public readonly status = 429;
  public readonly resetAt: string;
  constructor(resetAt: string) {
    super(`Daily limit of ${DAILY_CAP} calls reached. Resets at ${resetAt}.`);
    this.resetAt = resetAt;
  }
}

export async function authenticate(authHeader: string | null): Promise<AuthContext> {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AuthError(401, "Missing or malformed Authorization header");
  }

  const plaintext = authHeader.slice(7).trim();
  const hash = await sha256Hex(plaintext);

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("api_tokens")
    .select("id, name, scopes, project_scope, revoked_at, usage_count, usage_reset_at")
    .eq("token_hash", hash)
    .single();

  if (error || !data) {
    throw new AuthError(401, "Invalid token");
  }

  if (data.revoked_at) {
    throw new AuthError(401, "Token has been revoked");
  }

  // Daily usage cap — reset window if expired, then check and increment.
  const now = new Date();
  const resetAt = data.usage_reset_at ? new Date(data.usage_reset_at) : null;
  const windowExpired = !resetAt || resetAt <= now;

  const newCount = windowExpired ? 1 : (data.usage_count ?? 0) + 1;
  const newResetAt = windowExpired
    ? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
    : data.usage_reset_at;

  if (!windowExpired && (data.usage_count ?? 0) >= DAILY_CAP) {
    throw new RateLimitError(data.usage_reset_at);
  }

  // Fire-and-forget — don't block the request on the update write.
  supabase
    .from("api_tokens")
    .update({ usage_count: newCount, usage_reset_at: newResetAt })
    .eq("id", data.id)
    .then(({ error: updateErr }) => {
      if (updateErr) console.warn("[api-auth] usage update failed:", updateErr.message);
    });

  return {
    tokenId: data.id,
    name: data.name,
    scopes: data.scopes as string[],
    projectScope: data.project_scope ?? null,
  };
}

export function assertScope(ctx: AuthContext, scope: string): void {
  if (!ctx.scopes.includes(scope)) {
    throw new AuthError(403, `Token does not have '${scope}' scope`);
  }
}

export function assertProject(ctx: AuthContext, projectId: string): void {
  if (ctx.projectScope !== null && ctx.projectScope !== projectId) {
    throw new AuthError(403, "Token is not authorised for this project");
  }
}
