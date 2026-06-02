/**
 * Shared handler layer for all Terroir v1 API surfaces.
 *
 * Both the HTTP routes (/api/v1/) and the MCP server (mcp-server/index.ts)
 * import from here. No logic lives in the route files — they authenticate,
 * validate, call a handler, and return.
 *
 * add_source consolidates the classify → extract pipeline server-side.
 * query_graph uses Gemini vector embeddings via the existing searchChunks RPC.
 */

import { v4 as uuidv4 } from "uuid";
import {
  getProjects,
  getProject,
  loadOntology,
  saveOntology,
  searchChunks,
  getProjectDocuments,
  getSharedProjectPayload,
  logSession,
} from "./supabase";
import { buildProjectBundle } from "./export";
import { classifyDocuments, extractOntologyWithGemini, runGeminiSynthesis, synthesizeAcrossProjects } from "./gemini";
import { embedText } from "./embeddings";
import { assertScope, assertProject, type AuthContext } from "./api-auth";
import type { ProjectBrief, GraphNode, EvaluativeSignal, AbstractionLayer, SharingScope } from "@/types";

// ── list_projects ─────────────────────────────────────────────────────────────

export async function handleListProjects(ctx: AuthContext) {
  assertScope(ctx, "read");
  const projects = await getProjects();
  // If token is project-scoped, filter to just that project
  if (ctx.projectScope) {
    return projects.filter((p) => p.id === ctx.projectScope);
  }
  return projects;
}

// ── get_project ───────────────────────────────────────────────────────────────

export async function handleGetProject(ctx: AuthContext, projectId: string) {
  assertScope(ctx, "read");
  assertProject(ctx, projectId);

  const [project, graphState] = await Promise.all([
    getProject(projectId),
    loadOntology(projectId),
  ]);

  if (!project) return null;

  const projectBrief = (project.metadata?.brief as ProjectBrief | null) ?? null;
  const attractorPreset = (project.metadata?.attractorPreset as string | null) ?? null;

  const bundle = buildProjectBundle({
    projectName: project.name,
    graphState,
    projectBrief,
    synthesisResult: null,
    attractorPreset,
  });

  return { project, bundle };
}

// ── query_graph ───────────────────────────────────────────────────────────────

export async function handleQueryGraph(
  ctx: AuthContext,
  projectId: string,
  query: string,
  matchCount = 10
) {
  assertScope(ctx, "read");
  assertProject(ctx, projectId);

  const queryEmbedding = await embedText(query);
  const chunks = await searchChunks(projectId, queryEmbedding, matchCount);
  return { query, results: chunks };
}

// ── add_source ────────────────────────────────────────────────────────────────
// Server-side consolidation of the Sources pipeline classify → extract phases.
// Does NOT replicate the full 4-phase UI flow — it runs the two AI steps and
// persists the updated graph. Skipped (SKIP verdict) docs return early.

export async function handleAddSource(
  ctx: AuthContext,
  projectId: string,
  text: string,
  title = "API source"
) {
  assertScope(ctx, "write");
  assertProject(ctx, projectId);

  const [project, graphState] = await Promise.all([
    getProject(projectId),
    loadOntology(projectId),
  ]);

  if (!project) throw new Error(`Project not found: ${projectId}`);

  const brief = (project.metadata?.brief as ProjectBrief | undefined);

  // Phase 1: classify
  const [classification] = await classifyDocuments(
    [{ index: 0, title, preview: text.slice(0, 2000) }],
    brief
  );

  if (classification.verdict === "SKIP") {
    return {
      verdict: "SKIP",
      reason: classification.reason,
      graphUpdates: [],
    };
  }

  // Phase 2: extract
  const abstractionLayer = project.metadata?.abstractionLayer as AbstractionLayer | undefined;
  const { updatedGraph, graphUpdates } = await extractOntologyWithGemini(
    text,
    graphState,
    abstractionLayer,
    brief
  );

  // Tag newly created nodes with 'gemini' source type
  // (extractOntologyWithGemini returns the full updated graph, we need to find the new ones)
  const existingNodeIds = new Set(graphState.nodes.map(n => n.id));
  updatedGraph.nodes.forEach(n => {
    if (!existingNodeIds.has(n.id)) {
      n.sourceType = 'gemini';
    }
  });

  // Persist to Supabase
  await saveOntology(projectId, updatedGraph);

  logSession({
    project_id: projectId,
    type: "extraction",
    agent: "gemini",
    summary: `API add_source: ${graphUpdates.length} updates from "${title}" (${classification.verdict})`,
    raw_output: { graphUpdates, verdict: classification.verdict },
  }).catch((err) => console.warn("[api-handlers] session log failed:", err));

  return {
    verdict: classification.verdict,
    graphUpdates,
    nodeCount: updatedGraph.nodes.length,
    relationshipCount: updatedGraph.relationships.length,
  };
}

// ── add_node ──────────────────────────────────────────────────────────────────

export async function handleAddNode(
  ctx: AuthContext,
  projectId: string,
  input: {
    label: string;
    type: string;
    description?: string;
    hubId?: string;
  }
) {
  assertScope(ctx, "write");
  assertProject(ctx, projectId);

  const graphState = await loadOntology(projectId);

  const nodeId = uuidv4();
  const newNode: GraphNode = {
    id: nodeId,
    label: input.label,
    type: input.type.toLowerCase(),
    attractor: input.hubId ?? "emergent",
    description: input.description ?? "",
    position: { x: Math.random() * 400, y: Math.random() * 400 },
    sourceType: 'sonnet', // Default API-driven node creation to sonnet
  };

  const updatedNodes = [...graphState.nodes, newNode];
  const updatedRels = [...graphState.relationships];

  // Wire belongs_to_hub edge if a hub was specified and exists
  if (input.hubId) {
    const hub = graphState.nodes.find((n) => n.id === input.hubId && n.is_hub);
    if (hub) {
      updatedRels.push({
        id: uuidv4(),
        sourceId: nodeId,
        targetId: input.hubId,
        type: "belongs_to_hub",
      });
    }
  }

  await saveOntology(projectId, { ...graphState, nodes: updatedNodes, relationships: updatedRels });
  return { node: newNode };
}

// ── add_signal ────────────────────────────────────────────────────────────────

export async function handleAddSignal(
  ctx: AuthContext,
  projectId: string,
  input: {
    label: string;
    direction: "toward" | "away_from" | "protecting";
    strength: number;
    sourceDescription?: string;
    thresholdProximity?: number;
    atCostOf?: string;
    temporalHorizon?: string;
  }
) {
  assertScope(ctx, "write");
  assertProject(ctx, projectId);

  const graphState = await loadOntology(projectId);

  const signal: EvaluativeSignal = {
    id: uuidv4(),
    label: input.label,
    direction: input.direction,
    strength: Math.min(5, Math.max(1, input.strength)),
    sourceDescription: input.sourceDescription ?? "",
    thresholdProximity: input.thresholdProximity ?? null,
    atCostOf: input.atCostOf ?? null,
    temporalHorizon: (input.temporalHorizon as EvaluativeSignal["temporalHorizon"]) ?? null,
  };

  const updatedSignals = [...graphState.evaluativeSignals, signal];
  await saveOntology(projectId, { ...graphState, evaluativeSignals: updatedSignals });
  return { signal };
}

// ── run_synthesis ─────────────────────────────────────────────────────────────

export async function handleRunSynthesis(ctx: AuthContext, projectId: string) {
  assertScope(ctx, "synthesis");
  assertProject(ctx, projectId);

  const [graphState, documents, project] = await Promise.all([
    loadOntology(projectId),
    getProjectDocuments(projectId),
    getProject(projectId),
  ]);

  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (documents.length === 0) throw new Error("No documents in project — add sources first");

  const brief = (project.metadata?.brief as ProjectBrief | undefined);
  const result = await runGeminiSynthesis(graphState, documents, brief);

  logSession({
    project_id: projectId,
    type: "synthesis",
    agent: "gemini",
    summary: `API run_synthesis — ${documents.length} docs, ${result.termCollisions.length} collisions`,
    raw_output: { documentCount: result.documentCount },
  }).catch((err) => console.warn("[api-handlers] session log failed:", err));

  return result;
}

// ── commons_synthesis ───────────────────────────────────────────────────────

export async function handleCommonsSynthesis(
  ctx: AuthContext,
  projectIds: string[],
  sharingScope: SharingScope = "team"
) {
  assertScope(ctx, "read");

  if (!projectIds || projectIds.length < 2) {
    throw new Error("commons_synthesis requires at least 2 project IDs");
  }
  if (projectIds.length > 10) {
    throw new Error("commons_synthesis supports at most 10 projects per call");
  }

  // Project-scoped tokens can only compare projects they have access to
  for (const pid of projectIds) {
    assertProject(ctx, pid);
  }

  // Fetch shared payloads in parallel
  const payloads = await Promise.allSettled(
    projectIds.map((pid) => getSharedProjectPayload(pid, sharingScope))
  );

  const projects = payloads
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof getSharedProjectPayload>>> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((p) => p.nodes.length > 0 || p.signals.length > 0);

  if (projects.length < 2) {
    throw new Error(
      `Only ${projects.length} project(s) have shared data at scope "${sharingScope}" — need at least 2. Mark nodes/signals as shared first.`
    );
  }

  const result = await synthesizeAcrossProjects(projects);

  logSession({
    project_id: projectIds[0],
    type: "synthesis",
    agent: "gemini",
    summary: `API commons_synthesis — ${projects.length} projects, scope: ${sharingScope}`,
    raw_output: {
      projectIds,
      sharingScope,
      convergenceCount: result.convergence.length,
      contactPointCount: result.contactPoints.length,
    },
  }).catch((err) => console.warn("[api-handlers] session log failed:", err));

  return result;
}
