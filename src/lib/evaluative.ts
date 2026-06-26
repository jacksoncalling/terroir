import type { EvaluativeSignal, GraphState, Resonance } from "@/types";

// Intensity threshold for the jagged border visual state.
// A node crosses this when its linked signals produce a combined weight ≥ this value.
export const JAGGED_INTENSITY_THRESHOLD = 10;

// Bounds for the linear size-mapping scale.
// Raw intensity outside [MIN, MAX] is clamped before normalization.
export const INTENSITY_MIN = 0;
export const INTENSITY_MAX = 50;

// Per-signal evaluative weight by resonance verdict. Replaces the old
// relevance × intensity product. Dissonance is information, not weakness: it
// carries real weight and is surfaced (see nodeHasDissonance), never shrunk.
export const RESONANCE_WEIGHT: Record<Resonance, number> = {
  resonant:  6,
  equivocal: 2,
  dissonant: 4,
};

/**
 * Compute raw evaluative weight for a single node.
 * Formula: Σ RESONANCE_WEIGHT[resonance] for every linked signal that has a
 * verdict. Unjudged signals (resonance == null) contribute 0.
 */
export function computeNodeIntensity(
  nodeId: string,
  signals: EvaluativeSignal[]
): number {
  return signals
    .filter((s) => s.relatedNodeIds?.includes(nodeId))
    .reduce((sum, s) => sum + (s.resonance ? RESONANCE_WEIGHT[s.resonance] : 0), 0);
}

/** True if any signal linked to this node is dissonant (mis-voiced — a re-voice flag). */
export function nodeHasDissonance(
  nodeId: string,
  signals: EvaluativeSignal[]
): boolean {
  return signals.some((s) => s.resonance === "dissonant" && s.relatedNodeIds?.includes(nodeId));
}

/**
 * Compute intensity for all node IDs in one pass.
 * Returns Map<nodeId, rawIntensity>.
 */
export function computeIntensityMap(
  nodeIds: string[],
  signals: EvaluativeSignal[]
): Map<string, number> {
  const map = new Map<string, number>();
  for (const nodeId of nodeIds) {
    map.set(nodeId, computeNodeIntensity(nodeId, signals));
  }
  return map;
}

/**
 * Map raw intensity to a normalized 0–1 value using clamped linear interpolation.
 */
export function normalizeIntensity(raw: number): number {
  if (raw <= INTENSITY_MIN) return 0;
  if (raw >= INTENSITY_MAX) return 1;
  return (raw - INTENSITY_MIN) / (INTENSITY_MAX - INTENSITY_MIN);
}

// ── Snapshot diffing ───────────────────────────────────────────────────────────

export interface SnapshotDiff {
  nodesAdded: string[];
  nodesRemoved: string[];
  /** nodeId → { before: number, after: number } — only if delta ≥ INTENSITY_DELTA_THRESHOLD */
  intensityChanges: Record<string, { before: number; after: number }>;
  edgesAdded: number;
  edgesRemoved: number;
  signalsAdded: string[];
  tensionsAppeared: string[];
  tensionsResolved: string[];
}

const INTENSITY_DELTA_THRESHOLD = 5;

/**
 * Diff two graph snapshots and return a structured summary.
 * Used by the Session Delta narration to describe what changed since last integration.
 */
export function diffSnapshots(prev: GraphState, curr: GraphState): SnapshotDiff {
  const prevNodeIds = new Set(prev.nodes.map((n) => n.id));
  const currNodeIds = new Set(curr.nodes.map((n) => n.id));

  const nodesAdded = curr.nodes
    .filter((n) => !n.is_hub && !prevNodeIds.has(n.id))
    .map((n) => n.label);
  const nodesRemoved = prev.nodes
    .filter((n) => !n.is_hub && !currNodeIds.has(n.id))
    .map((n) => n.label);

  // Intensity changes for nodes present in both snapshots
  const prevIntensityMap = computeIntensityMap(
    [...prevNodeIds],
    prev.evaluativeSignals
  );
  const currIntensityMap = computeIntensityMap(
    [...currNodeIds],
    curr.evaluativeSignals
  );

  const intensityChanges: SnapshotDiff["intensityChanges"] = {};
  for (const [id, currVal] of currIntensityMap) {
    if (!prevNodeIds.has(id)) continue;
    const prevVal = prevIntensityMap.get(id) ?? 0;
    if (Math.abs(currVal - prevVal) >= INTENSITY_DELTA_THRESHOLD) {
      intensityChanges[id] = { before: prevVal, after: currVal };
    }
  }

  const prevRelIds = new Set(prev.relationships.map((r) => r.id));
  const currRelIds = new Set(curr.relationships.map((r) => r.id));
  const edgesAdded = [...currRelIds].filter((id) => !prevRelIds.has(id)).length;
  const edgesRemoved = [...prevRelIds].filter((id) => !currRelIds.has(id)).length;

  const prevSignalIds = new Set(prev.evaluativeSignals.map((s) => s.id));
  const signalsAdded = curr.evaluativeSignals
    .filter((s) => !prevSignalIds.has(s.id))
    .map((s) => s.label);

  const prevTensionIds = new Set(prev.tensions.map((t) => t.id));
  const currTensionById = new Map(curr.tensions.map((t) => [t.id, t]));

  const tensionsAppeared = curr.tensions
    .filter((t) => t.status === "unresolved" && !prevTensionIds.has(t.id))
    .map((t) => t.description);

  const tensionsResolved = prev.tensions
    .filter((t) => {
      const inCurr = currTensionById.get(t.id);
      return t.status === "unresolved" && inCurr?.status === "resolved";
    })
    .map((t) => t.description);

  return {
    nodesAdded,
    nodesRemoved,
    intensityChanges,
    edgesAdded,
    edgesRemoved,
    signalsAdded,
    tensionsAppeared,
    tensionsResolved,
  };
}
