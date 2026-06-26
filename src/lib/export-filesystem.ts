/**
 * export-filesystem.ts — Serialises a Terroir project from Supabase into a
 * markdown folder structure that any agent can read with filesystem tools alone.
 *
 * Architecture: Supabase is the source of truth. The folder is a one-way
 * projection. Writes still go through Terroir UI / Canal.
 *
 * Output shape:
 *   <outputRoot>/<project-slug>/
 *     README.md
 *     _meta/export.json        ← full JSON mirror (lossless)
 *     _meta/schema-version.txt
 *     hubs/<slug>.md
 *     nodes/<slug>.md
 *     signals/<slug>.md
 *     tensions/<slug>.md
 *
 * Slug rules: lowercase, hyphenated, ASCII. Collisions resolved with a
 * 6-char UUID fragment. Slugs are per-folder — hubs/ and nodes/ can share a
 * slug without collision.
 *
 * Frontmatter uses js-yaml to serialise all user-controlled text safely.
 * The `relationships` array in node frontmatter lists outgoing semantic edges
 * only; hub-membership edges (belongs_to_hub) are surfaced via the `hub` field.
 * Do NOT duplicate relationships on target nodes — frontmatter is authoritative,
 * wikilinks in the body are derived for human legibility only.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import yaml from "js-yaml";
import { loadOntology, getProject } from "./supabase";
import { buildProjectBundle } from "./export";
import { HUB_RELATIONSHIP_TYPE } from "@/types";
import type {
  GraphNode,
  Relationship,
  EvaluativeSignal,
  TensionMarker,
  ProjectBrief,
} from "@/types";

// ── Public API ────────────────────────────────────────────────────────────────

export type ExportResult = {
  projectSlug: string;
  filesWritten: string[];
  counts: { hubs: number; nodes: number; signals: number; tensions: number };
  exportedAt: string;
};

export async function exportProjectToFilesystem(
  projectId: string,
  outputRoot: string
): Promise<ExportResult> {
  if (process.env.VERCEL) {
    throw new Error(
      "Filesystem export only works in local dev. Run `npm run dev` and trigger the export from localhost."
    );
  }

  const exportedAt = new Date().toISOString();

  const [project, graphState] = await Promise.all([
    getProject(projectId),
    loadOntology(projectId),
  ]);

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const brief =
    (project.metadata?.brief as Record<string, unknown> | null) ?? null;
  const attractorPreset =
    (project.metadata?.attractorPreset as string | null) ?? null;
  const projectName = project.name;

  const projectSlug = toSlug(projectName) || project.id.slice(0, 8);
  const projectDir = path.join(outputRoot, projectSlug);

  // Wipe project folder then recreate directory tree.
  // Never wipes outside <outputRoot>/<projectSlug>/.
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.mkdir(path.join(projectDir, "_meta"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "hubs"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "nodes"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "signals"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "tensions"), { recursive: true });

  const filesWritten: string[] = [];

  // ── Build slug maps ────────────────────────────────────────────────────────
  // Separate Set per folder so hubs/customer.md and nodes/customer.md coexist.
  const hubSlugSet = new Set<string>();
  const nodeSlugSet = new Set<string>();
  const signalSlugSet = new Set<string>();
  const tensionSlugSet = new Set<string>();

  const nodeSlugMap = new Map<string, string>(); // nodeId → slug
  const nodeLabelMap = new Map<string, string>(); // nodeId → label

  for (const node of graphState.nodes) {
    nodeLabelMap.set(node.id, node.label);
    const slugSet = node.is_hub ? hubSlugSet : nodeSlugSet;
    nodeSlugMap.set(node.id, slugify(node.label, slugSet, node.id));
  }

  const signalSlugMap = new Map<string, string>(); // signalId → slug
  for (const signal of graphState.evaluativeSignals) {
    signalSlugMap.set(
      signal.id,
      slugify(signal.label, signalSlugSet, signal.id)
    );
  }

  const tensionSlugMap = new Map<string, string>(); // tensionId → slug
  for (const tension of graphState.tensions) {
    const base =
      tension.relatedNodeIds
        .map((id) => nodeLabelMap.get(id))
        .filter(Boolean)
        .join("-vs-") || "tension";
    tensionSlugMap.set(tension.id, slugify(base, tensionSlugSet, tension.id));
  }

  // ── Build per-node signal index ────────────────────────────────────────────
  const signalsByNodeId = new Map<
    string,
    Array<{ slug: string; label: string }>
  >();
  for (const signal of graphState.evaluativeSignals) {
    const slug = signalSlugMap.get(signal.id)!;
    for (const nodeId of signal.relatedNodeIds ?? []) {
      if (!signalsByNodeId.has(nodeId)) signalsByNodeId.set(nodeId, []);
      signalsByNodeId.get(nodeId)!.push({ slug, label: signal.label });
    }
  }

  // ── Write hub files ────────────────────────────────────────────────────────
  const hubNodes = graphState.nodes.filter((n) => n.is_hub === true);
  for (const hub of hubNodes) {
    const content = serializeNode(
      hub,
      nodeSlugMap,
      graphState.relationships,
      signalsByNodeId
    );
    const slug = nodeSlugMap.get(hub.id)!;
    const filePath = path.join(projectDir, "hubs", `${slug}.md`);
    await fs.writeFile(filePath, content, "utf-8");
    filesWritten.push(filePath);
  }

  // ── Write regular node files ───────────────────────────────────────────────
  const regularNodes = graphState.nodes.filter((n) => !n.is_hub);
  for (const node of regularNodes) {
    const content = serializeNode(
      node,
      nodeSlugMap,
      graphState.relationships,
      signalsByNodeId
    );
    const slug = nodeSlugMap.get(node.id)!;
    const filePath = path.join(projectDir, "nodes", `${slug}.md`);
    await fs.writeFile(filePath, content, "utf-8");
    filesWritten.push(filePath);
  }

  // ── Write signal files ─────────────────────────────────────────────────────
  for (const signal of graphState.evaluativeSignals) {
    const slug = signalSlugMap.get(signal.id)!;
    const content = serializeSignal(signal, slug, nodeSlugMap);
    const filePath = path.join(projectDir, "signals", `${slug}.md`);
    await fs.writeFile(filePath, content, "utf-8");
    filesWritten.push(filePath);
  }

  // ── Write tension files ────────────────────────────────────────────────────
  for (const tension of graphState.tensions) {
    const slug = tensionSlugMap.get(tension.id)!;
    const content = serializeTension(tension, slug, nodeSlugMap, nodeLabelMap);
    const filePath = path.join(projectDir, "tensions", `${slug}.md`);
    await fs.writeFile(filePath, content, "utf-8");
    filesWritten.push(filePath);
  }

  // ── Graph summary (for README + counts) ───────────────────────────────────
  const semanticRels = graphState.relationships.filter(
    (r) => r.type !== HUB_RELATIONSHIP_TYPE
  );
  const attractorDistribution: Record<string, number> = {};
  for (const hub of hubNodes) {
    const memberCount = graphState.relationships.filter(
      (r) => r.type === HUB_RELATIONSHIP_TYPE && r.targetId === hub.id
    ).length;
    attractorDistribution[hub.label] = memberCount;
  }

  // ── Write README.md ────────────────────────────────────────────────────────
  const readmeContent = serializeProjectReadme({
    projectId,
    projectName,
    brief,
    attractorPreset,
    exportedAt,
    graphSummary: {
      hubs: hubNodes.length,
      nodes: regularNodes.length,
      signals: graphState.evaluativeSignals.length,
      tensions: graphState.tensions.length,
      relationships: semanticRels.length,
      attractorDistribution,
    },
  });
  const readmePath = path.join(projectDir, "README.md");
  await fs.writeFile(readmePath, readmeContent, "utf-8");
  filesWritten.push(readmePath);

  // ── Write _meta/schema-version.txt ────────────────────────────────────────
  const schemaPath = path.join(projectDir, "_meta", "schema-version.txt");
  await fs.writeFile(schemaPath, "1.0\n", "utf-8");
  filesWritten.push(schemaPath);

  // ── Write _meta/export.json ────────────────────────────────────────────────
  // Full machine-readable mirror — lossless round-trip even if the markdown
  // format drops something. Agents that prefer structured data read this.
  const bundle = buildProjectBundle({
    projectName,
    graphState,
    projectBrief: brief as ProjectBrief | null,
    synthesisResult: null,
    attractorPreset,
  });
  const exportJsonPath = path.join(projectDir, "_meta", "export.json");
  await fs.writeFile(exportJsonPath, JSON.stringify(bundle, null, 2), "utf-8");
  filesWritten.push(exportJsonPath);

  return {
    projectSlug,
    filesWritten,
    counts: {
      hubs: hubNodes.length,
      nodes: regularNodes.length,
      signals: graphState.evaluativeSignals.length,
      tensions: graphState.tensions.length,
    },
    exportedAt,
  };
}

// ── Serializers ───────────────────────────────────────────────────────────────

function serializeNode(
  node: GraphNode,
  nodeSlugMap: Map<string, string>,
  allRels: Relationship[],
  signalsByNodeId: Map<string, Array<{ slug: string; label: string }>>
): string {
  // Semantic outgoing edges (not hub membership)
  const outgoing = allRels.filter(
    (r) => r.sourceId === node.id && r.type !== HUB_RELATIONSHIP_TYPE
  );

  // Hub membership
  const hubRels = allRels.filter(
    (r) => r.sourceId === node.id && r.type === HUB_RELATIONSHIP_TYPE
  );
  const hubSlugs = hubRels
    .map((r) => nodeSlugMap.get(r.targetId))
    .filter((s): s is string => s != null);

  const frontmatterData: Record<string, unknown> = {
    id: node.id,
    label: node.label,
    slug: nodeSlugMap.get(node.id) ?? "",
    type: node.type,
    attractor: node.attractor ?? "emergent",
    hub: hubSlugs[0] ?? null,
    // If multi-hub, list all; first is still primary
    ...(hubSlugs.length > 1 ? { hubs: hubSlugs } : {}),
    is_hub: node.is_hub ?? false,
    position: node.position,
    // Outgoing semantic relationships — authoritative source.
    // Do not duplicate on the target node.
    relationships: outgoing.map((r) => ({
      target: nodeSlugMap.get(r.targetId) ?? r.targetId,
      target_id: r.targetId,
      type: r.type,
      description: r.description ?? null,
    })),
  };

  const lines: string[] = [makeFrontmatter(frontmatterData), "", `# ${node.label}`, ""];

  if (node.description) {
    lines.push(node.description);
  }

  // Derived wikilinks for human legibility (relationships frontmatter is authoritative)
  if (outgoing.length > 0) {
    lines.push("", "## Related");
    for (const r of outgoing) {
      const targetSlug = nodeSlugMap.get(r.targetId);
      if (targetSlug) lines.push(`- [[${targetSlug}]]`);
    }
  }

  const touchingSignals = signalsByNodeId.get(node.id) ?? [];
  if (touchingSignals.length > 0) {
    lines.push("", "## Signals touching this node");
    for (const s of touchingSignals) {
      lines.push(`- [[${s.slug}]]`);
    }
  }

  return lines.join("\n");
}

function serializeSignal(
  signal: EvaluativeSignal,
  slug: string,
  nodeSlugMap: Map<string, string>
): string {
  const relatedSlugs = (signal.relatedNodeIds ?? [])
    .map((id) => nodeSlugMap.get(id))
    .filter((s): s is string => s != null);

  const frontmatterData: Record<string, unknown> = {
    id: signal.id,
    label: signal.label,
    slug,
    direction: signal.direction,
    strength: signal.strength,
    resonance: signal.resonance ?? null,
    temporal_horizon: signal.temporalHorizon ?? null,
    source_description: signal.sourceDescription,
    reflected_at: signal.reflectedAt ?? null,
    user_note: signal.userNote ?? null,
    related_nodes: relatedSlugs,
    related_node_ids: signal.relatedNodeIds ?? [],
  };

  const lines: string[] = [
    makeFrontmatter(frontmatterData),
    "",
    `# ${signal.label}`,
    "",
    signal.sourceDescription,
  ];

  if (signal.userNote) {
    lines.push("", signal.userNote);
  }

  if (relatedSlugs.length > 0) {
    lines.push("", "## Touches");
    for (const s of relatedSlugs) lines.push(`- [[${s}]]`);
  }

  return lines.join("\n");
}

function serializeTension(
  tension: TensionMarker,
  slug: string,
  nodeSlugMap: Map<string, string>,
  nodeLabelMap: Map<string, string>
): string {
  const relatedSlugs = tension.relatedNodeIds
    .map((id) => nodeSlugMap.get(id))
    .filter((s): s is string => s != null);
  const relatedLabels = tension.relatedNodeIds
    .map((id) => nodeLabelMap.get(id))
    .filter((l): l is string => l != null);

  const title =
    relatedLabels.length >= 2
      ? `${relatedLabels[0]} ↔ ${relatedLabels[1]}`
      : slug;

  const frontmatterData: Record<string, unknown> = {
    id: tension.id,
    status: tension.status,
    between_nodes: relatedSlugs,
    between_node_ids: tension.relatedNodeIds,
  };

  return [
    makeFrontmatter(frontmatterData),
    "",
    `# Tension: ${title}`,
    "",
    tension.description,
  ].join("\n");
}

function serializeProjectReadme(opts: {
  projectId: string;
  projectName: string;
  brief: Record<string, unknown> | null;
  attractorPreset: string | null;
  exportedAt: string;
  graphSummary: {
    hubs: number;
    nodes: number;
    signals: number;
    tensions: number;
    relationships: number;
    attractorDistribution: Record<string, number>;
  };
}): string {
  const { projectId, projectName, brief, attractorPreset, exportedAt, graphSummary } = opts;

  const frontmatterData: Record<string, unknown> = {
    id: projectId,
    name: projectName,
    parent_project_id: null,
    attractor_preset: attractorPreset,
    schema_version: "1.0",
    exported_at: exportedAt,
  };

  const lines: string[] = [makeFrontmatter(frontmatterData), "", `# ${projectName}`];

  if (brief?.summary) {
    lines.push("", String(brief.summary));
  }

  if (brief?.discoveryGoal) {
    lines.push("", "## Discovery goal", "", String(brief.discoveryGoal));
  }

  const themes = Array.isArray(brief?.keyThemes)
    ? (brief!.keyThemes as string[])
    : [];
  if (themes.length > 0) {
    lines.push("", "## Key themes", ...themes.map((t) => `- ${t}`));
  }

  lines.push(
    "",
    "## Graph summary",
    `- Hubs: ${graphSummary.hubs}`,
    `- Nodes: ${graphSummary.nodes}`,
    `- Signals: ${graphSummary.signals}`,
    `- Tensions: ${graphSummary.tensions}`,
    `- Relationships: ${graphSummary.relationships}`
  );

  const dist = graphSummary.attractorDistribution;
  if (Object.keys(dist).length > 0) {
    lines.push("", "## Attractor distribution");
    for (const [label, count] of Object.entries(dist)) {
      lines.push(`- ${label}: ${count}`);
    }
  }

  return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Renders a YAML frontmatter block using js-yaml for safe serialisation. */
function makeFrontmatter(data: Record<string, unknown>): string {
  return `---\n${yaml.dump(data, { lineWidth: -1 }).trimEnd()}\n---`;
}

/** Converts a label to a URL-safe lowercase hyphenated ASCII slug. */
function toSlug(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Slugifies a label, resolving collisions within a folder by appending a
 * short UUID fragment. Registers the chosen slug in existingSlugs.
 */
function slugify(
  label: string,
  existingSlugs: Set<string>,
  fallbackId: string
): string {
  const base = toSlug(label) || "node";
  if (!existingSlugs.has(base)) {
    existingSlugs.add(base);
    return base;
  }
  const short = fallbackId.replace(/-/g, "").slice(0, 6);
  const withShort = `${base}-${short}`;
  if (!existingSlugs.has(withShort)) {
    existingSlugs.add(withShort);
    return withShort;
  }
  // Last resort: use the full UUID (guaranteed unique per node)
  const full = `${base}-${fallbackId.replace(/-/g, "")}`;
  existingSlugs.add(full);
  return full;
}
