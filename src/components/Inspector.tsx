"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import type { GraphState, GraphNode, Relationship, ProjectBrief, AttractorConfig, SharingScope } from "@/types";
import ProjectBriefPanel from "./ProjectBrief";

interface InspectorProps {
  graphState: GraphState;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onUpdateNode: (id: string, updates: Partial<Pick<GraphNode, "label" | "description" | "type" | "attractor" | "sharingScope">>) => void;
  attractors?: AttractorConfig[];
  onUpdateRelationship: (id: string, updates: Partial<Pick<Relationship, "type" | "description">>) => void;
  onClose: () => void;
  // ── Phase 2 additions (all optional so existing call-sites don't break) ──
  brief?: ProjectBrief | null;
  documentCount?: number;
  isReprocessing?: boolean;
  onBriefUpdate?: (updates: Partial<ProjectBrief>) => void;
  onStartScoping?: () => void;
  onReprocess?: () => void;
  projectId?: string;
}

export default function Inspector({
  graphState,
  selectedNodeId,
  selectedEdgeId,
  onUpdateNode,
  onUpdateRelationship,
  onClose,
  brief,
  documentCount = 0,
  isReprocessing = false,
  onBriefUpdate,
  onStartScoping,
  onReprocess,
  attractors = [],
  projectId,
}: InspectorProps) {
  const t = useTranslations();
  const selectedNode = selectedNodeId
    ? graphState.nodes.find((n) => n.id === selectedNodeId)
    : null;
  const selectedEdge = selectedEdgeId
    ? graphState.relationships.find((r) => r.id === selectedEdgeId)
    : null;

  const [editLabel, setEditLabel] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editType, setEditType] = useState("");
  const [editAttractor, setEditAttractor] = useState("");
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    setSyncStatus(null);
  }, [projectId]);

  useEffect(() => {
    if (selectedNode) {
      setEditLabel(selectedNode.label);
      setEditDescription(selectedNode.description);
      setEditType(selectedNode.type);
      setEditAttractor(selectedNode.attractor ?? "emergent");
    } else if (selectedEdge) {
      setEditLabel(selectedEdge.type);
      setEditDescription(selectedEdge.description || "");
    }
  }, [selectedNode, selectedEdge]);

  const handleSaveNode = () => {
    if (!selectedNode) return;
    onUpdateNode(selectedNode.id, {
      label: editLabel,
      description: editDescription,
      type: editType,
      attractor: editAttractor,
    });
  };

  const handleSaveEdge = () => {
    if (!selectedEdge) return;
    onUpdateRelationship(selectedEdge.id, {
      type: editLabel,
      description: editDescription || undefined,
    });
  };

  // ── Nothing selected → show brief (or CTA) + graph summary ─────────────────
  if (!selectedNode && !selectedEdge) {
    const unresolvedCount = graphState.tensions.filter(
      (t) => t.status === "unresolved"
    ).length;

    return (
      <div className="h-full flex flex-col bg-white border-l border-stone-200">
        <div className="px-4 py-3 border-b border-stone-200">
          <h3 className="text-sm font-semibold text-stone-800">{t("inspector.title")}</h3>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

          {/* ── Project Brief section ────────────────────────────────────── */}
          {brief ? (
            // Brief exists — show inline-editable panel
            <ProjectBriefPanel
              brief={brief}
              documentCount={documentCount}
              isReprocessing={isReprocessing}
              onBriefUpdate={onBriefUpdate ?? (() => {})}
              onStartScoping={onStartScoping ?? (() => {})}
              onReprocess={onReprocess ?? (() => {})}
            />
          ) : (
            // No brief yet — CTA
            <div className="space-y-2.5">
              <p className="text-xs text-stone-400 leading-relaxed">
                {t("inspector.setupPrompt")}
              </p>
              {onStartScoping && (
                <button
                  onClick={onStartScoping}
                  className="w-full rounded-xl bg-stone-800 py-2 text-xs font-medium text-white hover:bg-stone-700 transition-colors"
                >
                  {t("inspector.setupButton")}
                </button>
              )}
            </div>
          )}

          {/* ── Graph Summary (always visible below brief) ───────────────── */}
          <div className="pt-3 border-t border-stone-100 text-xs text-stone-400 space-y-3">
            <div>
              <h4 className="font-medium text-stone-600 mb-1">{t("inspector.graphSummary")}</h4>
              <p>
                {t("inspector.entitiesRels", {
                  nodes: graphState.nodes.length,
                  rels: graphState.relationships.length,
                })}
              </p>
              {unresolvedCount > 0 && (
                <p className="text-red-500 mt-1">
                  {unresolvedCount === 1
                    ? t("inspector.unresolvedTension", { count: unresolvedCount })
                    : t("inspector.unresolvedTensions", { count: unresolvedCount })}
                </p>
              )}
            </div>

            {/* Evaluative signals live in the Reflect tab (Chat panel) */}
          </div>

          {/* ── Filesystem sync ──────────────────────────────────────────── */}
          {projectId && (
            <div className="pt-3 border-t border-stone-100 space-y-2">
              <button
                onClick={async () => {
                  setSyncLoading(true);
                  setSyncStatus(null);
                  try {
                    const res = await fetch("/api/export-to-files", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ projectId }),
                    });
                    const data = await res.json();
                    if (data.ok) {
                      const { filesWritten, projectSlug } = data.result;
                      setSyncStatus({
                        ok: true,
                        message: `Exported ${filesWritten.length} files to exports/${projectSlug}`,
                      });
                    } else {
                      setSyncStatus({ ok: false, message: data.error ?? "Export failed" });
                    }
                  } catch (err) {
                    setSyncStatus({ ok: false, message: err instanceof Error ? err.message : "Export failed" });
                  } finally {
                    setSyncLoading(false);
                  }
                }}
                disabled={syncLoading}
                className="w-full rounded-xl border border-stone-200 py-2 text-xs font-medium text-stone-600 hover:bg-stone-50 transition-colors disabled:opacity-50"
              >
                {syncLoading ? t("inspector.syncing") : t("inspector.syncButton")}
              </button>
              {syncStatus && (
                <p className={`text-[11px] leading-snug ${syncStatus.ok ? "text-green-600" : "text-red-500"}`}>
                  {syncStatus.message}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Node selected
  if (selectedNode) {
    const connections = graphState.relationships.filter(
      (r) => r.sourceId === selectedNode.id || r.targetId === selectedNode.id
    );
    const tensions = graphState.tensions.filter((t) =>
      t.relatedNodeIds.includes(selectedNode.id)
    );

    return (
      <div className="h-full flex flex-col bg-white border-l border-stone-200">
        <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-stone-800">{t("inspector.node.title")}</h3>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-xs">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <div>
            <label className="text-[10px] font-medium text-stone-500 uppercase tracking-wide">{t("inspector.node.label")}</label>
            <input
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              onBlur={handleSaveNode}
              className="mt-0.5 w-full rounded border border-stone-200 px-2 py-1.5 text-sm text-stone-800 focus:border-stone-400 focus:outline-none"
            />
          </div>

          {attractors.length > 0 && !selectedNode.is_hub && (
            <div>
              <label className="text-[10px] font-medium text-stone-500 uppercase tracking-wide">{t("inspector.node.hub")}</label>
              <select
                value={editAttractor}
                onChange={(e) => {
                  setEditAttractor(e.target.value);
                  onUpdateNode(selectedNode.id, { attractor: e.target.value });
                }}
                disabled={selectedNode.readonly}
                className="mt-0.5 w-full rounded border border-stone-200 px-2 py-1.5 text-xs text-stone-600 focus:outline-none disabled:opacity-50"
              >
                {attractors.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </div>
          )}

          {selectedNode.is_hub && (
            <div className="rounded-lg bg-stone-50 px-3 py-2 border border-stone-100">
              <span className="text-[10px] font-medium text-stone-500 uppercase tracking-wide">{t("inspector.node.hubNode")}</span>
              <p className="text-[11px] text-stone-400 mt-0.5">
                {t("inspector.node.hubNodeDesc")}
              </p>
            </div>
          )}

          <div>
            <label className="text-[10px] font-medium text-stone-500 uppercase tracking-wide">{t("inspector.node.type")}</label>
            <select
              value={editType}
              onChange={(e) => {
                setEditType(e.target.value);
                onUpdateNode(selectedNode.id, { type: e.target.value });
              }}
              disabled={selectedNode.readonly}
              className="mt-0.5 w-full rounded border border-stone-200 px-2 py-1.5 text-xs text-stone-600 focus:outline-none disabled:opacity-50"
            >
              {graphState.entityTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-medium text-stone-500 uppercase tracking-wide">{t("inspector.node.description")}</label>
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              onBlur={handleSaveNode}
              rows={3}
              className="mt-0.5 w-full rounded border border-stone-200 px-2 py-1.5 text-xs text-stone-600 resize-none focus:border-stone-400 focus:outline-none"
            />
          </div>

          {!selectedNode.is_hub && (
            <div>
              <label className="text-[10px] font-medium text-stone-500 uppercase tracking-wide">{t("inspector.node.sharing")}</label>
              <select
                value={selectedNode.sharingScope ?? "private"}
                onChange={(e) => {
                  onUpdateNode(selectedNode.id, { sharingScope: e.target.value as SharingScope });
                }}
                disabled={selectedNode.readonly}
                className="mt-0.5 w-full rounded border border-stone-200 px-2 py-1.5 text-xs text-stone-600 focus:outline-none disabled:opacity-50"
              >
                <option value="private">{t("inspector.node.sharingPrivate")}</option>
                <option value="team">{t("inspector.node.sharingTeam")}</option>
                <option value="division">{t("inspector.node.sharingDivision")}</option>
                <option value="company">{t("inspector.node.sharingCompany")}</option>
              </select>
            </div>
          )}

          {connections.length > 0 && (
            <div>
              <h4 className="text-[10px] font-medium text-stone-500 uppercase tracking-wide">{t("inspector.node.connections")}</h4>
              <div className="mt-1 space-y-1">
                {connections.map((rel) => {
                  const isSource = rel.sourceId === selectedNode.id;
                  const other = graphState.nodes.find(
                    (n) => n.id === (isSource ? rel.targetId : rel.sourceId)
                  );
                  return (
                    <div key={rel.id} className="text-xs text-stone-600">
                      {isSource ? "→" : "←"}{" "}
                      <span className="font-medium">{rel.type}</span>{" "}
                      {other?.label || "unknown"}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tensions.length > 0 && (
            <div>
              <h4 className="text-[10px] font-medium text-red-500 uppercase tracking-wide">{t("inspector.node.tensions")}</h4>
              {tensions.map((tension) => (
                <div key={tension.id} className="text-xs text-red-600 mt-0.5">
                  <span className="mr-1">{tension.status === "unresolved" ? "!" : "~"}</span>
                  {tension.scope === "cross-graph" && (
                    <span className="inline-block text-[9px] font-medium bg-red-100 text-red-500 rounded px-1 py-px mr-1 uppercase tracking-wide leading-none">
                      Cross-graph
                    </span>
                  )}
                  {tension.description}
                </div>
              ))}
            </div>
          )}

          <div className="text-[10px] text-stone-400 font-mono pt-2 border-t border-stone-100">
            ID: {selectedNode.id}
          </div>
        </div>
      </div>
    );
  }

  // Edge selected
  if (selectedEdge) {
    const source = graphState.nodes.find((n) => n.id === selectedEdge.sourceId);
    const target = graphState.nodes.find((n) => n.id === selectedEdge.targetId);

    return (
      <div className="h-full flex flex-col bg-white border-l border-stone-200">
        <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-stone-800">{t("inspector.edge.title")}</h3>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-xs">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <div className="text-xs text-stone-600">
            <span className="font-medium">{source?.label}</span>
            {" → "}
            <span className="font-medium">{target?.label}</span>
          </div>

          <div>
            <label className="text-[10px] font-medium text-stone-500 uppercase tracking-wide">{t("inspector.edge.type")}</label>
            <input
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              onBlur={handleSaveEdge}
              className="mt-0.5 w-full rounded border border-stone-200 px-2 py-1.5 text-sm text-stone-800 focus:border-stone-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[10px] font-medium text-stone-500 uppercase tracking-wide">{t("inspector.edge.description")}</label>
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              onBlur={handleSaveEdge}
              rows={2}
              className="mt-0.5 w-full rounded border border-stone-200 px-2 py-1.5 text-xs text-stone-600 resize-none focus:border-stone-400 focus:outline-none"
            />
          </div>
        </div>
      </div>
    );
  }

  return null;
}
