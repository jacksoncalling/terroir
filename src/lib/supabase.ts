import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import type {
  Project,
  ProjectPhase,
  GraphState,
  GraphNode,
  Relationship,
  TensionMarker,
  EvaluativeSignal,
  EntityTypeConfig,
  CompactEntity,
  MergeGroup,
  CrossDocRelationship,
  AttractorReassignment,
  AttractorPreset,
  SessionType,
  SessionAgent,
  SharingScope,
  CompactProjectPayload,
} from '@/types';
import { seedHubNodes } from './entity-types';

// NEXT_PUBLIC_ prefix makes these available in both server and client bundles.
// Fallback to unprefixed versions for scripts/API routes that set them directly.
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ── Legacy types (Phase 1 compatibility) ────────────────────────────────────

export type Document = {
  id: string;
  url: string;
  title: string;
  section: string;
  content: string;
  project_id: string | null;
  created_at: string;
};

export type DocumentChunk = {
  id: string;
  document_id: string;
  content: string;
  chunk_index: number;
  embedding: number[];
  project_id: string | null;
};

// ── Search result type ───────────────────────────────────────────────────────

export type SearchResult = {
  id: string;
  document_id: string;
  content: string;
  chunk_index: number;
  similarity: number;
  doc_url: string;
  doc_title: string;
  doc_section: string;
};

// ── Project CRUD ─────────────────────────────────────────────────────────────

export async function getProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getProjects: ${error.message}`);
  return data ?? [];
}

export async function getProject(id: string): Promise<Project | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // not found
    throw new Error(`getProject: ${error.message}`);
  }
  return data;
}

export async function createProject(input: {
  name: string;
  sector?: string;
  description?: string;
  embedding_model?: string;
  phase?: ProjectPhase;
  metadata?: Record<string, unknown>;
  parent_project_id?: string;
}): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .insert({
      name: input.name,
      sector: input.sector ?? null,
      description: input.description ?? null,
      embedding_model: input.embedding_model ?? 'paraphrase-multilingual-MiniLM-L12-v2',
      phase: input.phase ?? 'preparation',
      metadata: input.metadata ?? {},
      ...(input.parent_project_id ? { parent_project_id: input.parent_project_id } : {}),
    })
    .select('*')
    .single();

  if (error) throw new Error(`createProject: ${error.message}`);

  // Seed hub nodes from the attractor preset
  const preset = (input.metadata?.attractorPreset as AttractorPreset) ?? 'startup';
  const hubNodes = seedHubNodes(preset);

  if (hubNodes.length > 0) {
    const { error: hubError } = await supabase.from('ontology_nodes').insert(
      hubNodes.map((n) => ({
        id: n.id,
        node_id: n.id,
        project_id: data.id,
        label: n.label,
        type: n.type,
        attractor: n.attractor ?? 'emergent',
        is_hub: true,
        description: n.description,
        position_x: n.position.x,
        position_y: n.position.y,
        properties: n.properties ?? {},
      }))
    );
    if (hubError) {
      console.warn(`createProject: hub seeding failed (non-fatal): ${hubError.message}`);
    }
  }

  return data;
}

/**
 * Adopt an existing project as a child of another (set parent_project_id).
 * Validates: both projects exist, child has no parent yet, no circular reference.
 * This is a metadata-only update — no data is copied between projects.
 */
export async function adoptProject(
  childProjectId: string,
  parentProjectId: string
): Promise<void> {
  if (childProjectId === parentProjectId) {
    throw new Error("adoptProject: a project cannot be its own parent");
  }

  // Fetch both projects to validate
  const [child, parent] = await Promise.all([
    getProject(childProjectId),
    getProject(parentProjectId),
  ]);

  if (!child) throw new Error("adoptProject: child project not found");
  if (!parent) throw new Error("adoptProject: parent project not found");
  if (child.parent_project_id) {
    throw new Error("adoptProject: child already has a parent — unnest it first");
  }

  // Prevent circular reference: walk up from parent to ensure child isn't an ancestor
  let current = parent;
  while (current.parent_project_id) {
    if (current.parent_project_id === childProjectId) {
      throw new Error("adoptProject: circular reference — child is an ancestor of parent");
    }
    const ancestor = await getProject(current.parent_project_id);
    if (!ancestor) break;
    current = ancestor;
  }

  const { error } = await supabase
    .from("projects")
    .update({ parent_project_id: parentProjectId, updated_at: new Date().toISOString() })
    .eq("id", childProjectId);

  if (error) throw new Error(`adoptProject: ${error.message}`);
}

/**
 * Remove a project from its parent (set parent_project_id to null).
 * The project keeps all its own nodes and relationships — nothing is deleted.
 */
export async function unnestProject(projectId: string): Promise<void> {
  const { error } = await supabase
    .from("projects")
    .update({ parent_project_id: null, updated_at: new Date().toISOString() })
    .eq("id", projectId);

  if (error) throw new Error(`unnestProject: ${error.message}`);
}

export async function updateProjectPhase(id: string, phase: ProjectPhase): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({ phase, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`updateProjectPhase: ${error.message}`);
}

/**
 * Deep-merges a metadata patch into the project's existing metadata jsonb.
 * Used to store the ProjectBrief under projects.metadata.brief without
 * overwriting other metadata keys.
 *
 * Read → merge → write (two round trips, but keeps all existing fields safe).
 */
export async function updateProjectMetadata(
  id: string,
  patch: Record<string, unknown>
): Promise<void> {
  // Read current metadata first so we can merge rather than replace
  const { data: current, error: readError } = await supabase
    .from('projects')
    .select('metadata')
    .eq('id', id)
    .single();

  if (readError) throw new Error(`updateProjectMetadata (read): ${readError.message}`);

  const merged = { ...(current?.metadata ?? {}), ...patch };

  const { error } = await supabase
    .from('projects')
    .update({ metadata: merged, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`updateProjectMetadata (write): ${error.message}`);
}

/**
 * Returns the number of documents for a project without fetching content.
 * Used by the Inspector to decide whether "Re-process sources" is available.
 */
export async function countProjectDocuments(projectId: string): Promise<number> {
  const { count, error } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId);

  if (error) throw new Error(`countProjectDocuments: ${error.message}`);
  return count ?? 0;
}

/**
 * Fetches lightweight document headers (no content) for a project.
 * Used by the Sources panel to restore the uploaded-documents list across
 * sessions without pulling full document content into the browser.
 */
export async function getProjectDocumentHeaders(
  projectId: string
): Promise<{ id: string; title: string; created_at: string }[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getProjectDocumentHeaders: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title ?? 'Untitled',
    created_at: row.created_at ?? '',
  }));
}

/**
 * Fetches all documents for a project, ordered by creation date.
 * Used by the synthesis route to load full document content into Haiku's
 * context window and by the reprocess route to rebuild the graph.
 */
export async function getProjectDocuments(
  projectId: string
): Promise<{ id: string; title: string; content: string }[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, content')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getProjectDocuments: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title ?? 'Untitled',
    content: row.content ?? '',
  }));
}

/**
 * Deletes all ontology data for a project across all five tables.
 * Used by the reprocess route before rebuilding the graph from scratch.
 */
export async function clearOntology(projectId: string): Promise<void> {
  const tables = [
    'ontology_nodes',
    'ontology_relationships',
    'tension_markers',
    'evaluative_signals',
    'entity_type_configs',
  ] as const;

  for (const table of tables) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('project_id', projectId);

    if (error) throw new Error(`clearOntology (${table}): ${error.message}`);
  }
}

/**
 * Deletes all documents and their chunks for a project.
 * Used by the full reset flow to prevent duplicate documents on re-upload.
 * Chunks deleted first (FK dependency on document_id).
 */
export async function clearDocuments(projectId: string): Promise<void> {
  const { error: chunkError } = await supabase
    .from('document_chunks')
    .delete()
    .eq('project_id', projectId);

  if (chunkError) throw new Error(`clearDocuments (chunks): ${chunkError.message}`);

  const { error: docError } = await supabase
    .from('documents')
    .delete()
    .eq('project_id', projectId);

  if (docError) throw new Error(`clearDocuments (documents): ${docError.message}`);
}

/**
 * Deletes a single document and its chunks by document ID.
 */
export async function deleteDocument(documentId: string): Promise<void> {
  const { error: chunkError } = await supabase
    .from('document_chunks')
    .delete()
    .eq('document_id', documentId);

  if (chunkError) throw new Error(`deleteDocument (chunks): ${chunkError.message}`);

  const { error: docError } = await supabase
    .from('documents')
    .delete()
    .eq('id', documentId);

  if (docError) throw new Error(`deleteDocument: ${docError.message}`);
}

// ── Cross-document integration helpers ──────────────────────────────────────

/**
 * Loads all entities for a project in compact form for the integration prompt.
 * Descriptions are truncated to 100 chars to keep the Gemini payload lean.
 */
export async function getProjectEntitiesCompact(projectId: string): Promise<CompactEntity[]> {
  const { data, error } = await supabase
    .from('ontology_nodes')
    .select('id, label, type, attractor, description, is_hub')
    .eq('project_id', projectId);

  if (error) throw new Error(`getProjectEntitiesCompact: ${error.message}`);

  // Hub nodes are structural anchors — exclude them so Gemini never merges or
  // reassigns them during the integration pass. Filter in code to handle NULL
  // is_hub safely (rows created before migration 005).
  return (data ?? []).filter((row) => row.is_hub !== true).map((row) => ({
    id:       row.id,
    label:    row.label ?? '',
    type:     row.type ?? 'concept',
    attractor: row.attractor ?? 'emergent',
    desc:     (row.description ?? '').slice(0, 100),
  }));
}

/**
 * Executes a list of entity merge groups against Supabase.
 *
 * For each group:
 *  1. Picks the entity with the most relationships as the survivor
 *  2. Updates survivor with canonical label + description
 *  3. Re-points all relationships from non-survivors → survivor
 *  4. Re-points tension markers referencing non-survivors → survivor
 *  5. Deletes non-survivor entities
 * After all groups: deduplicates any relationships with identical (source, target, type).
 *
 * Returns the number of non-survivor entities deleted.
 */
export async function executeMerges(
  projectId: string,
  mergeGroups: MergeGroup[]
): Promise<number> {
  if (mergeGroups.length === 0) return 0;

  // Load all relationships upfront — used to pick survivors + update in-memory
  const { data: allRels, error: relsError } = await supabase
    .from('ontology_relationships')
    .select('id, source_node_id, target_node_id, type')
    .eq('project_id', projectId);
  if (relsError) throw new Error(`executeMerges (load rels): ${relsError.message}`);

  // Load all tension markers upfront — need to re-point related_node_ids arrays
  const { data: allTensions, error: tensionError } = await supabase
    .from('tension_markers')
    .select('id, related_node_ids')
    .eq('project_id', projectId);
  if (tensionError) throw new Error(`executeMerges (load tensions): ${tensionError.message}`);

  const rels = allRels ?? [];
  const tensions = allTensions ?? [];
  let totalDeleted = 0;

  for (const group of mergeGroups) {
    const { canonicalLabel, canonicalDescription, entityIdsToMerge } = group;
    if (!entityIdsToMerge || entityIdsToMerge.length < 2) continue;

    // Count relationships per candidate to pick the survivor
    const relCounts: Record<string, number> = {};
    for (const id of entityIdsToMerge) relCounts[id] = 0;
    for (const rel of rels) {
      if (relCounts[rel.source_node_id] !== undefined) relCounts[rel.source_node_id]++;
      if (relCounts[rel.target_node_id]  !== undefined) relCounts[rel.target_node_id]++;
    }

    // Survivor = entity with the most relationships (ties broken by list order)
    const survivorId = entityIdsToMerge.reduce((best, id) =>
      (relCounts[id] ?? 0) > (relCounts[best] ?? 0) ? id : best
    );
    const nonSurvivorIds = entityIdsToMerge.filter((id) => id !== survivorId);

    // Update survivor with Gemini's canonical label + description
    const { error: survivorError } = await supabase
      .from('ontology_nodes')
      .update({ label: canonicalLabel, description: canonicalDescription })
      .eq('id', survivorId);
    if (survivorError) {
      console.warn(`[integrate] Failed to update survivor ${survivorId}: ${survivorError.message}`);
      continue;
    }

    // Re-point relationships: all references to non-survivors → survivor
    for (const oldId of nonSurvivorIds) {
      await supabase.from('ontology_relationships')
        .update({ source_node_id: survivorId })
        .eq('project_id', projectId)
        .eq('source_node_id', oldId);

      await supabase.from('ontology_relationships')
        .update({ target_node_id: survivorId })
        .eq('project_id', projectId)
        .eq('target_node_id', oldId);
    }

    // Re-point tension markers — replace non-survivor IDs with survivor in each array
    for (const tension of tensions) {
      const ids: string[] = tension.related_node_ids ?? [];
      if (!ids.some((id) => nonSurvivorIds.includes(id))) continue;

      const updatedIds = [...new Set(
        ids.map((id) => (nonSurvivorIds.includes(id) ? survivorId : id))
      )];

      await supabase.from('tension_markers')
        .update({ related_node_ids: updatedIds })
        .eq('id', tension.id);
    }

    // Delete non-survivor nodes
    for (const oldId of nonSurvivorIds) {
      await supabase.from('ontology_nodes').delete().eq('id', oldId);
    }
    totalDeleted += nonSurvivorIds.length;

    // Keep in-memory rels accurate for subsequent merge groups in this batch
    for (const rel of rels) {
      if (nonSurvivorIds.includes(rel.source_node_id)) rel.source_node_id = survivorId;
      if (nonSurvivorIds.includes(rel.target_node_id))  rel.target_node_id  = survivorId;
    }
  }

  // Deduplicate relationships: after re-pointing, some may now share (source, target, type)
  const { data: postRels } = await supabase
    .from('ontology_relationships')
    .select('id, source_node_id, target_node_id, type')
    .eq('project_id', projectId);

  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const rel of postRels ?? []) {
    const key = `${rel.source_node_id}|${rel.target_node_id}|${rel.type}`;
    if (seen.has(key)) {
      dupes.push(rel.id);
    } else {
      seen.add(key);
    }
  }
  if (dupes.length > 0) {
    await supabase.from('ontology_relationships').delete().in('id', dupes);
  }

  return totalDeleted;
}

/**
 * Inserts new cross-document relationships.
 * Validates that both entity endpoints exist (they may have shifted after merges).
 * Skips any that would create a duplicate (same source, target, type).
 *
 * Returns the number of relationships actually inserted.
 */
export async function addCrossDocRelationships(
  projectId: string,
  newRelationships: CrossDocRelationship[]
): Promise<number> {
  if (newRelationships.length === 0) return 0;

  // Validate entity IDs against current node set (post-merge)
  const { data: existingNodes } = await supabase
    .from('ontology_nodes')
    .select('id')
    .eq('project_id', projectId);
  const validIds = new Set((existingNodes ?? []).map((n) => n.id));

  // Build dedup key set from current relationships
  const { data: existingRels } = await supabase
    .from('ontology_relationships')
    .select('source_node_id, target_node_id, type')
    .eq('project_id', projectId);
  const existingKeys = new Set(
    (existingRels ?? []).map((r) => `${r.source_node_id}|${r.target_node_id}|${r.type}`)
  );

  const toInsert: {
    id: string; rel_id: string; project_id: string;
    source_node_id: string; target_node_id: string;
    type: string; description: string | null;
  }[] = [];

  for (const rel of newRelationships) {
    if (!validIds.has(rel.sourceEntityId) || !validIds.has(rel.targetEntityId)) {
      console.warn(`[integrate] Skipping cross-doc rel — entity not found: ${rel.sourceEntityId} → ${rel.targetEntityId}`);
      continue;
    }
    const key = `${rel.sourceEntityId}|${rel.targetEntityId}|${rel.type}`;
    if (existingKeys.has(key)) continue;

    const newId = uuidv4();
    toInsert.push({
      id:             newId,
      rel_id:         newId,  // legacy NOT NULL column — mirrors uuid id
      project_id:     projectId,
      source_node_id: rel.sourceEntityId,
      target_node_id: rel.targetEntityId,
      type:           rel.type,
      description:    rel.description ?? null,
    });
    existingKeys.add(key); // prevent intra-batch dupes
  }

  if (toInsert.length === 0) return 0;

  const { error } = await supabase.from('ontology_relationships').insert(toInsert);
  if (error) throw new Error(`addCrossDocRelationships: ${error.message}`);

  return toInsert.length;
}

/**
 * Applies attractor reassignments — updates the `attractor` field on individual nodes.
 * Scoped to the project for safety. Logs and continues on per-node failures.
 *
 * Returns the number of nodes successfully reassigned.
 */
export async function reassignAttractors(
  projectId: string,
  reassignments: AttractorReassignment[]
): Promise<number> {
  if (reassignments.length === 0) return 0;

  let count = 0;
  for (const r of reassignments) {
    const { error } = await supabase
      .from('ontology_nodes')
      .update({ attractor: r.newAttractor })
      .eq('id', r.entityId)
      .eq('project_id', projectId); // project scope guard

    if (error) {
      console.warn(`[integrate] Failed to reassign attractor for ${r.entityId}: ${error.message}`);
    } else {
      count++;
    }
  }
  return count;
}

// ── Signal deduplication helpers ─────────────────────────────────────────────

/**
 * Executes signal merge groups against Supabase.
 *
 * For each group:
 *  1. Picks the signal with the highest strength as the survivor (ties broken by list order)
 *  2. Updates survivor with canonical label + description + direction
 *  3. Deletes non-survivors
 *
 * Returns the updated evaluative signal list (survivors only, with canonical data applied).
 */
export async function executeSignalMerges(
  projectId: string,
  mergeGroups: import("@/lib/gemini").SignalMergeGroup[],
  signals: EvaluativeSignal[]
): Promise<EvaluativeSignal[]> {
  if (mergeGroups.length === 0) return signals;

  let updated = [...signals];

  for (const group of mergeGroups) {
    const { canonicalLabel, canonicalDescription, canonicalDirection, signalIdsToMerge } = group;
    if (!signalIdsToMerge || signalIdsToMerge.length < 2) continue;

    const members = signalIdsToMerge
      .map((id) => updated.find((s) => s.id === id))
      .filter(Boolean) as EvaluativeSignal[];
    if (members.length < 2) continue;

    // Survivor = highest strength (ties broken by order)
    const survivor     = members.reduce((best, s) => (s.strength ?? 0) >= (best.strength ?? 0) ? s : best);
    const nonSurvivors = members.filter((s) => s.id !== survivor.id);

    // Update survivor in Supabase
    const { error: updateErr } = await supabase
      .from("evaluative_signals")
      .update({
        label:              canonicalLabel,
        source_description: canonicalDescription,
        direction:          canonicalDirection,
      })
      .eq("id", survivor.id)
      .eq("project_id", projectId);

    if (updateErr) {
      console.warn(`[dedup] Failed to update survivor ${survivor.id}: ${updateErr.message}`);
      continue;
    }

    // Delete non-survivors from Supabase (batch)
    if (nonSurvivors.length > 0) {
      const { error: deleteErr } = await supabase
        .from("evaluative_signals")
        .delete()
        .in("id", nonSurvivors.map((s) => s.id))
        .eq("project_id", projectId);
      if (deleteErr) {
        console.warn(`[dedup] Failed to delete non-survivors for survivor ${survivor.id}: ${deleteErr.message}`);
        continue;
      }
    }

    // Update in-memory list: remove non-survivors, patch survivor
    const nonSurvivorIds = new Set(nonSurvivors.map((s) => s.id));
    updated = updated
      .filter((s) => !nonSurvivorIds.has(s.id))
      .map((s) =>
        s.id === survivor.id
          ? { ...s, label: canonicalLabel, sourceDescription: canonicalDescription, direction: canonicalDirection }
          : s
      );
  }

  return updated;
}

// ── Ontology load / save ─────────────────────────────────────────────────────
//
// loadOntology: fetches all 5 ontology tables for a project in parallel and
//               maps DB rows → TypeScript interfaces (GraphState).
//
// saveOntology: upserts the full GraphState, then deletes any rows that are no
//               longer present in the state (by comparing IDs).

export async function loadOntology(projectId: string): Promise<GraphState> {
  const [nodesRes, relsRes, tensionsRes, signalsRes, entityTypesRes] = await Promise.all([
    supabase.from('ontology_nodes').select('*').eq('project_id', projectId),
    supabase.from('ontology_relationships').select('*').eq('project_id', projectId),
    supabase.from('tension_markers').select('*').eq('project_id', projectId),
    supabase.from('evaluative_signals').select('*').eq('project_id', projectId),
    supabase.from('entity_type_configs').select('*').eq('project_id', projectId),
  ]);

  if (nodesRes.error) throw new Error(`loadOntology nodes: ${nodesRes.error.message}`);
  if (relsRes.error) throw new Error(`loadOntology rels: ${relsRes.error.message}`);
  if (tensionsRes.error) throw new Error(`loadOntology tensions: ${tensionsRes.error.message}`);
  if (signalsRes.error) throw new Error(`loadOntology signals: ${signalsRes.error.message}`);
  if (entityTypesRes.error) throw new Error(`loadOntology entityTypes: ${entityTypesRes.error.message}`);

  const nodes: GraphNode[] = (nodesRes.data ?? []).map((row) => ({
    id: row.id,
    label: row.label,
    type: row.type,
    attractor: row.attractor ?? 'emergent',
    is_hub: row.is_hub === true,
    description: row.description ?? '',
    position: { x: row.position_x ?? 0, y: row.position_y ?? 0 },
    properties: row.properties ?? {},
    sourceType: row.source_type as SessionAgent ?? 'manual',
    sharingScope: row.sharing_scope ?? 'private',
  }));

  const relationships: Relationship[] = (relsRes.data ?? []).map((row) => ({
    id: row.id,
    sourceId: row.source_node_id,
    targetId: row.target_node_id,
    type: row.type,
    description: row.description ?? undefined,
  }));

  const tensions: TensionMarker[] = (tensionsRes.data ?? []).map((row) => ({
    id: row.id,
    description: row.description,
    relatedNodeIds: row.related_node_ids ?? [],
    status: row.status,
    scope: (row.scope as "local" | "cross-graph") ?? "local",
  }));

  // ── Load signal-to-node links (junction table) ──────────────────────────
  // Falls back gracefully if the table doesn't exist yet (pre-migration).
  let signalNodeMap: Record<string, string[]> = {};
  try {
    const { data: linkData } = await supabase
      .from('signal_node_links')
      .select('signal_id, node_id')
      .in('signal_id', (signalsRes.data ?? []).map((s) => s.id));
    if (linkData) {
      for (const link of linkData) {
        if (!signalNodeMap[link.signal_id]) signalNodeMap[link.signal_id] = [];
        signalNodeMap[link.signal_id].push(link.node_id);
      }
    }
  } catch {
    // Table doesn't exist yet — signals load without node links
  }

  const evaluativeSignals: EvaluativeSignal[] = (signalsRes.data ?? []).map((row) => ({
    id: row.id,
    label: row.label,
    direction: row.direction,
    strength: row.strength,
    intensity: row.strength, // strength is the DB column; intensity is the semantic alias
    thresholdProximity: row.threshold_proximity ?? null,
    atCostOf: row.at_cost_of ?? null,
    sourceDescription: row.source_description ?? '',
    // Temporal horizon — nullable until classified
    temporalHorizon: row.temporal_horizon ?? null,
    // Graph connections — from junction table
    relatedNodeIds: signalNodeMap[row.id] ?? [],
    // Reflect verdict — nullable until the user judges the signal
    resonance: row.resonance ?? null,
    reflectedAt: row.reflected_at ?? null,
    userNote: row.user_note ?? null,
    sharingScope: row.sharing_scope ?? 'private',
  }));

  const entityTypes: EntityTypeConfig[] = (entityTypesRes.data ?? []).map((row) => ({
    id: row.type_id,   // type_id is the slug ("organisation"); id is the auto-generated UUID PK
    label: row.label,
    color: row.color,
  }));

  return { nodes, relationships, tensions, evaluativeSignals, entityTypes };
}

/**
 * Loads an ontology with parent project nodes merged in (if applicable).
 * Parent nodes are tagged as readonly — visible but not editable from the child project.
 */
export async function loadOntologyWithParent(
  projectId: string,
  parentProjectId?: string | null
): Promise<GraphState> {
  const childGraph = await loadOntology(projectId);

  if (!parentProjectId) return childGraph;

  const parentGraph = await loadOntology(parentProjectId);

  // Tag parent nodes as readonly
  const parentNodes = parentGraph.nodes.map((n) => ({ ...n, readonly: true }));

  // Merge: parent nodes first, then child nodes (child can shadow parent if same ID)
  const childNodeIds = new Set(childGraph.nodes.map((n) => n.id));
  const mergedNodes = [
    ...parentNodes.filter((n) => !childNodeIds.has(n.id)),
    ...childGraph.nodes,
  ];

  // Merge relationships — include parent relationships that reference at least one visible node
  const allNodeIds = new Set(mergedNodes.map((n) => n.id));
  const childRelIds = new Set(childGraph.relationships.map((r) => r.id));
  const parentRels = parentGraph.relationships.filter(
    (r) => !childRelIds.has(r.id) && allNodeIds.has(r.sourceId) && allNodeIds.has(r.targetId)
  );

  return {
    ...childGraph,
    nodes: mergedNodes,
    relationships: [...parentRels, ...childGraph.relationships],
    // Keep child entity types but merge parent's too
    entityTypes: [
      ...parentGraph.entityTypes.filter(
        (pt) => !childGraph.entityTypes.some((ct) => ct.id === pt.id)
      ),
      ...childGraph.entityTypes,
    ],
  };
}

export async function saveOntology(projectId: string, state: GraphState): Promise<void> {
  // ── Upsert nodes ──────────────────────────────────────────────────────────
  if (state.nodes.length > 0) {
    const { error } = await supabase.from('ontology_nodes').upsert(
      state.nodes.filter((n) => !n.readonly).map((n) => ({
        id: n.id,
        node_id: n.id,  // legacy NOT NULL column — mirrors uuid id
        project_id: projectId,
        label: n.label,
        type: n.type,
        attractor: n.attractor ?? 'emergent',
        is_hub: n.is_hub === true,
        description: n.description,
        position_x: n.position.x,
        position_y: n.position.y,
        properties: n.properties ?? {},
        source_type: n.sourceType ?? 'manual',
        sharing_scope: n.sharingScope ?? 'private',
      })),
      { onConflict: 'id', ignoreDuplicates: false }
    );
    if (error) throw new Error(`saveOntology nodes: ${error.message}`);
  }

  // ── Upsert relationships ──────────────────────────────────────────────────
  if (state.relationships.length > 0) {
    const { error } = await supabase.from('ontology_relationships').upsert(
      state.relationships.map((r) => ({
        id: r.id,
        rel_id: r.id,  // legacy NOT NULL column — mirrors uuid id
        project_id: projectId,
        source_node_id: r.sourceId,
        target_node_id: r.targetId,
        type: r.type,
        description: r.description ?? null,
      })),
      { onConflict: 'id', ignoreDuplicates: false }
    );
    if (error) throw new Error(`saveOntology rels: ${error.message}`);
  }

  // ── Upsert tension markers ────────────────────────────────────────────────
  if (state.tensions.length > 0) {
    const { error } = await supabase.from('tension_markers').upsert(
      state.tensions.map((t) => ({
        id: t.id,
        tension_id: t.id,  // legacy NOT NULL column — mirrors uuid id
        project_id: projectId,
        description: t.description,
        related_node_ids: t.relatedNodeIds,
        status: t.status,
        scope: t.scope ?? "local",
      })),
      { onConflict: 'id', ignoreDuplicates: false }
    );
    if (error) throw new Error(`saveOntology tensions: ${error.message}`);
  }

  // ── Upsert evaluative signals ─────────────────────────────────────────────
  if (state.evaluativeSignals.length > 0) {
    const { error } = await supabase.from('evaluative_signals').upsert(
      state.evaluativeSignals.map((s) => ({
        id: s.id,
        signal_id: s.id,  // legacy NOT NULL column — mirrors uuid id
        project_id: projectId,
        label: s.label,
        direction: s.direction,
        strength: Math.round(s.intensity ?? s.strength),
        source_description: s.sourceDescription,
        threshold_proximity: s.thresholdProximity ?? null,
        at_cost_of: s.atCostOf ?? null,
        temporal_horizon: s.temporalHorizon ?? null,
        // Preserve reflect verdict — null means unjudged, not "clear existing value"
        resonance: s.resonance ?? null,
        reflected_at: s.reflectedAt ?? null,
        user_note: s.userNote ?? null,
        sharing_scope: s.sharingScope ?? 'private',
      })),
      { onConflict: 'id', ignoreDuplicates: false }
    );
    if (error) throw new Error(`saveOntology signals: ${error.message}`);

    // ── Sync signal-to-node links (junction table) ───────────────────────
    // Replace-all strategy: delete ALL existing links for current signals,
    // then re-insert only those that still have links. This ensures signals
    // that lost their links get cleaned up too.
    // Falls back gracefully if the table doesn't exist yet (pre-migration).
    try {
      const allSignalIds = state.evaluativeSignals.map((s) => s.id);
      if (allSignalIds.length > 0) {
        await supabase
          .from('signal_node_links')
          .delete()
          .in('signal_id', allSignalIds);
      }

      const links = state.evaluativeSignals.flatMap((s) =>
        (s.relatedNodeIds ?? []).map((nodeId) => ({
          signal_id: s.id,
          node_id: nodeId,
        }))
      );
      if (links.length > 0) {
        await supabase.from('signal_node_links').insert(links);
      }
    } catch {
      // Table doesn't exist yet — skip silently
    }
  }

  // ── Upsert entity type configs ────────────────────────────────────────────
  // Non-fatal: the onConflict clause requires a unique index on (project_id, type_id)
  // in Supabase. If that index is missing the upsert returns 400. Entity types
  // are rebuilt from graph nodes on every load (syncTypesFromGraph), so a failed
  // persist here is acceptable — it just means colours won't survive a cold reload
  // from Supabase alone. Run supabase/migrations/001_entity_type_unique_constraint.sql
  // to fix this permanently.
  if (state.entityTypes.length > 0) {
    const { error } = await supabase.from('entity_type_configs').upsert(
      state.entityTypes.map((et) => ({
        type_id: et.id,   // et.id is the slug; type_id is the text column; id PK is auto-generated
        project_id: projectId,
        label: et.label,
        color: et.color,
      })),
      { onConflict: 'project_id,type_id', ignoreDuplicates: false }
    );
    if (error) {
      // Log but don't throw — entity types are derived from nodes and can be
      // reconstructed client-side, so this failure is non-blocking.
      console.warn(`saveOntology entityTypes (non-fatal): ${error.message}`);
    }
  }

  // ── Delete rows removed from state ────────────────────────────────────────
  // Strategy: SELECT existing DB IDs → diff against local state → DELETE only the
  // removed IDs. This avoids NOT IN (all current IDs) which generates URLs that
  // exceed PostgREST's limit for large graphs (300+ nodes).

  const nodeIds    = new Set(state.nodes.map((n) => n.id));
  const relIds     = new Set(state.relationships.map((r) => r.id));
  const tensionIds = new Set(state.tensions.map((t) => t.id));
  const signalIds  = new Set(state.evaluativeSignals.map((s) => s.id));

  const [dbNodes, dbRels, dbTensions, dbSignals] = await Promise.all([
    supabase.from('ontology_nodes').select('id').eq('project_id', projectId),
    supabase.from('ontology_relationships').select('id').eq('project_id', projectId),
    supabase.from('tension_markers').select('id').eq('project_id', projectId),
    supabase.from('evaluative_signals').select('id').eq('project_id', projectId),
  ]);

  const removedNodes    = (dbNodes.data    ?? []).map((r) => r.id).filter((id) => !nodeIds.has(id));
  const removedRels     = (dbRels.data     ?? []).map((r) => r.id).filter((id) => !relIds.has(id));
  const removedTensions = (dbTensions.data ?? []).map((r) => r.id).filter((id) => !tensionIds.has(id));
  const removedSignals  = (dbSignals.data  ?? []).map((r) => r.id).filter((id) => !signalIds.has(id));

  await Promise.all([
    removedNodes.length    > 0 ? supabase.from('ontology_nodes').delete().in('id', removedNodes) : null,
    removedRels.length     > 0 ? supabase.from('ontology_relationships').delete().in('id', removedRels) : null,
    removedTensions.length > 0 ? supabase.from('tension_markers').delete().in('id', removedTensions) : null,
    removedSignals.length  > 0 ? supabase.from('evaluative_signals').delete().in('id', removedSignals) : null,
  ].filter(Boolean));
}

// ── Session logging ──────────────────────────────────────────────────────────

export async function logSession(input: {
  project_id: string;
  type: SessionType;
  agent: SessionAgent;
  summary: string;
  raw_output?: unknown;
}): Promise<string> {
  const { data, error } = await supabase
    .from('sessions')
    .insert({
      project_id: input.project_id,
      type: input.type,
      agent: input.agent,
      summary: input.summary,
      raw_output: input.raw_output ?? null,
    })
    .select('id')
    .single();

  if (error) throw new Error(`logSession: ${error.message}`);
  return data.id;
}

export async function getSessions(projectId: string): Promise<{
  id: string;
  type: SessionType;
  agent: SessionAgent;
  summary: string;
  created_at: string;
}[]> {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, type, agent, summary, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getSessions: ${error.message}`);
  return data ?? [];
}

// ── Project-scoped vector search ─────────────────────────────────────────────

export async function searchChunks(
  projectId: string,
  queryEmbedding: number[],
  matchCount = 5
): Promise<SearchResult[]> {
  const { data, error } = await supabase.rpc('search_chunks_v2', {
    p_project_id: projectId,
    query_embedding: queryEmbedding,
    match_count: matchCount,
  });

  if (error) throw new Error(`searchChunks: ${error.message}`);
  return data ?? [];
}

// ── Cross-project commons ───────────────────────────────────────────────────
//
// Queries nodes, signals, and tensions that have been explicitly shared
// (sharing_scope != 'private'). Used by the commons synthesis pass to
// compare multiple projects without exposing private data.

const SCOPE_HIERARCHY: SharingScope[] = ['team', 'division', 'company'];

function scopeFilter(requestedScope: SharingScope): SharingScope[] {
  if (requestedScope === 'private') return [];
  const idx = SCOPE_HIERARCHY.indexOf(requestedScope);
  return SCOPE_HIERARCHY.slice(idx);
}

export async function getSharedProjectPayload(
  projectId: string,
  scope: SharingScope
): Promise<CompactProjectPayload> {
  const allowedScopes = scopeFilter(scope);
  if (allowedScopes.length === 0) {
    return { projectId, projectName: '', nodes: [], signals: [], tensions: [] };
  }

  const [project, nodesRes, signalsRes, tensionsRes] = await Promise.all([
    getProject(projectId),
    supabase
      .from('ontology_nodes')
      .select('id, label, type, description, sharing_scope, is_hub')
      .eq('project_id', projectId)
      .in('sharing_scope', allowedScopes),
    supabase
      .from('evaluative_signals')
      .select('label, direction, strength, threshold_proximity, sharing_scope')
      .eq('project_id', projectId)
      .in('sharing_scope', allowedScopes),
    supabase
      .from('tension_markers')
      .select('description')
      .eq('project_id', projectId),
  ]);

  if (nodesRes.error) throw new Error(`getSharedProjectPayload nodes: ${nodesRes.error.message}`);
  if (signalsRes.error) throw new Error(`getSharedProjectPayload signals: ${signalsRes.error.message}`);
  if (tensionsRes.error) throw new Error(`getSharedProjectPayload tensions: ${tensionsRes.error.message}`);

  return {
    projectId,
    projectName: project?.name ?? projectId,
    nodes: (nodesRes.data ?? [])
      .filter((r) => r.is_hub !== true)
      .map((r) => ({
        id: r.id,
        label: r.label ?? '',
        type: r.type ?? 'concept',
        description: (r.description ?? '').slice(0, 100),
      })),
    signals: (signalsRes.data ?? []).map((r) => ({
      label: r.label ?? '',
      direction: r.direction ?? 'toward',
      strength: r.strength ?? 0,
      thresholdProximity: r.threshold_proximity ?? null,
    })),
    tensions: (tensionsRes.data ?? []).map((r) => ({
      label: r.description ?? '',
      description: r.description ?? '',
    })),
  };
}

export async function updateSharingScope(
  table: 'ontology_nodes' | 'evaluative_signals',
  ids: string[],
  scope: SharingScope
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from(table)
    .update({ sharing_scope: scope })
    .in('id', ids);
  if (error) throw new Error(`updateSharingScope (${table}): ${error.message}`);
}

// ── Graph snapshots ──────────────────────────────────────────────────────────
//
// One snapshot per integration run, stored in `graph_snapshots`.
// The Session Delta narration diffs the latest two snapshots to describe
// what changed since the last integration.
//
// SQL migration (007_graph_snapshots.sql) — paste into Supabase SQL Editor:
//
//   CREATE TABLE IF NOT EXISTS graph_snapshots (
//     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
//     snapshot_json JSONB NOT NULL,
//     trigger     TEXT,
//     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
//   );
//   CREATE INDEX ON graph_snapshots (project_id, created_at DESC);
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize the current graph state for a project and store it as a snapshot.
 * Called at the end of /api/integrate so each integration run is checkpointed.
 */
export async function createSnapshot(
  projectId: string,
  trigger: "integration" | "manual" = "integration"
): Promise<void> {
  const state = await loadOntology(projectId);
  const { error } = await supabase.from("graph_snapshots").insert({
    project_id: projectId,
    snapshot_json: state as unknown as Record<string, unknown>,
    trigger,
  });
  if (error) throw new Error(`createSnapshot: ${error.message}`);
}

/**
 * Load the two most recent snapshots for a project (newest first).
 * Returns an empty array if the table doesn't exist yet (pre-migration).
 */
export async function getLatestTwoSnapshots(
  projectId: string
): Promise<{ id: string; snapshot_json: GraphState; created_at: string }[]> {
  try {
    const { data, error } = await supabase
      .from("graph_snapshots")
      .select("id, snapshot_json, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(2);
    if (error) throw error;
    return (data ?? []) as { id: string; snapshot_json: GraphState; created_at: string }[];
  } catch (err) {
    console.warn("[getLatestTwoSnapshots] Failed (non-fatal):", err);
    return [];
  }
}
