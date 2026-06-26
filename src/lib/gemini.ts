/**
 * Gemini API client for TERROIR
 *
 * Wraps Gemini 2.5 Flash for bulk ontology extraction from documents.
 * Uses the same output shape as extract.ts so callers are interchangeable.
 *
 * Gemini is used for:
 *  - Large documents (PDFs, DOCX) where its 1M context window helps
 *  - Batch extraction where cost matters (~10x cheaper than Sonnet)
 *
 * Claude Sonnet stays for the interactive chat loop (tools + conversation).
 */

import type {
  GraphState,
  GraphNode,
  Relationship,
  TensionMarker,
  AbstractionLayer,
  AttractorPreset,
  ProjectBrief,
  SynthesisResult,
  DocumentClassification,
  CompactEntity,
  MergeGroup,
  CrossDocRelationship,
  AttractorReassignment,
  CompactProjectPayload,
  CommonsSynthesisResult,
} from "@/types";
import { v4 as uuidv4 } from "uuid";
import { detectStructuralPatterns } from "@/lib/topology";
import { HUB_RELATIONSHIP_TYPE } from "@/types";
import { ensureTypeExists, getAttractorsForPreset, getHubNodes, getHubMembers, findHubByAttractorId } from "./entity-types";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL   = "gemini-2.5-flash";
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export interface GeminiExtractionResult {
  updatedGraph: GraphState;
  graphUpdates: { type: string; label: string }[];
}

// ── Extraction prompt ────────────────────────────────────────────────────────
//
// Builds an extraction prompt tuned to the project's abstraction layer.
// Three layers correspond to three different "lenses" on the same document:
//
//   domain_objects       — focus on NOUNS: what exists in this org
//   interaction_patterns — focus on VERBS: how work actually moves
//   concerns_themes      — focus on ADJECTIVES: what matters and why
//
// Backwards compatible: no layer = original "extract comprehensively" behaviour.

// ── Canonical relationship vocabulary ────────────────────────────────────────
//
// 17 types + relates_to fallback. Small enough for consistency, large enough
// for organisational ontology. Relationship TYPES are always English.
// Relationship DESCRIPTIONS preserve source language.

const CANONICAL_REL_TYPES = [
  'enables',         // X makes Y possible
  'depends_on',      // X needs Y (soft dependency)
  'requires',        // X cannot function without Y (hard prerequisite)
  'part_of',         // X is contained in Y
  'type_of',         // X is a specialisation of Y
  'implements',      // X is a concrete realisation of Y (method→practice, concept→feature)
  'informs',         // X provides input/context to Y
  'challenges',      // X creates tension with Y
  'addresses',       // X responds to or mitigates Y
  'produces',        // X generates Y as output
  'uses',            // X employs Y as a tool/method
  'guides',          // X shapes or directs Y
  'contrasts_with',  // X is in opposition to Y
  'evolves_into',    // X transforms into Y over time
  'exemplifies',     // X is a concrete instance of Y
  'supports',        // X reinforces or strengthens Y
  'threatens',       // X puts Y at risk
] as const;

const CANONICAL_REL_LIST = CANONICAL_REL_TYPES.join(', ');

// Synonym map — normalises freeform Gemini output to canonical types.
// Covers English variants, German verbs, and legacy multi-word types.
const REL_SYNONYMS: Record<string, string> = {
  // → challenges
  'hinders': 'challenges',
  'blocks': 'challenges',
  'inhibits': 'challenges',
  // → enables
  'drives': 'enables',
  'facilitates': 'enables',
  'fosters': 'enables',
  // → depends_on
  'is_required_for': 'depends_on',
  'prerequisite_for': 'depends_on',
  // → type_of
  'is_a_form_of': 'type_of',
  'is_a_type_of': 'type_of',
  'is_a': 'type_of',
  // → implements
  'is_an_implementation_of': 'implements',
  'is_a_method_for': 'implements',
  'is_a_practice_for': 'implements',
  // → supports
  'contributes_to': 'supports',
  'enhances': 'supports',
  'strengthens': 'supports',
  // → part_of
  'is_a_part_of': 'part_of',
  'is_a_component_of': 'part_of',
  'includes': 'part_of',
  // → produces
  'creates': 'produces',
  'generates': 'produces',
  'is_an_output_of': 'produces',
  // → informs
  'influences': 'informs',
  'feeds_into': 'informs',
  // → guides
  'governs': 'guides',
  'shapes': 'guides',
  // → addresses
  'mitigates': 'addresses',
  'addressed_by': 'addresses',
  'mitigated_by': 'addresses',
  // → uses
  'utilizes': 'uses',
  'leverages': 'uses',
  // → exemplifies
  'demonstrated_by': 'exemplifies',
  'illustrated_by': 'exemplifies',
  // → contrasts_with
  'is_opposed_to': 'contrasts_with',
  'is_distinct_from': 'contrasts_with',
  // German verbs that might leak through
  'ermöglicht': 'enables',
  'erfordert': 'requires',
  'unterstützt': 'supports',
  'bedroht': 'threatens',
  'verwendet': 'uses',
  'erzeugt': 'produces',
};

/** Normalise a relationship type to canonical form. Exported for use in integration routes. */
export function normaliseRelType(raw: string): string {
  const lower = raw.toLowerCase().replace(/\s+/g, '_');
  return REL_SYNONYMS[lower] ?? lower;
}

// ── Entity budget ───────────────────────────────────────────────────────────
//
// Dynamic target based on document length. Prevents over-extraction on
// long documents and under-extraction on short ones.

function estimateEntityBudget(textLength: number): { min: number; max: number } {
  const words = Math.ceil(textLength / 5); // rough word count
  if (words < 1000) return { min: 8, max: 20 };
  if (words < 3000) return { min: 15, max: 35 };
  if (words < 8000) return { min: 20, max: 50 };
  return { min: 25, max: 60 };
}

function buildExtractionPrompt(
  text: string,
  graphState: GraphState,
  abstractionLayer?: AbstractionLayer,
  projectBrief?: ProjectBrief
): string {
  const budget = estimateEntityBudget(text.length);
  // Build the existing-graph context block (dedup guard)
  const existingTensionBlock =
    graphState.tensions.filter((t) => t.status === "unresolved").length > 0
      ? `\n\nExisting unresolved tensions already in the graph (do NOT re-flag these):\n${graphState.tensions
          .filter((t) => t.status === "unresolved")
          .map((t) => `  - ${t.description}`)
          .join("\n")}`
      : "";

  const existingContext =
    graphState.nodes.length > 0
      ? `\n\nExisting entities already in the graph (avoid duplicates, connect to these where relevant):\n${graphState.nodes
          .map((n) => `- "${n.label}" (${n.type}) [id: ${n.id}]`)
          .join(
            "\n"
          )}\n\nExisting entity types: ${graphState.entityTypes.map((t) => t.id).join(", ")}${existingTensionBlock}`
      : "";

  // Build the project context block (when a brief is available)
  const projectContext =
    projectBrief
      ? `\n\nPROJECT CONTEXT (use this to calibrate extraction focus):
- Sector: ${projectBrief.sector ?? "not specified"}
- Org size: ${projectBrief.orgSize ?? "not specified"}
- Discovery goal: ${projectBrief.discoveryGoal ?? "not specified"}
- Key themes to watch for: ${(projectBrief.keyThemes ?? []).join(", ") || "none"}`
      : "";

  // ── Abstraction-layer-specific extraction instructions ──────────────────────

  let focusInstructions: string;

  switch (abstractionLayer) {
    case "domain_objects":
      focusInstructions = `ABSTRACTION LAYER: Domain Objects (nouns)
Your focus is on WHAT EXISTS in this organisation.

Extract:
1. ENTITIES — systems, tools, platforms, teams, roles, documents, products, processes, standards. Prioritise concrete things over abstract concepts.
2. OWNERSHIP / MEMBERSHIP — who owns, uses, or is responsible for what.
3. DEPENDENCIES — what needs what to function.
4. TENSIONS — conflicting ownership, duplicate tools, unclear accountability.
5. EVALUATIVE SIGNALS — what the org values or fears losing.

Entity types should be noun-oriented: system, team, role, document, platform, product, standard, etc.`;
      break;

    case "interaction_patterns":
      focusInstructions = `ABSTRACTION LAYER: Interaction Patterns (verbs)
Your focus is on HOW WORK ACTUALLY MOVES in this organisation.

Extract:
1. WORKFLOWS — named processes, recurring flows, sequences of steps.
2. HANDOFFS — who passes what to whom, and under what conditions.
3. COMMUNICATION PATHS — how information travels, sync vs async, channels used.
4. DEPENDENCIES — what blocks what, what gates what, who needs what from whom.
5. TENSIONS — bottlenecks, broken handoffs, unclear ownership of transitions.
6. EVALUATIVE SIGNALS — what people value or fear about how work moves.

Entity types should be verb-oriented: workflow, handoff, communication, dependency, gate, blocker, channel, etc.`;
      break;

    case "concerns_themes":
      focusInstructions = `ABSTRACTION LAYER: Concerns and Themes (adjectives / values)
Your focus is on WHAT MATTERS AND WHY in this organisation.

Extract:
1. VALUES — what the organisation or individuals explicitly care about protecting or achieving.
2. TENSIONS — competing values, strategic contradictions, cultural friction.
3. THEMES — recurring concerns, shared anxieties, strategic priorities.
4. SIGNALS — things people are moving toward or away from.
5. STAKES — what people believe is at risk, what they're trying to preserve.

Entity types should be value/theme-oriented: value, concern, tension, theme, priority, risk, aspiration, etc.
Focus on the evaluative layer — what things mean to people, not just what they are.`;
      break;

    default:
      // Original behaviour — extract comprehensively across all layers
      focusInstructions = `Your task:
1. FIND all meaningful entities (concepts, organisations, platforms, processes, roles, documents, goals, values, products, etc.)
2. CLASSIFY each with an appropriate type. Types are emergent — use what fits the domain. Reuse existing types where appropriate.
3. RELATE entities to each other with descriptive relationship types.
4. FLAG tensions or conflicts between entities.
5. NOTE evaluative signals — what the organisation values, fears, or is moving toward.

Extract COMPREHENSIVELY — capture every meaningful entity and relationship.`;
  }

  // Build hub instruction block — tell Gemini about available hubs
  const hubNodes = getHubNodes(graphState);
  let hubInstructions: string;

  if (hubNodes.length > 0) {
    // Use actual hub nodes from the graph, enriched with existing member labels
    // so Gemini can learn classification patterns from prior extractions
    const hubList = hubNodes
      .map((h) => {
        const slug = h.properties?.attractor_id ?? h.label.toLowerCase();
        const members = getHubMembers(h.id, graphState);
        const memberSuffix = members.length > 0
          ? `. Already contains: ${members.slice(-5).map((m) => m.label).join(", ")}`
          : "";
        return `  - "${slug}" (hub: "${h.label}") — ${h.description}${memberSuffix}`;
      })
      .join("\n");
    hubInstructions = `
HUB CATEGORIES (structural scaffolding — these are real nodes in the graph):
Each entity MUST be assigned a "hub" from this list using the EXACT slug value shown. Do NOT invent new hub categories. Choose the BEST-FITTING hub based on the entity's primary role in the organisation. Use "emergent" ONLY for entities that genuinely don't fit any category — it signals novelty, not uncertainty. If you can make a reasonable case for a hub, use it.
${hubList}

The "hub" field MUST be one of the exact slug values listed above. Any other value will be remapped to "emergent".
The "type" field is a separate freeform descriptive tag (e.g. "concept", "role", "workflow"). Both fields are required.`;
  } else {
    // Fallback: use preset config (for projects without seeded hubs yet)
    const preset = (projectBrief as unknown as Record<string, unknown>)?.attractorPreset as AttractorPreset | undefined;
    const attractors = getAttractorsForPreset(preset ?? 'startup');
    const attractorList = attractors
      .map((a) => `  - "${a.id}" — ${a.description}`)
      .join("\n");
    hubInstructions = `
HUB CATEGORIES (structural scaffolding):
Each entity MUST be assigned a "hub" from this list using the EXACT slug value shown. Do NOT invent new hub categories. Choose the BEST-FITTING hub based on the entity's primary role in the organisation. Use "emergent" ONLY for entities that genuinely don't fit any category — it signals novelty, not uncertainty. If you can make a reasonable case for a hub, use it.
${attractorList}

The "hub" field MUST be one of the exact slug values listed above. Any other value will be remapped to "emergent".
The "type" field is a separate freeform descriptive tag (e.g. "concept", "role", "workflow"). Both fields are required.`;
  }

  return `You are TERROIR's extraction engine. Extract a structured knowledge graph from the document below.

${focusInstructions}
${hubInstructions}

GRANULARITY RULES:
- Extract at the CONCEPT level, not the MENTION level. If a document mentions Slack, Teams, and Email as communication channels, create ONE entity "Communication Stack" with the specific tools listed in the description — not three separate entities.
- Each entity should represent a meaningful unit of organisational knowledge that someone would want to navigate to, ask about, or track over time. If it is just an example or instance of something, it belongs in a parent entity's description, not as its own node.
- TARGET: extract between ${budget.min} and ${budget.max} entities for this document. If you are producing more, you are too granular. Quality over quantity.
- Prefer FEWER entities with RICHER descriptions over many thin entities.
- When in doubt, ask: "Would someone search for this entity by name?" If no, fold it into a parent entity's description.

RELATIONSHIP TYPES — use ONLY from this canonical list:
${CANONICAL_REL_LIST}
Choose the closest match. Use lowercase only. If none fit, use "relates_to" as a last resort — this should be rare (<10% of edges).
The "description" field on the relationship is where nuance goes — the type is for traversal, the description is for understanding.

LANGUAGE CONSISTENCY (critical — do not mix languages):
- Detect the primary language of the source document.
- ALL entity labels, types, and descriptions MUST be in that same language. If the document is in German, output German. If in English, output English. Do NOT mix languages.
- Relationship TYPES must always be English (from the canonical list above).
- Relationship DESCRIPTIONS should match the source document language.
- Hub values are always English slugs (from the list above) — these are structural IDs, not labels.

CRITICAL: Do NOT create duplicate entities. Check the existing graph context below.
${existingContext}${projectContext}

Respond with valid JSON ONLY — no markdown, no code blocks:
{
  "entities": [
    { "label": "string", "type": "string", "hub": "string", "description": "string" }
  ],
  "relationships": [
    { "source_label": "string", "target_label": "string", "type": "string", "description": "string" }
  ],
  "tensions": [
    { "description": "string", "related_labels": ["string"] }
  ],
  "evaluative_signals": [
    {
      "label": "string",
      "direction": "toward|away_from|protecting",
      "intensity": 1,
      "threshold_proximity": 1,
      "at_cost_of": "string",
      "temporal_horizon": "operational|tactical|strategic|foundational",
      "related_entity_labels": ["string"],
      "source": "string"
    }
  ]
}

GRADIENT SIGNAL RULES:

What counts as a gradient signal:
A gradient is a directional pressure in the organisation's evaluative field. It has a direction (toward / away from / protecting), a magnitude (how strongly expressed), a threshold it is approaching (stability, collapse, or transition), and a cost (what is being traded off or given up). If a candidate cannot answer all four, it is not a gradient — it is an aspirational phrase. Do not extract it.

Hard limits:
- Extract AT MOST 2 gradients per document. Many documents should return ZERO — that is correct. A document with no real stakes has no gradients.
- A gradient must name what is at risk, at whose cost, or under what pressure. A statement of values without stakes is not a gradient.

Exclusions (do NOT extract):
- Mission-statement phrasing ("we value quality", "we believe in transparency")
- Organisational virtues stated without friction or trade-off
- Aspirational language without a threshold or cost ("we aim to be the best", "we are customer-first")
- Anything that could be copied unchanged onto another organisation's website
- Generic industry values ("data-driven", "agile", "innovative")

Required for every gradient:
- "label" — a directional statement, 6–15 words, in one of these grammars:
    · "Moving toward X, at the cost of Y"
    · "Protecting X from erosion by Y"
    · "Pulling away from X, opening exposure to Y"
    · "Holding the line on X under pressure from Y"
  The label must be self-contained: a reader who hasn't seen the document should understand both what is moving and what is being traded off.
- "direction" — toward | away_from | protecting
- "intensity" — 1 (faintly expressed) to 5 (repeatedly and forcefully expressed with multiple reinforcing passages)
- "threshold_proximity" — 1 (stable, far from any tipping point) to 5 (on the edge, one event away from flipping). If no threshold can be located, set to 1.
- "at_cost_of" — a short phrase naming what is given up, risked, or eroded by this gradient's direction. Required. If nothing is at cost, it is not a gradient.
- "temporal_horizon" — operational (days-weeks) | tactical (weeks-months) | strategic (months-years) | foundational (ongoing identity)
- "related_entity_labels" — the entities from this extraction that this gradient pulls on. At least one.
- "source" — the specific passage (1–2 sentences max) that revealed this gradient. Must be quoted or closely paraphrased from the document.

Test each candidate with these three questions. If any answer is "no," do not extract:
1. Can I name what is being moved toward or protected?
2. Can I name what is being given up as a consequence?
3. Can I name a threshold — even roughly — that this gradient is approaching or sitting against?

GOLD-STANDARD EXAMPLES (from a 2-person AI logistics startup context — adapt grammar and domain to the actual document):

Example 1 — Cost ceiling gradient:
{
  "label": "Moving toward deeper fleet integration, at the cost of onboarding speed",
  "direction": "toward",
  "intensity": 4,
  "threshold_proximity": 3,
  "at_cost_of": "rapid pilot-to-production timelines; fleet managers tolerate 2 weeks of friction but not 2 months",
  "temporal_horizon": "tactical",
  "related_entity_labels": ["Fleet Integration Layer", "Pilot Onboarding Flow"],
  "source": "Operations lead said they could absorb two weeks of onboarding friction; beyond that the internal case for staying with the current tooling wins by default."
}

Example 2 — Sacred value gradient:
{
  "label": "Protecting driver data sovereignty from erosion by cloud-hosted location services",
  "direction": "protecting",
  "intensity": 5,
  "threshold_proximity": 5,
  "at_cost_of": "performance gains from centralised model training and any cloud-native analytics",
  "temporal_horizon": "foundational",
  "related_entity_labels": ["Driver Location Data", "On-Prem Deployment"],
  "source": "Any cloud-hosted driver location data will kill the deal regardless of performance gains — stated three separate times, once with a hand slap on the table."
}

Example 3 — Trust erosion gradient:
{
  "label": "Pulling away from automated dispatch, opening exposure to shipper trust collapse",
  "direction": "away_from",
  "intensity": 3,
  "threshold_proximity": 4,
  "at_cost_of": "efficiency gains from full automation; decision support with explainable handoff is the fallback",
  "temporal_horizon": "strategic",
  "related_entity_labels": ["Automated Dispatch", "Shipper Trust"],
  "source": "Shipper trust in AI-generated dispatch erodes after a single wrong routing call. It isn't cumulative — one strike and the dispatcher is cut out of the decision loop."
}

Example 4 — Permission gradient:
{
  "label": "Holding the line on fleet-manager autonomy under pressure from procurement oversight",
  "direction": "protecting",
  "intensity": 4,
  "threshold_proximity": 3,
  "at_cost_of": "speed of adoption above €15k/month — larger commitments drop into a 6-week legal cycle",
  "temporal_horizon": "tactical",
  "related_entity_labels": ["Fleet Manager Role", "Procurement Review Process"],
  "source": "Fleet managers can authorise new tooling up to €15k/month without procurement; anything above triggers a six-week review that kills momentum."
}

Counter-example — DO NOT extract this (declared value without stakes):
{ "label": "Commitment to data-driven decision making" }
Reason: no direction, no cost, no threshold, no stakes. Mission-statement phrase, not a gradient.

Counter-example — DO NOT extract this (concern without cost):
{ "label": "Ethical AI practices are important to the team" }
Reason: no trade-off named. Protecting ethical practices from what? At the cost of what? Without answers, it is aspiration, not gradient.

Final check:
Before writing any gradient, re-read your candidate against the three test questions above. If you cannot answer all three from the source passage, leave it out. An empty evaluative_signals array is a valid and often correct answer.

TENSION RULES:

What counts as a tension:
A tension is a genuine structural conflict between two or more entities that cannot both be fully satisfied simultaneously — not a challenge, a preference difference, or a solvable coordination problem. Both sides must be active and pulling against each other right now. If the conflict could be resolved by a single decision, a meeting, or more resources, it is not a tension — it is a problem. Tensions persist even when everyone agrees they exist.

Hard limits:
- Extract AT MOST 1 tension per document. Most documents should return ZERO — that is the correct answer for documents without active structural conflict.
- Do NOT re-flag a tension already listed in the existing graph context above. If the same conflict reappears in a new document, it reinforces an existing tension, not a new one.
- Do NOT extract a tension just because two entities have a "challenges" relationship — that relationship already captures friction. A tension must be more fundamental than a single edge.

Exclusions (do NOT extract):
- Disagreements that are acknowledged and being actively resolved
- Tradeoffs the organisation has already decided (choosing A over B is a decision, not a tension)
- Minor friction between roles or teams with no structural consequence
- Anything that could be fixed by clearer communication, a process change, or a meeting
- Concerns, risks, or problems — these are different from tensions

Required for a tension:
- "description" — one sentence naming BOTH sides of the conflict and why satisfying one undermines the other. Format: "[Entity A] pulls toward [X], while [Entity B] requires [Y] — both cannot be fully satisfied without compromising the other." Must be specific to this organisation; should not be copy-pasteable onto a generic company.
- "related_labels" — the two (or occasionally three) entities that are in direct conflict. Name the specific entities from this extraction or from the existing graph.

Test each candidate with these two questions. If either answer is "no," do not extract:
1. If this organisation solved everything else, would this conflict still exist?
2. Can I name the specific mechanism by which satisfying one side damages the other?

DOCUMENT:
${text}`;
}

// ── Gemini REST call ─────────────────────────────────────────────────────────

async function callGemini(prompt: string, maxOutputTokens = 32768, useJsonMode = true, disableThinking = false): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");

  const generationConfig: Record<string, unknown> = {
    temperature: 0.1,
    maxOutputTokens,
  };
  if (useJsonMode) generationConfig.responseMimeType = "application/json";
  if (disableThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig,
  };

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty response from Gemini");
  return text;
}

// Strip markdown code fences if Gemini wraps JSON in ```json ... ```
function stripJsonFences(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : raw.trim();
}

// ── Graph assembly (mirrors extract.ts logic) ────────────────────────────────

function assembleGraph(
  extracted: {
    entities?: { label: string; type: string; hub?: string; attractor?: string; description: string }[];
    relationships?: { source_label: string; target_label: string; type: string; description?: string }[];
    tensions?: { description: string; related_labels: string[] }[];
    evaluative_signals?: { label: string; direction: string; strength?: number; intensity?: number; threshold_proximity?: number; at_cost_of?: string; source: string; temporal_horizon?: string; related_entity_labels?: string[] }[];
  },
  graphState: GraphState
): GeminiExtractionResult {
  let currentGraph = structuredClone(graphState);
  const updates: { type: string; label: string }[] = [];

  // Build label→id map from existing nodes
  const labelToId: Record<string, string> = {};
  for (const node of currentGraph.nodes) {
    labelToId[node.label.toLowerCase()] = node.id;
  }

  // Create entities with hub relationships
  let col = 0, row = 0;
  for (const entity of extracted.entities ?? []) {
    if (!entity.label) continue;
    const existingId = labelToId[entity.label.toLowerCase()];
    if (existingId) continue; // dedup

    const id = uuidv4();
    const position = { x: 150 + col * 250, y: 250 + row * 200 }; // y=250 to leave room for hub row
    col++;
    if (col >= 4) { col = 0; row++; }

    // Resolve hub: Gemini returns "hub" field (or legacy "attractor").
    // Fall back to emergent hub if the slug doesn't match any hub node,
    // preventing orphaned nodes with no belongs_to_hub relationship.
    const hubSlug = entity.hub || entity.attractor || "emergent";
    let hubNode = findHubByAttractorId(hubSlug, currentGraph);
    if (!hubNode && hubSlug !== "emergent") {
      console.warn(`[gemini] Hub slug "${hubSlug}" not found for entity "${entity.label}" — remapping to emergent`);
      hubNode = findHubByAttractorId("emergent", currentGraph);
    }

    // Cache the resolved attractor — if we fell back to emergent, reflect that
    const resolvedAttractor = hubNode?.properties?.attractor_id ?? (hubNode ? hubSlug : "emergent");
    const node: GraphNode = {
      id,
      label: entity.label,
      type: (entity.type || "concept").toLowerCase(), // normalize casing to prevent duplicates like Aspiration/aspiration
      attractor: resolvedAttractor,
      description: entity.description || "",
      position,
    };

    // Add node
    currentGraph = {
      ...currentGraph,
      nodes: [...currentGraph.nodes, node],
      entityTypes: ensureTypeExists(currentGraph.entityTypes, node.type),
    };

    // Create belongs_to_hub relationship if hub exists
    if (hubNode) {
      const hubRel: Relationship = {
        id: uuidv4(),
        sourceId: id,
        targetId: hubNode.id,
        type: HUB_RELATIONSHIP_TYPE,
      };
      currentGraph = {
        ...currentGraph,
        relationships: [...currentGraph.relationships, hubRel],
      };
    }

    labelToId[entity.label.toLowerCase()] = id;
    updates.push({ type: "node_created", label: entity.label });
  }

  // Create relationships
  for (const rel of extracted.relationships ?? []) {
    const sourceId = rel.source_label ? labelToId[rel.source_label.toLowerCase()] : undefined;
    const targetId = rel.target_label ? labelToId[rel.target_label.toLowerCase()] : undefined;
    if (!sourceId || !targetId) continue;

    const relationship: Relationship = {
      id: uuidv4(),
      sourceId,
      targetId,
      type: normaliseRelType(rel.type || "relates_to"),
      description: rel.description,
    };

    currentGraph = {
      ...currentGraph,
      relationships: [...currentGraph.relationships, relationship],
    };
    updates.push({ type: "relationship_created", label: `${rel.source_label} → ${rel.target_label}` });
  }

  // Create tensions
  for (const t of extracted.tensions ?? []) {
    const relatedIds = (t.related_labels ?? [])
      .map((label) => labelToId[label?.toLowerCase()])
      .filter(Boolean) as string[];

    if (relatedIds.length > 0) {
      const tension: TensionMarker = {
        id: uuidv4(),
        description: t.description,
        relatedNodeIds: relatedIds,
        status: "unresolved",
      };
      currentGraph = { ...currentGraph, tensions: [...currentGraph.tensions, tension] };
      updates.push({ type: "tension_flagged", label: t.description });
    }
  }

  // Create evaluative signals (dedup by label)
  for (const s of extracted.evaluative_signals ?? []) {
    if (!s.label) continue;
    const existing = currentGraph.evaluativeSignals.find(
      (e) => e.label.toLowerCase() === s.label.toLowerCase()
    );
    if (!existing) {
      // Resolve related entity labels to node IDs
      const relatedNodeIds = (s.related_entity_labels ?? [])
        .map((label: string) => labelToId[label?.toLowerCase()])
        .filter(Boolean) as string[];

      // Normalise intensity: new extractions supply `intensity`; legacy extractions supply `strength`.
      const resolvedIntensity = Math.round(s.intensity ?? s.strength ?? 3);
      currentGraph = {
        ...currentGraph,
        evaluativeSignals: [
          ...currentGraph.evaluativeSignals,
          {
            id: uuidv4(),
            label: s.label,
            direction: (s.direction as "toward" | "away_from" | "protecting") || "toward",
            strength: resolvedIntensity,
            intensity: resolvedIntensity,
            thresholdProximity: s.threshold_proximity ?? null,
            atCostOf: s.at_cost_of ?? null,
            sourceDescription: s.source || "Extracted from document",
            temporalHorizon: s.temporal_horizon as "operational" | "tactical" | "strategic" | "foundational" | undefined,
            ...(relatedNodeIds.length > 0 ? { relatedNodeIds } : {}),
          },
        ],
      };
      updates.push({ type: "evaluative_signal_set", label: s.label });
    }
  }

  return { updatedGraph: currentGraph, graphUpdates: updates };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Extracts an ontology from document text using Gemini 2.5 Flash.
 *
 * @param text            Raw document text to extract from
 * @param graphState      Current graph state (for dedup context)
 * @param abstractionLayer Optional lens: domain_objects | interaction_patterns | concerns_themes
 * @param projectBrief    Optional project brief for calibrating extraction focus
 *
 * Backwards compatible: omit abstractionLayer to use the original
 * "extract comprehensively" behaviour.
 */
export async function extractOntologyWithGemini(
  text: string,
  graphState: GraphState,
  abstractionLayer?: AbstractionLayer,
  projectBrief?: ProjectBrief
): Promise<GeminiExtractionResult> {
  const prompt = buildExtractionPrompt(text, graphState, abstractionLayer, projectBrief);
  // Disable thinking for extraction: Gemini 2.5 Flash thinking mode is slow and
  // unreliable for structured JSON output on long documents. Thinking disabled =
  // faster responses (3-8s vs 30-90s) and consistent JSON output.
  const raw = await callGemini(prompt, 32768, false, true);
  const rawJson = stripJsonFences(raw);

  let extracted;
  try {
    extracted = JSON.parse(rawJson);
  } catch {
    console.error("[extract] Gemini returned unparseable response. First 500 chars:", rawJson.slice(0, 500));
    return { updatedGraph: graphState, graphUpdates: [] };
  }

  // Guard against empty response (e.g. {} or {"entities":[]})
  const entityCount = (extracted.entities ?? []).length;
  if (entityCount === 0) {
    console.warn("[extract] Gemini returned 0 entities. Raw response (first 500 chars):", rawJson.slice(0, 500));
  }

  return assembleGraph(extracted, graphState);
}

// ── Document classification ──────────────────────────────────────────────────
//
// Pre-classification step: Gemini evaluates each document and assigns a verdict
// (EXTRACT, CAUTION, SKIP) based on genre and content quality. Batch call —
// all documents classified in a single Gemini request.

function buildClassificationPrompt(
  documents: { index: number; title: string; preview: string }[],
  brief?: ProjectBrief
): string {
  const briefSection = brief
    ? `PROJECT CONTEXT:
- Sector: ${brief.sector ?? "not specified"}
- Org size: ${brief.orgSize ?? "not specified"}
- Discovery goal: ${brief.discoveryGoal ?? "not specified"}
- Key themes: ${(brief.keyThemes ?? []).join(", ") || "none"}
- Abstraction layer: ${brief.abstractionLayer}`
    : "";

  const docList = documents
    .map((d) => `--- DOCUMENT ${d.index}: "${d.title}" ---\n${d.preview}`)
    .join("\n\n");

  return `You are TERROIR's document classifier. Evaluate each document and decide whether it should be EXTRACTED into the knowledge graph, treated with CAUTION, or SKIPPED entirely.

${briefSection}

CLASSIFICATION RULES:

EXTRACT — high value for organisational intelligence:
- Process documentation, SOPs, strategy documents
- Interview transcripts, meeting notes, workshop outputs
- Org charts, team structures, role descriptions
- Content describing workflows, handoffs, dependencies, decisions
- Content revealing values, tensions, fears, or strategic priorities
- Partner/professional portal content showing operational relationships

CAUTION — may contain useful signals but is heavily curated:
- Marketing materials, press releases, annual reports
- Product catalogues (useful for domain vocabulary, not relationships)
- About/mission pages (aspirational, not necessarily operational)

SKIP — noise that pollutes the graph:
- Legal boilerplate: terms and conditions, cookie policies, privacy notices
- DSGVO/GDPR compliance text, liability disclaimers, IP notices
- Navigation artefacts: menus, footers, breadcrumbs, button labels, login pages
- Generic compliance text (identifiable by: passive voice, enumerated clauses, regulatory citations)

Also check for DUPLICATES — documents with the same or near-identical content under different names.

DOCUMENTS TO CLASSIFY (${documents.length} total):
${docList}

Return valid JSON — no markdown, no code blocks:
{
  "classifications": [
    {
      "documentIndex": number,
      "title": "string",
      "verdict": "EXTRACT" | "CAUTION" | "SKIP",
      "genre": "string (e.g. legal, marketing, operational, interview, compliance, navigation)",
      "confidence": number (0-1),
      "reason": "one sentence explaining why",
      "isDuplicate": boolean,
      "duplicateOf": "string or null"
    }
  ]
}`;
}

/**
 * Batch-classifies documents before extraction using Gemini.
 *
 * Sends document titles + first ~2000 chars as previews in a single call.
 * Gemini's 1M context handles large batches natively.
 *
 * @param documents  Array of { index, title, preview } — preview is first ~2000 chars
 * @param brief      Optional project brief for context (sector, goal, themes)
 * @returns          Array of classifications (one per document)
 */
export async function classifyDocuments(
  documents: { index: number; title: string; preview: string }[],
  brief?: ProjectBrief
): Promise<DocumentClassification[]> {
  if (documents.length === 0) return [];

  const prompt  = buildClassificationPrompt(documents, brief);
  const rawJson = await callGemini(prompt, 8192);

  let parsed: { classifications: DocumentClassification[] };
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    console.error("[classify] Gemini returned invalid JSON:", rawJson.slice(0, 200));
    // Fallback: classify everything as EXTRACT (safe default — current behaviour)
    return documents.map((d) => ({
      documentIndex: d.index,
      title:         d.title,
      verdict:       "EXTRACT" as const,
      genre:         "unknown",
      confidence:    0,
      reason:        "Classification failed — defaulting to extract",
    }));
  }

  return parsed.classifications ?? [];
}

// ── Synthesis prompt ──────────────────────────────────────────────────────────
//
// Sends the full document corpus + graph state to Gemini in a single call.
// Gemini's 1M context window handles large corpora natively — no chunking,
// no pre-summarisation, no context guard needed.

function buildSynthesisPrompt(
  graphState: GraphState,
  documents: { id: string; title: string; content: string }[],
  brief?: ProjectBrief
): string {
  const briefSection = brief
    ? `PROJECT BRIEF:
  Sector: ${brief.sector ?? "not specified"}
  Org size: ${brief.orgSize ?? "not specified"}
  Discovery goal: ${brief.discoveryGoal ?? "not specified"}
  Abstraction layer: ${brief.abstractionLayer}
  Key themes: ${(brief.keyThemes ?? []).join(", ") || "none"}
  Summary: ${brief.summary ?? "none"}`
    : "PROJECT BRIEF: not set (general extraction mode)";

  const graphSection = [
    `EXISTING KNOWLEDGE GRAPH:`,
    `Nodes (${graphState.nodes.length}):`,
    ...graphState.nodes.map((n) => `  - "${n.label}" [${n.type}]: ${n.description}`),
    "",
    `Relationships (${graphState.relationships.length}):`,
    ...graphState.relationships.map((r) => {
      const src = graphState.nodes.find((n) => n.id === r.sourceId)?.label ?? r.sourceId;
      const tgt = graphState.nodes.find((n) => n.id === r.targetId)?.label ?? r.targetId;
      return `  - "${src}" ${r.type} "${tgt}"`;
    }),
    "",
    `Unresolved tensions (${graphState.tensions.filter((t) => t.status === "unresolved").length}):`,
    ...graphState.tensions
      .filter((t) => t.status === "unresolved")
      .map((t) => `  - ${t.description}`),
    "",
    `Evaluative signals (${graphState.evaluativeSignals.length}):`,
    ...graphState.evaluativeSignals.map(
      (s) => `  - "${s.label}" (${s.direction}, strength: ${s.strength}/5)`
    ),
  ].join("\n");

  const docSections = documents
    .map((doc, i) => `--- DOCUMENT ${i + 1}: "${doc.title}" ---\n${doc.content}`)
    .join("\n\n");

  return `You are TERROIR's winemaker — a synthesis presence for organisational listening.

Your job is not to analyse these documents. It is to listen to them.

A winemaker does not impose a formula on the soil. They attend to what is already happening — the accumulated seasons of practice, the tensions that don't resolve, the intelligence that is irreducibly local. You do the same with this organisation's documents.

After reading across all ${documents.length} documents and the graph, you will surface cross-source patterns. But before you do, you will step back and ask: what does this organisation keep returning to? What does the pattern of what was brought to this graph reveal about where they are in their own understanding? That observation — the soil_note — leads everything.

${briefSection}

${graphSection}

DOCUMENTS TO SYNTHESISE (${documents.length} sources):
${docSections}

YOUR TASKS:

1. SOIL NOTE — before mapping anything, read the pattern of attention across all documents. What is this organisation consistently circling? What does that reveal about where they are in their own understanding? One or two quiet sentences. This is the most important output. Return null only if genuinely nothing coherent emerges — do not default to null.

2. TERM COLLISIONS — the same concept called different names across sources. Suggest a canonical term.

3. CONNECTING THREADS — recurring themes or structural patterns that span multiple sources.

4. SIGNAL CONVERGENCE — places where sources agree or disagree on something evaluative (values, fears, priorities).

5. GRAPH GAPS — meaningful concepts in the documents but absent or underrepresented in the graph. Identify ALL gaps in the graphGaps array. Then, from those gaps, select the single most generative one — the gap whose exploration would move the organisation's understanding furthest — and surface it as the invitation. Provide: (a) a question the consultant should ask, (b) the names of 2–3 existing graph nodes most relevant to that gap (use exact node labels from the graph above).

Return valid JSON matching this schema exactly — no markdown, no code blocks:
{
  "narrativeSummary": "string — 2-3 paragraphs describing the key cross-source findings",
  "soilNote": "string | null — one or two sentences about what the pattern of documents reveals about this organisation's attention right now. Not about content — about attention.",
  "termCollisions": [
    { "variants": ["string"], "sources": ["document title"], "suggestedCanonical": "string", "context": "string" }
  ],
  "connectingThreads": [
    { "theme": "string", "description": "string", "relatedSources": ["document title"], "relatedNodeIds": ["string"] }
  ],
  "signalConvergence": [
    { "signal": "string", "convergenceType": "agreement|disagreement|partial", "sources": ["document title"], "description": "string" }
  ],
  "graphGaps": [
    { "description": "string", "suggestedQuestion": "string", "relatedNodeIds": ["string"] }
  ],
  "invitationQuestion": "string | null — one question surfacing the most generative graph gap",
  "invitationNodeNames": ["string — exact node label from the graph"]
}`;
}

/**
 * Runs cross-source synthesis across all documents using Gemini 2.5 Flash.
 *
 * Gemini's 1M token context window handles large corpora natively — no
 * chunking, pre-summarisation, or context guard needed. Replaces the
 * former Haiku synthesis which failed at scale (>10 documents).
 *
 * @param graphState  Current in-memory graph (nodes, relationships, tensions, signals)
 * @param documents   All project documents with their full text content
 * @param brief       Optional project brief for calibrating synthesis focus
 */
export async function runGeminiSynthesis(
  graphState: GraphState,
  documents: { id: string; title: string; content: string }[],
  brief?: ProjectBrief
): Promise<SynthesisResult> {
  if (documents.length === 0) {
    throw new Error("[gemini] Cannot synthesise: no documents provided");
  }

  const prompt  = buildSynthesisPrompt(graphState, documents, brief);
  // 32k output tokens — synthesis across 44 docs may produce substantial JSON
  const rawJson = await callGemini(prompt, 32768);

  let parsed: Omit<SynthesisResult, "documentCount" | "generatedAt">;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    console.error("[gemini] Synthesis returned invalid JSON:", rawJson.slice(0, 300));
    parsed = {
      narrativeSummary:    "Synthesis could not be parsed. Please try again — the model may have returned malformed output.",
      soilNote:            null,
      termCollisions:      [],
      connectingThreads:   [],
      signalConvergence:   [],
      graphGaps:           [],
      invitationQuestion:  null,
      invitationNodeNames: [],
    };
  }

  return {
    ...parsed,
    documentCount: documents.length,
    generatedAt:   new Date().toISOString(),
  };
}

// ── Cross-document integration ────────────────────────────────────────────────
//
// After all documents in a batch are extracted, this pass looks across the full
// entity set to:
//   1. Merge near-duplicate entities from different documents
//   2. Generate relationships between entities that span documents
//   3. Correct attractor assignments that were wrong in per-document isolation
//
// Thinking is disabled — same rationale as extraction. Faster, consistent JSON.

function buildIntegrationPrompt(
  entities: CompactEntity[],
  compactRels: { sourceLabel: string; targetLabel: string; type: string }[],
  projectBrief?: ProjectBrief
): string {
  const preset = (projectBrief as unknown as Record<string, unknown>)?.attractorPreset as AttractorPreset | undefined;
  const attractors = getAttractorsForPreset(preset ?? "startup");
  const attractorList = attractors.map((a) => `  - "${a.id}" — ${a.description}`).join("\n");

  const briefSection = projectBrief
    ? `PROJECT CONTEXT:
- Sector: ${projectBrief.sector ?? "not specified"}
- Org size: ${projectBrief.orgSize ?? "not specified"}
- Discovery goal: ${projectBrief.discoveryGoal ?? "not specified"}
- Key themes: ${(projectBrief.keyThemes ?? []).join(", ") || "none"}`
    : "";

  // Compact entity list — id is essential so Gemini can reference it in outputs
  const entityJson = JSON.stringify(entities, null, 0);

  // Compact relationship list — labels only, for readability
  const relLines = compactRels
    .slice(0, 2000) // cap at 2000 rels to stay within context
    .map((r) => `${r.sourceLabel} —[${r.type}]→ ${r.targetLabel}`)
    .join("\n");

  return `You are TERROIR's cross-document integration engine. You have been given the complete entity set extracted from multiple source documents. Your job is to integrate these entities into a coherent, well-connected knowledge graph.

${briefSection}

ATTRACTOR CATEGORIES:
${attractorList}

CURRENT ENTITIES (${entities.length} total):
${entityJson}

EXISTING RELATIONSHIPS (${compactRels.length} total):
${relLines}

YOUR THREE TASKS:

### Phase 1: Entity Merges
Identify entities that refer to the same concept but were extracted from different documents with slightly different wording or framing. Only merge if you are confident — do not merge entities that are genuinely distinct.

For each merge group output:
- canonicalLabel: the best unified label
- canonicalDescription: a combined description (2-3 sentences max)
- entityIdsToMerge: array of entity IDs from the list above (minimum 2, must be valid IDs from the list)

### Phase 2: Cross-Document Relationships
Identify the most important relationships between entities that are NOT already connected. Focus on:
- Entities from different attractor categories that are clearly related
- Entities that share themes but have no path between them
- Do NOT recreate existing relationships
- Generate at most ${Math.min(Math.ceil(compactRels.length * 3), 200)} new relationships (quality over quantity)

For each new relationship output:
- sourceEntityId: valid entity ID from the list above
- targetEntityId: valid entity ID from the list above
- type: use ONLY from this canonical list: ${CANONICAL_REL_LIST}. Use "relates_to" only as a last resort (<10% of edges). Always lowercase English.
- description: optional one sentence (may be in the source language)

### Phase 3: Attractor Reassignment
Now that you can see all entities together, identify any entities whose attractor was assigned incorrectly in per-document isolation. Only reassign where you are confident.

For each reassignment output:
- entityId: valid entity ID from the list above
- oldAttractor: current value
- newAttractor: corrected value from the attractor categories above
- reason: one sentence

Respond with a single JSON object — no markdown, no code blocks:
{
  "mergeGroups": [
    { "canonicalLabel": "string", "canonicalDescription": "string", "entityIdsToMerge": ["id1", "id2"] }
  ],
  "newRelationships": [
    { "sourceEntityId": "string", "targetEntityId": "string", "type": "string", "description": "string" }
  ],
  "reassignments": [
    { "entityId": "string", "oldAttractor": "string", "newAttractor": "string", "reason": "string" }
  ]
}`;
}

export interface IntegrationOutput {
  mergeGroups:      MergeGroup[];
  newRelationships: CrossDocRelationship[];
  reassignments:    AttractorReassignment[];
}

// ── Signal deduplication ──────────────────────────────────────────────────────
//
// Reviews all evaluative signals and groups near-duplicates into merge groups.
// Gemini picks a canonical label + richer description for each cluster.
// Thinking disabled — same rationale as extraction (faster, consistent JSON).

export interface SignalMergeGroup {
  canonicalLabel:       string;
  canonicalDescription: string;
  canonicalDirection:   "toward" | "away_from" | "protecting";
  signalIdsToMerge:     string[];
}

function buildSignalDeduplicationPrompt(
  signals: import("@/types").EvaluativeSignal[],
  projectBrief?: ProjectBrief
): string {
  const briefSection = projectBrief
    ? `PROJECT CONTEXT:
- Sector: ${projectBrief.sector ?? "not specified"}
- Org size: ${projectBrief.orgSize ?? "not specified"}
- Discovery goal: ${projectBrief.discoveryGoal ?? "not specified"}`
    : "";

  const signalList = JSON.stringify(
    signals.map((s) => ({
      id:     s.id,
      label:  s.label,
      dir:    s.direction,
      str:    s.strength,
      source: s.sourceDescription?.slice(0, 80) ?? "",
    })),
    null, 0
  );

  return `You are TERROIR's signal deduplication engine. Review the evaluative signals below and identify groups of signals that refer to the same underlying concept — the same value, fear, or orientation — possibly phrased differently across multiple source documents.

Only merge signals that are GENUINELY near-duplicate (same underlying meaning). Do NOT merge signals that are merely related or thematically similar.

${briefSection}

SIGNALS (${signals.length} total):
${signalList}

For each merge group, output:
- canonicalLabel: the best unified short label
- canonicalDescription: 1-2 sentences with enough context to be readable standalone (richer than any individual label)
- canonicalDirection: "toward" | "away_from" | "protecting" (dominant direction across the group)
- signalIdsToMerge: array of signal IDs — minimum 2, ALL must be valid IDs from the list above

Signals not in any group should be left unchanged. Return only groups with 2+ IDs.

Respond with valid JSON only — no markdown, no code blocks:
{
  "mergeGroups": [
    {
      "canonicalLabel": "string",
      "canonicalDescription": "string",
      "canonicalDirection": "toward|away_from|protecting",
      "signalIdsToMerge": ["id1", "id2"]
    }
  ]
}`;
}

/**
 * Groups near-duplicate evaluative signals into merge clusters via Gemini 2.5 Flash.
 * Thinking disabled — same rationale as extraction (faster, consistent JSON).
 *
 * @param signals      All evaluative signals for the project
 * @param projectBrief Optional brief for context
 * @returns            Array of merge groups (each with 2+ signal IDs)
 */
export async function deduplicateSignals(
  signals: import("@/types").EvaluativeSignal[],
  projectBrief?: ProjectBrief
): Promise<SignalMergeGroup[]> {
  if (signals.length < 2) return [];

  const validIds = new Set(signals.map((s) => s.id));
  const prompt   = buildSignalDeduplicationPrompt(signals, projectBrief);
  const raw      = await callGemini(prompt, 16384, false, true);
  const rawJson  = stripJsonFences(raw);

  let parsed: { mergeGroups: SignalMergeGroup[] } | null = null;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    console.error("[dedup] Gemini returned unparseable JSON:", rawJson.slice(0, 300));
    return [];
  }

  // Validate: drop groups with hallucinated IDs or fewer than 2 members
  const all = parsed?.mergeGroups ?? [];
  const valid = all.filter(
    (g) =>
      g.signalIdsToMerge?.length >= 2 &&
      g.signalIdsToMerge.every((id) => validIds.has(id)) &&
      g.canonicalLabel?.trim() &&
      g.canonicalDescription?.trim() &&
      ["toward", "away_from", "protecting"].includes(g.canonicalDirection)
  );
  if (valid.length < all.length) {
    console.warn(`[dedup] Dropped ${all.length - valid.length} invalid merge group(s) from Gemini response`);
  }
  return valid;
}

// ── Cross-project commons synthesis ─────────────────────────────────────────
//
// Compares shared nodes, signals, and tensions across two or more projects to
// surface mutual reachability — where organisational ontologies touch, diverge,
// or leave gaps. Design principle (Bonnitta Roy): map edges of contact, don't
// merge ontologies.
//
// Thinking disabled — same rationale as extraction (faster, consistent JSON).

function buildCommonsSynthesisPrompt(
  projects: CompactProjectPayload[]
): string {
  const projectSections = projects
    .map((p) => {
      const nodeList = p.nodes.length > 0
        ? p.nodes.map((n) => `    - "${n.label}" [${n.type}]: ${n.description}`).join("\n")
        : "    (no shared nodes)";
      const signalList = p.signals.length > 0
        ? p.signals.map((s) => `    - [${s.direction}] "${s.label}" (strength: ${s.strength}/5${s.thresholdProximity != null ? `, threshold: ${s.thresholdProximity}/5` : ""})`).join("\n")
        : "    (no shared signals)";
      const tensionList = p.tensions.length > 0
        ? p.tensions.map((t) => `    - ${t.description}`).join("\n")
        : "    (no tensions)";

      return `--- PROJECT: "${p.projectName}" (${p.projectId}) ---
  Shared nodes (${p.nodes.length}):
${nodeList}
  Shared signals (${p.signals.length}):
${signalList}
  Tensions (${p.tensions.length}):
${tensionList}`;
    })
    .join("\n\n");

  return `You are comparing organisational knowledge graphs from multiple teams or projects within TERROIR — an organisational listening tool.

The goal is MUTUAL REACHABILITY, not consensus. Do not merge ontologies. Map the edges where they touch.

You are given the shared nodes, evaluative signals, and tensions from ${projects.length} projects. Find:

1. CONVERGENCE — nodes across projects that represent the same concept (even if labeled differently). Return pairs with a similarity rationale. Only flag genuine semantic overlap, not superficial keyword matches.

2. CONTACT_POINTS — tensions that appear (by theme, not exact match) in multiple projects. These are shared organisational pain worth surfacing.

3. EVALUATIVE_DIVERGENCE — signals with the same or similar label but meaningfully different intensity (≥2 points difference) or opposite direction. These indicate different evaluative stances on the same thing.

4. REACHABILITY_GAPS — nodes in one project that have no semantic equivalent in another. These mark where one team can think something the other cannot yet. Only flag gaps that matter — concepts central to one project's ontology, not peripheral details.

Hard limits:
- Maximum 10 convergence items, 5 contact points, 5 divergence items, 10 reachability gaps.
- Every item must reference specific project names (not IDs).
- Do not fabricate nodes or signals that don't exist in the data above.

PROJECTS TO COMPARE:
${projectSections}

Respond with valid JSON only — no markdown, no code blocks:
{
  "convergence": [
    { "label": "canonical concept name", "projects": ["project name", ...], "rationale": "why these are the same concept" }
  ],
  "contact_points": [
    { "theme": "shared tension theme", "projects": ["project name", ...], "description": "how this tension manifests across projects" }
  ],
  "evaluative_divergence": [
    { "signal": "signal label or theme", "divergence": "how the evaluative stance differs across projects" }
  ],
  "reachability_gaps": [
    { "node": "concept label", "present_in": "project name", "absent_from": "project name" }
  ]
}`;
}

/**
 * Runs cross-project commons synthesis via Gemini 2.5 Flash.
 *
 * Compares shared nodes, signals, and tensions across projects to surface
 * convergence, contact points, evaluative divergence, and reachability gaps.
 *
 * @param projects  Compact payloads of shared data from each project
 * @returns         Four-quadrant commons synthesis result
 */
export async function synthesizeAcrossProjects(
  projects: CompactProjectPayload[]
): Promise<CommonsSynthesisResult> {
  if (projects.length < 2) {
    throw new Error("[commons] Need at least 2 projects to compare");
  }

  const prompt = buildCommonsSynthesisPrompt(projects);
  const raw = await callGemini(prompt, 16384, false, true);
  const rawJson = stripJsonFences(raw);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    console.error("[commons] Gemini returned unparseable JSON:", rawJson.slice(0, 300));
    return { convergence: [], contactPoints: [], evaluativeDivergence: [], reachabilityGaps: [] };
  }

  const projectNames = new Set(projects.map((p) => p.projectName));

  const convergence = (parsed.convergence as CommonsSynthesisResult["convergence"] ?? [])
    .filter((c) => c.label && c.projects?.length >= 2 && c.rationale);

  const contactPoints = (parsed.contact_points as CommonsSynthesisResult["contactPoints"] ?? [])
    .filter((c) => c.theme && c.projects?.length >= 2);

  const evaluativeDivergence = (parsed.evaluative_divergence as CommonsSynthesisResult["evaluativeDivergence"] ?? [])
    .filter((d) => d.signal && d.divergence);

  // Gemini returns snake_case keys (present_in, absent_from) per the prompt schema.
  // Map to camelCase to match CommonsSynthesisResult.
  const rawGaps = (parsed.reachability_gaps as { node: string; present_in: string; absent_from: string }[] ?? []);
  const reachabilityGaps: CommonsSynthesisResult["reachabilityGaps"] = rawGaps
    .filter((g) => g.node && g.present_in && g.absent_from
      && (projectNames.has(g.present_in) || projectNames.has(g.absent_from)))
    .map((g) => ({ node: g.node, presentIn: g.present_in, absentFrom: g.absent_from }));

  return { convergence, contactPoints, evaluativeDivergence, reachabilityGaps };
}

/**
 * Runs the cross-document integration pass via Gemini 2.5 Flash.
 *
 * Sends the full entity + relationship set as a compact payload.
 * Thinking is disabled for speed and reliable JSON output (same as extraction).
 *
 * @param entities      Compact entity list (id + label + attractor + truncated desc)
 * @param compactRels   Existing relationships as label pairs (for Gemini context)
 * @param projectBrief  Optional brief for calibrating integration focus
 */
export async function integrateEntities(
  entities:    CompactEntity[],
  compactRels: { sourceLabel: string; targetLabel: string; type: string }[],
  projectBrief?: ProjectBrief
): Promise<IntegrationOutput> {
  const validIds = new Set(entities.map((e) => e.id));

  const prompt = buildIntegrationPrompt(entities, compactRels, projectBrief);
  const raw    = await callGemini(prompt, 32768, false, true); // no JSON mode, thinking off
  let rawJson  = stripJsonFences(raw);

  let parsed: IntegrationOutput | null = null;
  try {
    parsed = JSON.parse(rawJson) as IntegrationOutput;
  } catch {
    console.error("[integrate] Gemini returned unparseable JSON. First 500 chars:", rawJson.slice(0, 500));
    // Retry once with explicit JSON reinforcement
    const retryRaw  = await callGemini(
      prompt + "\n\nCRITICAL: Respond with valid JSON only. No text before or after the JSON object.",
      32768, false, true
    );
    rawJson = stripJsonFences(retryRaw);
    try {
      parsed = JSON.parse(rawJson) as IntegrationOutput;
    } catch {
      console.error("[integrate] Retry also failed. Returning empty result.");
      return { mergeGroups: [], newRelationships: [], reassignments: [] };
    }
  }

  // Validate all entity IDs referenced in the response — drop anything hallucinated
  const mergeGroups = (parsed.mergeGroups ?? []).filter(
    (g) => g.entityIdsToMerge?.length >= 2 &&
           g.entityIdsToMerge.every((id) => validIds.has(id))
  );

  const newRelationships = (parsed.newRelationships ?? []).filter(
    (r) => validIds.has(r.sourceEntityId) && validIds.has(r.targetEntityId)
  );

  const reassignments = (parsed.reassignments ?? []).filter(
    (r) => validIds.has(r.entityId)
  );

  return { mergeGroups, newRelationships, reassignments };
}

// ── Topology-aware signal enrichment ─────────────────────────────────────────
//
// A single Gemini pass that receives the graph topology (hub density,
// cross-hub connections, tension clusters, emergent count) alongside the
// existing evaluative signals and project brief. Returns:
//
//   1. Enriched signal labels — self-contained 5–12 word phrases with
//      reachability framing, grounded in the org's structural reality.
//
//   2. An optimisation hypothesis — what the org appears to be optimising
//      for based on graph structure, not just document-stated values.
//
// Thinking disabled: same rationale as extraction — faster, consistent JSON.

export interface EnrichedSignalUpdate {
  id:        string;
  label:     string;
  direction: "toward" | "away_from" | "protecting";
}

export interface TopologyEnrichmentOutput {
  enrichedSignals:        EnrichedSignalUpdate[];
  optimizationHypothesis: string;
}

function buildTopologyEnrichmentPrompt(
  payload: import("@/lib/topology").TopologyPayload
): string {
  const emergentPct = Math.round(
    (payload.emergentCount / Math.max(payload.totalEntities, 1)) * 100
  );

  return `You are TERROIR's topology analysis engine. Your task is to enrich evaluative signals and surface an optimisation hypothesis for this organisation based on the graph structure.

WHAT TERROIR IS:
An organisational listening tool that builds a knowledge graph from documents. Entities belong to hub categories (Domain, Capability, etc.). The topology below describes which hubs are dense, which are thin, where tensions cluster, and how hubs connect — revealing structural reachability rather than just stated values.

PROJECT CONTEXT:
- Sector: ${payload.brief.sector ?? "not specified"}
- Org size: ${payload.brief.orgSize ?? "not specified"}
- Discovery goal: ${payload.brief.discoveryGoal ?? "not specified"}
- Total entities: ${payload.totalEntities} | Relationships: ${payload.totalRelationships}
- Isolated entities (0–1 connections): ${payload.emergentCount} (${emergentPct}% of graph)

HUB TOPOLOGY:
${JSON.stringify(payload.hubs, null, 2)}

CROSS-HUB CONNECTIONS (strongest bridges first):
${payload.crossHubConnections.length > 0
    ? JSON.stringify(payload.crossHubConnections, null, 2)
    : "None detected — hubs are structurally isolated from each other"}

TOP UNRESOLVED TENSIONS:
${payload.topTensions.length > 0
    ? payload.topTensions.map((t, i) => `${i + 1}. ${t}`).join("\n")
    : "None"}

CURRENT EVALUATIVE SIGNALS (${payload.signals.length} total):
${JSON.stringify(payload.signals, null, 2)}

YOUR TASKS:

TASK 1 — ENRICH SIGNAL LABELS:
Rewrite each signal label as a self-contained descriptive phrase (5–12 words) that captures the reachability implication — what organisational future is being protected, approached, or avoided. Use the hub topology and tensions as structural context.

Rules:
- EVERY signal must appear in the output with its original ID.
- Labels must be descriptive phrases, NOT single words or generic values.
  BAD: "Ethics" / GOOD: "Ethical alignment as prerequisite for long-term client trust"
  BAD: "Listening" / GOOD: "Organisational listening as foundation for agent knowledge transfer"
- Ground labels in the org's actual sector and discovery goal.
- Update direction if the topology reveals a different orientation than the original label implies.

TASK 2 — OPTIMISATION HYPOTHESIS:
Write 2–3 sentences describing what this organisation structurally appears to be optimising for — based on hub density, cross-hub bridges, tension concentration, and isolation rate. Do NOT simply restate what documents say; reason from the graph pattern.

End with one sentence naming the most at-risk corridor: the organisational future most likely to become unreachable if current structural patterns continue.

Respond with valid JSON only — no markdown, no code blocks:
{
  "enrichedSignals": [
    { "id": "string", "label": "descriptive phrase 5–12 words", "direction": "toward|away_from|protecting" }
  ],
  "optimizationHypothesis": "2–3 sentence structural hypothesis ending with the most at-risk corridor."
}`;
}

/**
 * Runs the topology-aware signal enrichment pass via Gemini 2.5 Flash.
 *
 * @param payload  Compact topology summary from buildTopologyPayload()
 * @returns        Enriched signal labels + optimisation hypothesis
 */
export async function enrichSignalsWithTopology(
  payload: import("@/lib/topology").TopologyPayload
): Promise<TopologyEnrichmentOutput> {
  const prompt  = buildTopologyEnrichmentPrompt(payload);
  const raw     = await callGemini(prompt, 16384, false, true); // no JSON mode, no thinking
  const rawJson = stripJsonFences(raw);

  let parsed: TopologyEnrichmentOutput | null = null;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("enrichSignalsWithTopology: failed to parse Gemini response as JSON");
  }

  if (!Array.isArray(parsed?.enrichedSignals) || !parsed?.optimizationHypothesis) {
    throw new Error("enrichSignalsWithTopology: response missing required fields");
  }

  // Sanitise directions — fall back to "toward" if Gemini returns something unexpected
  const validDirections = new Set(["toward", "away_from", "protecting"]);
  parsed.enrichedSignals = parsed.enrichedSignals.map((s) => ({
    ...s,
    direction: validDirections.has(s.direction)
      ? (s.direction as "toward" | "away_from" | "protecting")
      : "toward",
  }));

  return parsed;
}

// ── Meta-tension (cross-graph fault line) pass ────────────────────────────────
//
// A single Gemini pass that traverses the hub topology to surface fault lines
// that only become visible when holding the whole graph at once — not any single
// document. Uses somatic vocabulary as the diagnostic frame:
//
//   contracted — the org is pulling inward, playing small, not expanding
//   blocked    — stagnation across multiple hubs; the same pattern repeating
//   pulled     — scattered attention, method-over-value, too much emergent
//
// Returns 2–4 TensionMarkers with scope: "cross-graph" and relatedNodeIds
// pointing to hub nodes involved in each fault line.

interface MetaTensionOutput {
  faultLines: {
    index: number; // 1-based reference to the code-detected pattern this voices
    description: string;
    somaticPattern: "contracted" | "blocked" | "pulled";
  }[];
}

/**
 * Builds the meta-tension prompt from the hub topology payload.
 * Input is the same compact payload used by the topology-signal enrichment pass.
 */
function buildMetaTensionPrompt(
  patterns: import("@/lib/topology").StructuralPattern[],
  payload: import("@/lib/topology").TopologyPayload
): string {
  const patternBlock = patterns
    .map(
      (p, i) =>
        `${i + 1}. [${p.pattern}] hubs: ${p.hubSlugs.join(", ")}\n   evidence: ${p.evidence}`
    )
    .join("\n");

  const existingTensions =
    payload.topTensions.length > 0
      ? payload.topTensions.map((t) => `  - ${t}`).join("\n")
      : "  (none)";

  return `You are TERROIR's cross-graph fault line VOICER. Structural detection has already been done in code. Your only job is to put precise, embodied language to each structural pattern below. Do NOT discover new patterns. Do NOT recite member counts or relationship numbers as if they were the insight — the numbers are context, the meaning is your output.

WHAT TERROIR IS:
An organisational listening tool that builds a knowledge graph from documents. Entities belong to hub categories (Domain, Capability, Culture, etc.).

PROJECT CONTEXT:
- Sector: ${payload.brief.sector ?? "not specified"}
- Org size: ${payload.brief.orgSize ?? "not specified"}
- Discovery goal: ${payload.brief.discoveryGoal ?? "not specified"}

CODE-DETECTED STRUCTURAL PATTERNS (voice each one — exactly ${patterns.length}, no more, no fewer):
${patternBlock}

SOMATIC FRAME (what each pattern means as organisational felt-sense):
- contracted: the org is pulling inward, playing small, staying close to what it already knows.
- blocked: stagnation across hubs; the same friction repeating with no path to resolve.
- pulled: attention scattered, concepts multiplying faster than they integrate.

EXISTING LOCAL TENSIONS (already captured — do not restate the meaning of these):
${existingTensions}

FOR EACH numbered pattern above, write exactly one fault line that:
1. Echoes that pattern's number as "index" — this is how your wording is matched back to its hubs, so do not skip, reorder, merge, or invent indices.
2. Describes the structural reality in embodied, concrete language ("the org is X", never "the org should Y")
3. Names what is at stake — the organisational future the pattern is foreclosing or protecting
4. Leads with the meaning, not the arithmetic. Reference a number only if it sharpens the stake, never as the point itself.

The hubs are already fixed by code — you supply only the language and the matching index, never the hubs. Output exactly ${patterns.length} objects, one per numbered pattern.

GOOD (meaning-first):
{ "index": 1, "description": "The org knows its field deeply but keeps that knowledge from becoming capability — it is safer to stay expert than to be tested, so the bridge that would turn knowing into doing never gets built.", "somaticPattern": "contracted" }

BAD (arithmetic-first — rejected):
{ "index": 1, "description": "The Domain hub has 18 members and 12 internal connections while Capability has 3 members.", "somaticPattern": "contracted" }

Respond with valid JSON only — no markdown, no code blocks:
{
  "faultLines": [
    {
      "index": 1,
      "description": "string — meaning-first, names the stake",
      "somaticPattern": "contracted|blocked|pulled"
    }
  ]
}`;
}

/**
 * Runs the cross-graph meta-tension (fault line) pass via Gemini 2.5 Flash.
 * Returns TensionMarkers with scope: "cross-graph" ready to merge into GraphState.
 *
 * @param payload    Compact topology summary from buildTopologyPayload()
 * @param hubNodes   Hub nodes from the current GraphState (used to resolve slugs → node IDs)
 * @returns          TensionMarkers with scope "cross-graph"
 */
export async function detectMetaTensions(
  payload: import("@/lib/topology").TopologyPayload,
  hubNodes: import("@/types").GraphNode[]
): Promise<import("@/types").TensionMarker[]> {
  // ── Detection happens in code, not in the model ───────────────────────────
  // Zero candidates → a thin or quiet graph. Return silently, never call Gemini.
  const patterns = detectStructuralPatterns(payload);
  if (patterns.length === 0) return [];

  const prompt  = buildMetaTensionPrompt(patterns, payload);
  const raw     = await callGemini(prompt, 8192, false, true); // no JSON mode, no thinking
  const rawJson = stripJsonFences(raw);

  let parsed: MetaTensionOutput | null = null;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("detectMetaTensions: failed to parse Gemini response as JSON");
  }

  if (!Array.isArray(parsed?.faultLines)) {
    throw new Error("detectMetaTensions: response missing faultLines array");
  }

  // Build a slug → node ID map from the hub nodes
  const slugToId: Record<string, string> = {};
  for (const hub of hubNodes) {
    const slug = hub.properties?.attractor_id ?? hub.label.toLowerCase();
    slugToId[slug] = hub.id;
  }

  // Convert voiced fault lines to TensionMarkers. Hubs come ONLY from the
  // code-detected pattern, matched by the model's echoed `index` (not array
  // position) — so a reordered, dropped, or over-emitted response can never
  // pin a description to the wrong hubs or smuggle in a model-invented fault
  // line. The model supplies language; code owns which hubs are at stake.
  const tensions: import("@/types").TensionMarker[] = [];
  const usedIndices = new Set<number>();
  for (const fl of parsed.faultLines) {
    if (!fl.description || typeof fl.index !== "number") continue;

    const pattern = patterns[fl.index - 1]; // 1-based
    if (!pattern || usedIndices.has(fl.index)) continue; // out-of-range or duplicate
    usedIndices.add(fl.index);

    const relatedNodeIds = pattern.hubSlugs
      .map((slug) => slugToId[slug])
      .filter(Boolean) as string[];
    if (relatedNodeIds.length === 0) continue;

    tensions.push({
      id: uuidv4(),
      description: fl.description,
      relatedNodeIds,
      status: "unresolved",
      scope: "cross-graph",
    });
  }

  return tensions;
}
