// ── Project ─────────────────────────────────────────────────────────────────
// The core isolation primitive for Phase 2. Every ontology, corpus, and session
// belongs to exactly one Project.

export type ProjectPhase = 'preparation' | 'workshop' | 'synthesis' | 'validation' | 'live';

export interface Project {
  id: string;
  name: string;
  sector?: string;
  description?: string;
  embedding_model: string;
  phase: ProjectPhase;
  metadata: Record<string, unknown>;
  parent_project_id?: string | null;
  created_at: string;
  updated_at: string;
}

// ── Entity type configuration — emergent, not fixed ──────────────────────────
export interface EntityTypeConfig {
  id: string;
  label: string;
  color: string;
}

// ── Attractor presets ────────────────────────────────────────────────────────
// Structural categories that form the ontological scaffolding.
// Hub nodes are real entities in the graph. Regular nodes connect to hubs
// via `belongs_to_hub` relationships. The `attractor` field is a cached
// reference to the primary hub (derived from relationships, not authoritative).

export type AttractorPreset = 'startup' | 'enterprise' | 'individual' | 'custom';

export type NodeZone = 'emergent' | 'attracted' | 'integrated';

export interface AttractorConfig {
  id: string;
  label: string;
  color: string;
  description: string;
}

/** Relationship type constant for hub membership edges */
export const HUB_RELATIONSHIP_TYPE = 'belongs_to_hub';

export type SessionType = 'inquiry' | 'extraction' | 'synthesis' | 'classification' | 'manual';
export type SessionAgent = 'haiku' | 'sonnet' | 'gemini' | 'manual';

export interface GraphNode {
  id: string;
  label: string;
  type: string; // freeform descriptive tag — matches EntityTypeConfig.id
  attractor?: string; // cached primary hub id (derived from belongs_to_hub relationships). Defaults to 'emergent'.
  is_hub?: boolean; // true for hub/attractor nodes seeded from preset
  description: string;
  position: { x: number; y: number };
  properties?: Record<string, string>;
  readonly?: boolean; // true for nodes inherited from parent project
  sourceType?: SessionAgent; // provenance: who created this node?
  sharingScope?: SharingScope;
}

export interface Relationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  description?: string;
}

export interface TensionMarker {
  id: string;
  description: string;
  relatedNodeIds: string[];
  status: "unresolved" | "resolved";
  /** "local" = intra-document structural conflict; "cross-graph" = hub-level fault line */
  scope?: "local" | "cross-graph";
}

/**
 * Temporal horizons for evaluative signals — from Jabe Bloom's temporality model.
 * Different levels of an organisation operate at different time scales and require
 * different vocabularies. Agents filter signals by horizon to match their operating context.
 */
export type TemporalHorizon = "operational" | "tactical" | "strategic" | "foundational";

/** Resonance verdict on a signal — the human reflect judgment (replaces relevance × intensity). */
export type Resonance = "dissonant" | "equivocal" | "resonant";

export interface EvaluativeSignal {
  id: string;
  label: string;
  direction: "toward" | "away_from" | "protecting";
  /** Extraction-time salience score (1–5). Legacy column name in DB is `strength`. */
  strength: number;
  /** Gradient intensity — how forcefully this gradient is expressed (1–5). Alias for strength; new extractions write this directly. */
  intensity?: number;
  /** How close this gradient is to flipping, breaking, or crossing a threshold (1–5, null = not yet assessed) */
  thresholdProximity?: number | null;
  /** What is given up, risked, or eroded by this gradient's direction */
  atCostOf?: string | null;
  sourceDescription: string;
  // ── Temporal context ─────────────────────────────────────────────────────
  /** Time horizon this signal operates at (null = not yet classified) */
  temporalHorizon?: TemporalHorizon | null;
  // ── Graph connections — IDs of nodes this signal evaluates ────────────────
  /** Node IDs linked via signal_node_links junction table */
  relatedNodeIds?: string[];
  // ── Reflect verdict — set by the user, nullable until judged ───────────────
  /**
   * Resonance verdict from the reflect / resonance-probe pass. Replaces the old
   * relevance × intensity dials. A human (not the extractor) judges whether the
   * signal rings true against the field, anchored to the protected-term grammar
   * rather than to taste. dissonant = mis-voiced or off; re-voice it.
   */
  resonance?: Resonance | null;
  /** ISO timestamp of the last reflection verdict */
  reflectedAt?: string | null;
  /** Optional freetext note from the consultant */
  userNote?: string | null;
  sharingScope?: SharingScope;
}

export interface GraphState {
  nodes: GraphNode[];
  relationships: Relationship[];
  tensions: TensionMarker[];
  evaluativeSignals: EvaluativeSignal[];
  entityTypes: EntityTypeConfig[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export type GraphUpdateType =
  | "node_created"
  | "node_updated"
  | "node_deleted"
  | "relationship_created"
  | "relationship_deleted"
  | "tension_flagged"
  | "tension_resolved"
  | "evaluative_signal_set";

export interface GraphUpdate {
  type: GraphUpdateType;
  label: string;
}

// ── Phase 2: Abstraction Layer ────────────────────────────────────────────────
//
// Project-level setting that tells Gemini which "lens" to use when extracting
// entities from documents. Three presets map to the three abstraction levels
// surfaced in Terroir's design:
//
//   domain_objects       — nouns: systems, teams, tools, documents, roles
//   interaction_patterns — verbs: workflows, handoffs, communication paths
//   concerns_themes      — adjectives: values, tensions, strategic priorities

export type AbstractionLayer =
  | "domain_objects"
  | "interaction_patterns"
  | "concerns_themes";

// ── Phase 2.5: Document Classification ──────────────────────────────────────
//
// Pre-classification step that filters documents before extraction.
// Gemini classifies each document as EXTRACT, CAUTION, or SKIP based on
// genre (legal, marketing, operational) to prevent noise from polluting
// the knowledge graph.

export type ClassificationVerdict = "EXTRACT" | "CAUTION" | "SKIP";

export interface DocumentClassification {
  documentIndex: number;           // index in the batch
  title: string;
  verdict: ClassificationVerdict;
  genre: string;                   // e.g. "legal", "marketing", "operational", "interview"
  confidence: number;              // 0-1
  reason: string;                  // one-line explanation
  isDuplicate?: boolean;           // true if this duplicates another doc
  duplicateOf?: string;            // title of the doc it duplicates
}

// ── Phase 2: Project Brief ────────────────────────────────────────────────────
//
// Produced by the Haiku scoping dialogue. Stored in projects.metadata.brief
// (jsonb column — no migration needed). Feeds into Gemini extraction and
// Haiku synthesis as the "stable context" layer.

export interface ProjectBrief {
  orgSize?: string;                    // e.g. "startup", "50-200 people", "enterprise"
  sector?: string;                     // e.g. "aviation", "healthcare", "fintech"
  discoveryGoal?: string;              // what the consultant most wants to understand
  abstractionLayer: AbstractionLayer;  // extraction lens — required once set
  keyThemes?: string[];                // top themes surfaced during scoping
  summary?: string;                    // Haiku-generated prose summary of the brief
  rawAnswers?: Record<string, string>; // raw Q&A pairs from the scoping dialogue
  generatedAt?: string;                // ISO timestamp of last generation
}

// ── Phase 2: Synthesis Result ─────────────────────────────────────────────────
//
// Produced by the Haiku synthesis reader after reading across all ingested
// documents. Not persisted to DB — cached in localStorage per project.

/** The same concept called different names across different sources */
export interface TermCollision {
  variants: string[];             // e.g. ["updates", "sync", "alignment", "comms"]
  sources: string[];              // document titles where each variant appears
  suggestedCanonical: string;     // Haiku's recommended unified term
  context: string;                // why these terms refer to the same concept
}

/** A recurring theme or structural pattern that spans multiple sources */
export interface ConnectingThread {
  theme: string;
  description: string;
  relatedSources: string[];
  relatedNodeIds?: string[];      // optional: maps to existing graph nodes
}

/** Agreement or disagreement on an evaluative dimension across sources */
export interface SignalConvergence {
  signal: string;                 // what multiple sources converge on
  convergenceType: "agreement" | "disagreement" | "partial";
  sources: string[];
  description: string;
}

/** A concept present in transcripts but absent/underrepresented in the graph */
export interface GraphGap {
  description: string;
  suggestedQuestion: string;      // pre-filled prompt for the consultant to follow up
  relatedNodeIds?: string[];
}

// ── Cross-document integration ────────────────────────────────────────────────
//
// Phase 5 of the Sources pipeline. After all documents are extracted,
// a single Gemini pass merges near-duplicate entities across documents,
// generates cross-document relationships, and corrects attractor assignments
// that were misleading when seen in per-document isolation.

/** Compact entity sent to Gemini for the integration pass (descriptions truncated to 100 chars) */
export interface CompactEntity {
  id: string;
  label: string;
  type: string;
  attractor: string;
  desc: string;
}

/** A set of entities that refer to the same concept across different documents */
export interface MergeGroup {
  canonicalLabel: string;
  canonicalDescription: string;
  /** All entity IDs in the group — survivor is determined by relationship count, not position */
  entityIdsToMerge: string[];
}

/** A new relationship to create between entities from different source documents */
export interface CrossDocRelationship {
  sourceEntityId: string;
  targetEntityId: string;
  type: string;
  description?: string;
}

/** An attractor correction — per-document context was insufficient to assign correctly */
export interface AttractorReassignment {
  entityId: string;
  oldAttractor: string;
  newAttractor: string;
  reason: string;
}

/** Summary returned by /api/integrate */
export interface IntegrationResult {
  mergeGroupCount: number;
  entitiesMerged: number;      // non-survivor nodes deleted
  relationshipsAdded: number;
  attractorsReassigned: number;
}

// ── Cross-project commons synthesis ──────────────────────────────────────────

export type SharingScope = 'private' | 'team' | 'division' | 'company';

export interface CompactProjectPayload {
  projectId: string;
  projectName: string;
  nodes: { id: string; label: string; type: string; description: string }[];
  signals: { label: string; direction: string; strength: number; thresholdProximity: number | null }[];
  tensions: { label: string; description: string }[];
}

export interface CommonsSynthesisResult {
  convergence: { label: string; projects: string[]; rationale: string }[];
  contactPoints: { theme: string; projects: string[]; description: string }[];
  evaluativeDivergence: { signal: string; divergence: string }[];
  reachabilityGaps: { node: string; presentIn: string; absentFrom: string }[];
}

/** Full output from the Gemini cross-source synthesis pass */
export interface SynthesisResult {
  narrativeSummary: string;           // 2-3 paragraph prose overview of findings
  /** One or two sentences about the *pattern of attention* across documents —
   *  what the organisation keeps returning to, not what the documents contain.
   *  The winemaker's opening observation. Null when no coherent pattern emerges. */
  soilNote: string | null;
  termCollisions: TermCollision[];
  connectingThreads: ConnectingThread[];
  signalConvergence: SignalConvergence[];
  graphGaps: GraphGap[];
  /** The single most generative graph gap, surfaced as a traversal invitation */
  invitationQuestion: string | null;
  /** Exact node labels from the graph most relevant to the invitation gap (2–3) */
  invitationNodeNames: string[];
  documentCount: number;              // number of documents read
  generatedAt: string;                // ISO timestamp
}
