import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/api-auth";
import { handleAddSource } from "@/lib/api-handlers";
import { apiErrorResponse } from "@/lib/api-route-utils";

// Gemini extraction can take up to 60s on large content
export const maxDuration = 300;

/**
 * POST /api/v1/projects/:id/ingest
 *
 * Accepts a URL or raw text from an external agent (e.g. Medicus) and runs
 * the full Terroir ingest pipeline: classify → Gemini extraction → graph update.
 *
 * Body: { url?: string; text?: string; title?: string }
 *   - Provide either `url` (fetched server-side) or `text` (raw content).
 *   - `title` is optional; defaults to the URL hostname or "Agent source".
 *
 * Returns: { verdict, graphUpdates, nodeCount, relationshipCount }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json() as { url?: string; text?: string; title?: string };

    if (!body.url?.trim() && !body.text?.trim()) {
      return NextResponse.json(
        { ok: false, error: "Provide either url or text" },
        { status: 400 }
      );
    }

    const ctx = await authenticate(req.headers.get("authorization"));

    let text = body.text?.trim() ?? "";
    let title = body.title?.trim();

    // If a URL was provided, fetch readable text server-side
    if (body.url?.trim()) {
      const fetched = await fetchUrlText(body.url.trim());
      text = fetched.text;
      title = title ?? fetched.title ?? new URL(body.url.trim()).hostname;
    } else {
      title = title ?? "Agent source";
    }

    if (text.length < 50) {
      return NextResponse.json(
        { ok: false, error: "Content too short to extract from" },
        { status: 422 }
      );
    }

    const result = await handleAddSource(ctx, id, text, title);
    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    console.error("[ingest] error:", err);
    return apiErrorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// URL fetch helper — minimal HTML → text strip (same approach as Medicus)
// ---------------------------------------------------------------------------

// Reject RFC 1918 private ranges and localhost — same guard as Medicus fetchContent
const PRIVATE_HOST_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

function assertSafeUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("Invalid URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http/https URLs are supported");
  if (PRIVATE_HOST_RE.test(parsed.hostname)) throw new Error("Private/local URLs are not allowed");
  return parsed.href;
}

async function fetchUrlText(url: string): Promise<{ text: string; title: string | null }> {
  const safeUrl = assertSafeUrl(url);
  const res = await fetch(safeUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Terroir/1.0; ingest-agent)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, " ") : null;

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { text, title };
}
