/**
 * topology.ts
 *
 * Builds a compact topology payload from a GraphState for the
 * topology-aware signal enrichment pass (POST /api/topology-signals).
 *
 * The payload summarises hub health, cross-hub connectivity, tension
 * clustering, and emergent (isolated) entity density — giving Gemini
 * the structural context it needs to reason about organisational
 * reachability corridors rather than just document-stated values.
 */

import type { GraphState, ProjectBrief } from "@/types";
import { HUB_RELATIONSHIP_TYPE } from "@/types";

// ── Payload types ─────────────────────────────────────────────────────────────

export interface HubStat {
  id: string;                  // attractor_id slug, e.g. "domain"
  label: string;               // display label, e.g. "Domain"
  memberCount: number;         // entities with belongs_to_hub → this hub
  internalConnections: number; // semantic rels between members (excl. hub edges)
  tensionCount: number;        // unresolved tensions involving ≥1 member
}

export interface CrossHubLink {
  from: string;  // attractor_id slug
  to: string;    // attractor_id slug
  count: number; // semantic relationships crossing this hub boundary
}

export interface TopologyPayload {
  brief: {
    orgSize?: string;
    sector?: string;
    discoveryGoal?: string;
  };
  hubs: HubStat[];
  crossHubConnections: CrossHubLink[];  // sorted descending by count
  emergentCount: number;                // entities with 0–1 semantic rels
  totalEntities: number;                // non-hub nodes
  totalRelationships: number;           // non-hub edges
  topTensions: string[];                // up to 5 unresolved tension descriptions
  signals: {
    id: string;
    label: string;
    direction: string;
    source: string;                     // truncated sourceDescription for context
  }[];
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Builds a compact topology payload from the current graph state.
 *
 * All computation is pure (no Supabase calls) — the full graph must be
 * loaded before calling this. Designed to be called once per enrichment
 * pass and passed directly to enrichSignalsWithTopology().
 */
export function buildTopologyPayload(
  graph: GraphState,
  brief?: ProjectBrief | null
): TopologyPayload {
  const hubNodes    = graph.nodes.filter((n) => n.is_hub === true);
  const entityNodes = graph.nodes.filter((n) => n.is_hub !== true);

  // ── nodeId → hubSlug map (from belongs_to_hub edges) ────────────────────
  const nodeToHub: Record<string, string> = {};
  for (const rel of graph.relationships) {
    if (rel.type !== HUB_RELATIONSHIP_TYPE) continue;
    const hub = hubNodes.find((h) => h.id === rel.targetId);
    if (hub) {
      nodeToHub[rel.sourceId] = hub.properties?.attractor_id ?? hub.label.toLowerCase();
    }
  }

  // ── Per-hub stats ────────────────────────────────────────────────────────
  const hubs: HubStat[] = hubNodes.map((hub) => {
    const hubSlug = hub.properties?.attractor_id ?? hub.label.toLowerCase();

    const memberIds = new Set(
      graph.relationships
        .filter((r) => r.type === HUB_RELATIONSHIP_TYPE && r.targetId === hub.id)
        .map((r) => r.sourceId)
    );

    // Semantic rels where both endpoints belong to this hub
    const internalConnections = graph.relationships.filter(
      (r) =>
        r.type !== HUB_RELATIONSHIP_TYPE &&
        memberIds.has(r.sourceId) &&
        memberIds.has(r.targetId)
    ).length;

    // Unresolved tensions touching at least one member
    const tensionCount = graph.tensions.filter(
      (t) =>
        t.status === "unresolved" &&
        t.relatedNodeIds.some((id) => memberIds.has(id))
    ).length;

    return { id: hubSlug, label: hub.label, memberCount: memberIds.size, internalConnections, tensionCount };
  });

  // ── Cross-hub connection matrix ──────────────────────────────────────────
  // Count semantic rels that cross a hub boundary. Sorted heaviest first.
  const crossHubMap: Record<string, number> = {};
  for (const rel of graph.relationships) {
    if (rel.type === HUB_RELATIONSHIP_TYPE) continue;
    const fromHub = nodeToHub[rel.sourceId];
    const toHub   = nodeToHub[rel.targetId];
    if (fromHub && toHub && fromHub !== toHub) {
      // Sort the pair so A→B and B→A collapse into one key
      const key = [fromHub, toHub].sort().join("→");
      crossHubMap[key] = (crossHubMap[key] ?? 0) + 1;
    }
  }
  const crossHubConnections: CrossHubLink[] = Object.entries(crossHubMap)
    .map(([key, count]) => {
      const [from, to] = key.split("→");
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);

  // ── Emergent count: entities with 0–1 semantic relationships ────────────
  const connectionCounts: Record<string, number> = {};
  for (const n of entityNodes) connectionCounts[n.id] = 0;
  for (const rel of graph.relationships) {
    if (rel.type === HUB_RELATIONSHIP_TYPE) continue;
    if (rel.sourceId in connectionCounts) connectionCounts[rel.sourceId]++;
    if (rel.targetId in connectionCounts) connectionCounts[rel.targetId]++;
  }
  const emergentCount = Object.values(connectionCounts).filter((c) => c <= 1).length;

  // ── Top 5 unresolved tensions ────────────────────────────────────────────
  const topTensions = graph.tensions
    .filter((t) => t.status === "unresolved")
    .slice(0, 5)
    .map((t) => t.description);

  // ── Signal list (id + label + direction + truncated source) ─────────────
  const signals = graph.evaluativeSignals.map((s) => ({
    id:        s.id,
    label:     s.label,
    direction: s.direction,
    source:    (s.sourceDescription ?? "").slice(0, 120),
  }));

  return {
    brief: {
      orgSize:       brief?.orgSize,
      sector:        brief?.sector,
      discoveryGoal: brief?.discoveryGoal,
    },
    hubs,
    crossHubConnections,
    emergentCount,
    totalEntities:      entityNodes.length,
    totalRelationships: graph.relationships.filter((r) => r.type !== HUB_RELATIONSHIP_TYPE).length,
    topTensions,
    signals,
  };
}

// ── Structural pattern detection (deterministic) ───────────────────────────────
//
// Detection lives HERE, in code — not in the model. Thresholds over the numbers
// buildTopologyPayload already computed decide whether a cross-graph fault line
// exists. Gemini's downstream job is only to VOICE these candidates, never to
// find them or recite the counts. Zero candidates is a valid, meaningful answer:
// a thin or quiet graph has no cross-graph fault lines, and the meta-tension pass
// should stay silent rather than narrate arithmetic.
//
// Thresholds are tunable constants — recalibrated against real output in Move D.

const META_MIN_ENTITIES    = 12;     // below this the graph is too thin for cross-graph structure
const CONTRACTED_DOMINANCE = 0.5;    // one hub holds >50% of all members
const CONTRACTED_THIN      = 0.1;    // a "thin" hub holds <=10% of members
const PULLED_EMERGENT      = 1 / 3;  // >1/3 of entities isolated (emergent)
const BLOCKED_TENSION_MIN  = 2;      // a hub carrying >=2 local tensions is a stress site
const SHALLOW_BRIDGE_MAX   = 1;      // a cross-hub bridge of <=1 relationship is shallow
const MAX_PATTERNS         = 4;

export type SomaticPattern = "contracted" | "blocked" | "pulled";

export interface StructuralPattern {
  pattern: SomaticPattern;
  hubSlugs: string[]; // hubs on each side of the fault line (slugs, resolved to node IDs by caller)
  evidence: string;   // the deterministic facts that triggered it — context for voicing, not the insight
}

/**
 * Deterministically detect candidate cross-graph fault lines from a topology payload.
 * Returns 0–4 candidates. Pure function — no model, no Supabase.
 */
export function detectStructuralPatterns(payload: TopologyPayload): StructuralPattern[] {
  const total = payload.totalEntities;

  // ── Thinness gate: too few entities to support cross-graph structure ────────
  if (total < META_MIN_ENTITIES) return [];

  const patterns: StructuralPattern[] = [];

  // ── CONTRACTED: one hub dominates while at least one other stays thin ───────
  const dominant = payload.hubs.find((h) => h.memberCount / total >= CONTRACTED_DOMINANCE);
  if (dominant) {
    const thinnest = payload.hubs
      .filter((h) => h.id !== dominant.id && h.memberCount / total <= CONTRACTED_THIN)
      .sort((a, b) => a.memberCount - b.memberCount)[0];
    if (thinnest) {
      patterns.push({
        pattern: "contracted",
        hubSlugs: [dominant.id, thinnest.id],
        evidence:
          `"${dominant.label}" holds ${dominant.memberCount} of ${total} entities ` +
          `while "${thinnest.label}" holds ${thinnest.memberCount}; the graph is pulling inward around one hub.`,
      });
    }
  }

  // ── PULLED: high isolation — concepts multiplying faster than they integrate ─
  if (payload.emergentCount / total >= PULLED_EMERGENT) {
    const heaviest = [...payload.hubs].sort((a, b) => b.memberCount - a.memberCount).slice(0, 2);
    if (heaviest.length > 0) {
      patterns.push({
        pattern: "pulled",
        hubSlugs: heaviest.map((h) => h.id),
        evidence:
          `${payload.emergentCount} of ${total} entities are isolated (emergent); ` +
          `concepts are being generated faster than they are integrated.`,
      });
    }
  }

  // ── BLOCKED: >=2 stressed hubs joined only by a shallow (or absent) bridge ──
  const stressed = payload.hubs.filter((h) => h.tensionCount >= BLOCKED_TENSION_MIN);
  outer: for (let i = 0; i < stressed.length; i++) {
    for (let j = i + 1; j < stressed.length; j++) {
      const a = stressed[i];
      const b = stressed[j];
      const bridge = payload.crossHubConnections.find(
        (c) => (c.from === a.id && c.to === b.id) || (c.from === b.id && c.to === a.id)
      );
      const bridgeCount = bridge?.count ?? 0;
      if (bridgeCount <= SHALLOW_BRIDGE_MAX) {
        patterns.push({
          pattern: "blocked",
          hubSlugs: [a.id, b.id],
          evidence:
            `"${a.label}" (${a.tensionCount} local tensions) and "${b.label}" (${b.tensionCount}) ` +
            `are joined by only ${bridgeCount} cross-hub relationship${bridgeCount === 1 ? "" : "s"}; ` +
            `their friction has no path to resolve.`,
        });
        break outer;
      }
    }
  }

  return patterns.slice(0, MAX_PATTERNS);
}
