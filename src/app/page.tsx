"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import Link from "next/link";
import Chat from "@/components/Chat";
import Canvas from "@/components/Canvas";
import Inspector from "@/components/Inspector";
import TypePalette from "@/components/TypePalette";
import ScopingModal, { type ScopingMessage } from "@/components/ScopingModal";
import type {
  ChatMessage,
  GraphState,
  GraphUpdate,
  GraphNode,
  Relationship,
  ProjectBrief,
  SynthesisResult,
  AttractorPreset,
  NodeZone,
} from "@/types";
import { HUB_RELATIONSHIP_TYPE } from "@/types";
import {
  emptyGraphState,
  saveToLocalStorage,
  loadFromLocalStorage,
  saveMessagesToLocalStorage,
  loadMessagesFromLocalStorage,
  loadLegacyGraphFromLocalStorage,
  clearLocalStorage,
  addNode,
  addRelationship,
  deleteNode,
  deleteRelationship,
  updateNode,
  updateNodePosition,
} from "@/lib/graph-state";
import { autoLayout } from "@/lib/layout";
import { addEntityType, updateEntityType, getAttractorsForPreset, computeGraphZones, migrateToHubNodes } from "@/lib/entity-types";
import {
  supabase,
  loadOntology,
  loadOntologyWithParent,
  saveOntology,
  updateProjectMetadata,
  countProjectDocuments,
  clearOntology,
  clearDocuments,
} from "@/lib/supabase";
import { buildProjectBundle, downloadProjectBundle } from "@/lib/export";
import { useProject } from "@/lib/project-context";
import { useLocale } from "@/i18n/LocaleProvider";
import { useTranslations } from "next-intl";

// Debounce delay for Supabase saves (ms)
const SAVE_DEBOUNCE_MS = 800;

export default function Home() {
  const { projectId, project } = useProject();
  const { locale, setLocale } = useLocale();
  const t = useTranslations();

  const [graphState, setGraphState] = useState<GraphState>(emptyGraphState());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [graphUpdatesMap, setGraphUpdatesMap] = useState<Record<string, GraphUpdate[]>>({});
  const [hydrated, setHydrated] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [zoneFilter, setZoneFilter] = useState<NodeZone | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const importFileRef = useRef<HTMLInputElement>(null);

  // ── Phase 2: brief + scoping + reprocess state ───────────────────────────
  const [projectBrief, setProjectBrief] = useState<ProjectBrief | null>(null);
  const [scopingMessages, setScopingMessages] = useState<ScopingMessage[]>([]);
  const [scopingOpen, setScopingOpen] = useState(false);
  const [isScopingLoading, setIsScopingLoading] = useState(false);
  const [pendingBrief, setPendingBrief] = useState<ProjectBrief | undefined>();
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [documentCount, setDocumentCount] = useState(0);

  // ── Phase 2: synthesis state ───────────────────────────────────────────────
  const [synthesisResult, setSynthesisResult] = useState<SynthesisResult | null>(null);
  const [isSynthesisLoading, setIsSynthesisLoading] = useState(false);
  // Node names highlighted by the synthesis Invitation block; cleared on canvas click
  const [highlightedNodeNames, setHighlightedNodeNames] = useState<string[]>([]);

  // ── Share button state ────────────────────────────────────────────────────
  const [shareCopied, setShareCopied] = useState(false);

  // Debounce ref for Supabase saves
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the last project we loaded for (to reset on project switch)
  const loadedProjectRef = useRef<string | null>(null);
  // Track when we last saved to Supabase so we can suppress realtime echo
  // (our own saves trigger Realtime events — we don't want to re-load those)
  const lastLocalSaveRef = useRef<number>(0);
  // Prevents saving stale data from the previous project into the new project's localStorage
  // key during the render cycle when projectId changes (before hydrated resets)
  const isLoadingProjectRef = useRef(false);

  // ── Load ontology on mount / project switch ──────────────────────────────

  useEffect(() => {
    if (!projectId) return;
    // Skip if already loaded for this project
    if (loadedProjectRef.current === projectId) return;

    isLoadingProjectRef.current = true;
    setHydrated(false);
    loadedProjectRef.current = projectId;

    // Reset graph immediately so the old project's canvas doesn't flash while loading
    setGraphState(emptyGraphState());

    loadOntologyWithParent(projectId, project?.parent_project_id)
      .then((supabaseGraph) => {
        const preset = ((project?.metadata as Record<string, unknown>)?.attractorPreset ?? 'startup') as AttractorPreset;

        if (supabaseGraph.nodes.length > 0 || supabaseGraph.relationships.length > 0) {
          // Migrate to hub nodes if this project predates the hub system
          const migrated = migrateToHubNodes(supabaseGraph, preset);
          setGraphState(autoLayout(migrated));

          // If migration added hubs, save back to Supabase
          if (migrated !== supabaseGraph) {
            saveOntology(projectId, migrated).catch((err) =>
              console.warn('Hub migration save failed (non-fatal):', err)
            );
          }
        } else {
          // Supabase empty (e.g. debounced save didn't fire before navigation) —
          // fall back to project-scoped localStorage (safe: key includes projectId)
          const local = loadFromLocalStorage(projectId);
          if (local && (local.nodes.length > 0 || local.relationships.length > 0)) {
            const migrated = migrateToHubNodes(local, preset);
            setGraphState(migrated);
          }
        }
      })
      .catch((err) => {
        console.warn('Supabase load failed, falling back to localStorage:', err);
        const local = loadFromLocalStorage(projectId);
        if (local) setGraphState(local);
      })
      .finally(() => {
        isLoadingProjectRef.current = false;
        setHydrated(true);
      });

    // Load messages from localStorage (project-scoped)
    const savedMessages = loadMessagesFromLocalStorage(projectId);
    if (savedMessages) setMessages(savedMessages);
    else setMessages([]); // clear messages from previous project

    // ── Phase 2: load brief, document count, scoping messages ─────────────

    // Reset Phase 2 state immediately on project switch
    setProjectBrief(null);
    setScopingOpen(false);
    setPendingBrief(undefined);
    setIsReprocessing(false);
    setSynthesisResult(null);
    setIsSynthesisLoading(false);
    setHighlightedNodeNames([]);

    // Load scoping messages from localStorage (keyed per project)
    const scopingKey = `terroir_scoping_${projectId}`;
    try {
      const saved = localStorage.getItem(scopingKey);
      setScopingMessages(saved ? JSON.parse(saved) : []);
    } catch {
      setScopingMessages([]);
    }

    // Load cached synthesis result from localStorage (keyed per project)
    const synthesisKey = `terroir_synthesis_${projectId}`;
    try {
      const cached = localStorage.getItem(synthesisKey);
      setSynthesisResult(cached ? JSON.parse(cached) : null);
    } catch {
      setSynthesisResult(null);
    }

    // Load document count (lightweight HEAD request)
    countProjectDocuments(projectId)
      .then(setDocumentCount)
      .catch((err) => console.warn('countProjectDocuments failed (non-fatal):', err));
  }, [projectId]);

  // ── Sync project brief + optimisation hypothesis from project.metadata ──────
  useEffect(() => {
    if (project) {
      const brief = project.metadata?.brief as ProjectBrief | undefined;
      setProjectBrief(brief ?? null);
      const hypothesis = project.metadata?.optimizationHypothesis as string | undefined;
      setOptimizationHypothesis(hypothesis ?? null);
    }
  }, [project]);

  // ── Persist scoping messages to localStorage when they change ─────────────
  useEffect(() => {
    if (!projectId) return;
    const scopingKey = `terroir_scoping_${projectId}`;
    try {
      localStorage.setItem(scopingKey, JSON.stringify(scopingMessages));
    } catch {
      // localStorage write failures are non-fatal
    }
  }, [scopingMessages, projectId]);

  // ── Save to localStorage (immediate, for resilience — project-scoped) ───────

  useEffect(() => {
    if (hydrated && projectId && !isLoadingProjectRef.current) saveToLocalStorage(graphState, projectId);
  }, [graphState, hydrated, projectId]);

  useEffect(() => {
    if (hydrated && projectId) saveMessagesToLocalStorage(messages, projectId);
  }, [messages, hydrated, projectId]);

  // ── Save to Supabase (debounced) ─────────────────────────────────────────

  useEffect(() => {
    if (!hydrated || !projectId) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      // Stamp time before saving so the Realtime handler can ignore the echo
      lastLocalSaveRef.current = Date.now();
      saveOntology(projectId, graphState).catch((err) =>
        console.warn('Supabase save failed (non-fatal):', err)
      );
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [graphState, hydrated, projectId]);

  // ── Supabase Realtime: live graph sync for collaborators ─────────────────
  //
  // TODO: re-enable after step 2 (proper loop-break + position preservation fix)
  // useEffect(() => {
  //   if (!projectId || !hydrated) return;
  //
  //   const channel = supabase
  //     .channel(`terroir-project-${projectId}`)
  //     .on(
  //       'postgres_changes',
  //       {
  //         event: '*',
  //         schema: 'public',
  //         table: 'ontology_nodes',
  //         filter: `project_id=eq.${projectId}`,
  //       },
  //       () => {
  //         // Ignore if we caused this change ourselves (within 5s of our last save)
  //         if (Date.now() - lastLocalSaveRef.current < 5000) return;
  //
  //         loadOntology(projectId)
  //           .then((remoteGraph) => {
  //             if (remoteGraph.nodes.length > 0 || remoteGraph.relationships.length > 0) {
  //               setGraphState(remoteGraph);
  //             }
  //           })
  //           .catch((err) => console.warn('[realtime] Graph reload failed (non-fatal):', err));
  //       }
  //     )
  //     .subscribe();
  //
  //   return () => {
  //     supabase.removeChannel(channel);
  //   };
  // }, [projectId, hydrated]);

  // ── Share handler ─────────────────────────────────────────────────────────

  /**
   * Copies a shareable project URL to the clipboard.
   * Anyone who opens /?p=<projectId> will be taken directly into this project.
   */
  const handleShare = useCallback(() => {
    if (!projectId) return;
    const url = `${window.location.origin}/?p=${projectId}`;
    navigator.clipboard.writeText(url).then(() => {
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    });
  }, [projectId]);

  // ── Chat handler ─────────────────────────────────────────────────────────

  const handleSend = useCallback(
    async (content: string) => {
      const userMessage: ChatMessage = {
        id: uuidv4(),
        role: "user",
        content,
        timestamp: Date.now(),
      };

      const updatedMessages = [...messages, userMessage];
      setMessages(updatedMessages);
      setIsLoading(true);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: updatedMessages.map((m) => ({ role: m.role, content: m.content })),
            graphState,
            projectId,
            attractorPreset: (project?.metadata as Record<string, unknown>)?.attractorPreset ?? 'startup',
          }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to get response");
        }

        const result = await response.json();
        const assistantMessage: ChatMessage = {
          id: uuidv4(),
          role: "assistant",
          content: result.response,
          timestamp: Date.now(),
        };

        setMessages((prev) => [...prev, assistantMessage]);
        setGraphState(result.updatedGraph);

        if (result.graphUpdates?.length > 0) {
          setGraphUpdatesMap((prev) => ({
            ...prev,
            [assistantMessage.id]: result.graphUpdates,
          }));
        }
      } catch (error) {
        const errorMessage: ChatMessage = {
          id: uuidv4(),
          role: "assistant",
          content: `Error: ${error instanceof Error ? error.message : "Something went wrong"}`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsLoading(false);
      }
    },
    [messages, graphState, projectId]
  );

  // ── Extract handler ──────────────────────────────────────────────────────

  const handleExtract = useCallback(
    async (text: string) => {
      setIsLoading(true);

      const userMessage: ChatMessage = {
        id: uuidv4(),
        role: "user",
        content: `[Narrative extraction]\n${text.substring(0, 200)}${text.length > 200 ? "..." : ""}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage]);

      try {
        const response = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, graphState, projectId }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Extraction failed");
        }

        const result = await response.json();
        const laidOut = autoLayout(result.updatedGraph);
        setGraphState(laidOut);

        // Surface any tensions Sonnet found beyond the auto-apply cap for review
        if (result.suppressedTensions?.length > 0) {
          setPendingTensions(result.suppressedTensions);
        } else {
          setPendingTensions([]);
        }

        const suppressedNote = result.suppressedTensions?.length > 0
          ? ` ${result.suppressedTensions.length} additional tension${result.suppressedTensions.length > 1 ? "s" : ""} flagged for review in the Reflect tab.`
          : "";

        const assistantMessage: ChatMessage = {
          id: uuidv4(),
          role: "assistant",
          content: `Extracted ${result.graphUpdates.filter((u: GraphUpdate) => u.type === "node_created").length} entities and ${result.graphUpdates.filter((u: GraphUpdate) => u.type === "relationship_created").length} relationships from the narrative. Review the canvas and edit as needed.${suppressedNote}`,
          timestamp: Date.now(),
        };

        setMessages((prev) => [...prev, assistantMessage]);

        if (result.graphUpdates?.length > 0) {
          setGraphUpdatesMap((prev) => ({
            ...prev,
            [assistantMessage.id]: result.graphUpdates,
          }));
        }
      } catch (error) {
        const errorMessage: ChatMessage = {
          id: uuidv4(),
          role: "assistant",
          content: `Extraction error: ${error instanceof Error ? error.message : "Something went wrong"}`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsLoading(false);
      }
    },
    [graphState, projectId]
  );

  // ── Canvas handlers ──────────────────────────────────────────────────────

  const handleAddNode = useCallback(
    (label: string, type: string, description: string, position: { x: number; y: number }) => {
      const { state } = addNode(graphState, label, type, description, position);
      setGraphState(state);
    },
    [graphState]
  );

  const handleAddRelationship = useCallback(
    (sourceId: string, targetId: string, type: string) => {
      const { state } = addRelationship(graphState, sourceId, targetId, type);
      setGraphState(state);
    },
    [graphState]
  );

  const handleNodePositionChange = useCallback(
    (nodeId: string, position: { x: number; y: number }) => {
      setGraphState((prev) => updateNodePosition(prev, nodeId, position));
    },
    []
  );

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      setGraphState((prev) => deleteNode(prev, nodeId));
    },
    []
  );

  const handleDeleteRelationship = useCallback(
    (relId: string) => {
      setGraphState((prev) => deleteRelationship(prev, relId));
    },
    []
  );

  const handleUpdateNode = useCallback(
    (id: string, updates: Partial<Pick<GraphNode, "label" | "description" | "type" | "attractor" | "sharingScope">>) => {
      // If attractor changed, pass it as newHubId so belongs_to_hub relationship is updated
      const newHubId = updates.attractor;
      const nodeUpdates = { ...updates };
      if (newHubId) delete nodeUpdates.attractor;
      setGraphState((prev) => updateNode(prev, id, nodeUpdates, newHubId));
    },
    []
  );

  const handleUpdateRelationship = useCallback(
    (id: string, updates: Partial<Pick<Relationship, "type" | "description">>) => {
      setGraphState((prev) => ({
        ...prev,
        relationships: prev.relationships.map((r) =>
          r.id === id ? { ...r, ...updates } : r
        ),
      }));
    },
    []
  );

  const handleAutoLayout = useCallback(() => {
    setGraphState((prev) => autoLayout(prev));
  }, []);

  // ── Type palette handlers ────────────────────────────────────────────────

  const handleTypeUpdate = useCallback(
    (typeId: string, updates: Partial<{ label: string; color: string }>) => {
      setGraphState((prev) => ({
        ...prev,
        entityTypes: updateEntityType(prev.entityTypes, typeId, updates),
      }));
    },
    []
  );

  const handleTypeAdd = useCallback(
    (id: string, label: string) => {
      setGraphState((prev) => ({
        ...prev,
        entityTypes: addEntityType(prev.entityTypes, id, label),
      }));
    },
    []
  );

  // ── Export / Import ──────────────────────────────────────────────────────

  const handleExport = useCallback(() => {
    const date = new Date().toISOString().split('T')[0];
    const filename = `ontology-${date}.json`;
    const json = JSON.stringify(graphState, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [graphState]);

  /**
   * Exports the full project bundle: graph + synthesis + brief + classifications.
   * Designed for PoC handover — the JSON is machine-readable by RAG pipelines.
   */
  const handleExportBundle = useCallback(() => {
    const bundle = buildProjectBundle({
      projectName: project?.name ?? "untitled",
      graphState,
      projectBrief,
      synthesisResult,
      documentCount,
      attractorPreset: (project?.metadata as Record<string, unknown>)?.attractorPreset as string ?? null,
    });
    downloadProjectBundle(bundle);
  }, [project, graphState, projectBrief, synthesisResult, documentCount]);

  const handleImportFile = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target?.result as string) as GraphState;
        if (!imported.nodes || !imported.relationships) throw new Error('Invalid graph file');
        const laidOut = autoLayout(imported);
        setGraphState(laidOut);
        setMessages([]);
        setGraphUpdatesMap({});
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
      } catch {
        alert('Failed to import: not a valid Terroir graph file.');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  }, []);

  const handleImport = useCallback(() => {
    importFileRef.current?.click();
  }, []);

  // ── Reflect tab: update a signal's scores in local graphState ────────────
  //
  // Called optimistically by Chat's Reflect tab on every score/note change.
  // The API call (fire-and-forget) runs in parallel inside Chat.tsx, so this
  // just keeps graphState — and therefore the debounced saveOntology — in sync.
  const handleSignalReflect = useCallback(
    (signalId: string, updates: Partial<{ resonance: import("@/types").Resonance | null; reflectedAt: string | null; userNote: string | null; sharingScope: import("@/types").SharingScope }>) => {
      setGraphState((prev) => ({
        ...prev,
        evaluativeSignals: prev.evaluativeSignals.map((s) =>
          s.id === signalId ? { ...s, ...updates } : s
        ),
      }));
    },
    []
  );

  // ── Tension resolve handler ──────────────────────────────────────────────
  const handleTensionResolve = useCallback((tensionId: string) => {
    setGraphState((prev) => ({
      ...prev,
      tensions: prev.tensions.map((t) =>
        t.id === tensionId ? { ...t, status: "resolved" as const } : t
      ),
    }));
  }, []);

  // ── Suppressed tensions — await consultant review ─────────────────────────
  // Populated after a Sonnet paste-text extraction when Sonnet found more
  // tensions than the auto-apply cap (3). Reset on each new extraction.
  const [pendingTensions, setPendingTensions] = useState<
    { id: string; description: string; relatedLabels: string[] }[]
  >([]);

  // Promotes a suppressed tension to the graph (consultant-triggered).
  const handleTensionAdd = useCallback(
    (tension: { id: string; description: string; relatedLabels: string[] }) => {
      setGraphState((prev) => {
        // Resolve related labels to node IDs from the current graph
        const labelToId: Record<string, string> = {};
        for (const n of prev.nodes) labelToId[n.label.toLowerCase()] = n.id;
        const relatedNodeIds = tension.relatedLabels
          .map((l) => labelToId[l.toLowerCase()])
          .filter(Boolean) as string[];

        return {
          ...prev,
          tensions: [
            ...prev.tensions,
            {
              id: uuidv4(),
              description: tension.description,
              relatedNodeIds,
              status: "unresolved" as const,
            },
          ],
        };
      });
      // Remove by stable id — avoids removing duplicate-description cards
      setPendingTensions((prev) =>
        prev.filter((t) => t.id !== tension.id)
      );
    },
    []
  );

  // ── Signal dedup handler ─────────────────────────────────────────────────
  const handleSignalDedup = useCallback((updatedSignals: import("@/types").EvaluativeSignal[]) => {
    setGraphState((prev) => ({ ...prev, evaluativeSignals: updatedSignals }));
  }, []);

  // ── Topology signal enrichment ────────────────────────────────────────────
  // Stores the optimisation hypothesis returned by /api/topology-signals.
  // Loaded from project.metadata on project switch (see useEffect below).
  const [optimizationHypothesis, setOptimizationHypothesis] = useState<string | null>(null);

  const handleEnrichSignals = useCallback(
    (updatedSignals: import("@/types").EvaluativeSignal[], hypothesis: string) => {
      setGraphState((prev) => ({ ...prev, evaluativeSignals: updatedSignals }));
      setOptimizationHypothesis(hypothesis);
    },
    []
  );

  // ── Sources graph-update handler ─────────────────────────────────────────

  const handleGraphUpdate = useCallback(
    (updatedGraph: GraphState, updates: GraphUpdate[]) => {
      setGraphState(updatedGraph);

      // Re-fetch the accurate document count from Supabase rather than
      // incrementing blindly. This handles both new uploads and integration
      // passes (which also call onGraphUpdate with empty updates — a naive
      // increment would inflate the count incorrectly).
      if (projectId) {
        countProjectDocuments(projectId)
          .then(setDocumentCount)
          .catch((err) => console.warn('countProjectDocuments refresh failed (non-fatal):', err));
      }

      const entityCount = updates.filter((u) => u.type === "node_created").length;
      const relCount    = updates.filter((u) => u.type === "relationship_created").length;

      const msg: ChatMessage = {
        id: uuidv4(),
        role: "assistant",
        content: `Document extracted: ${entityCount} ${entityCount === 1 ? "entity" : "entities"} and ${relCount} ${relCount === 1 ? "relationship" : "relationships"} added to the canvas.`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, msg]);

      if (updates.length > 0) {
        setGraphUpdatesMap((prev) => ({ ...prev, [msg.id]: updates }));
      }
    },
    [projectId]
  );

  // ── Phase 2: Synthesis handler ────────────────────────────────────────────

  /**
   * Calls /api/synthesis with the current graph state. Caches the result in
   * localStorage so it survives page refreshes within the same project.
   */
  const handleRunSynthesis = useCallback(async () => {
    if (!projectId) return;
    setIsSynthesisLoading(true);

    try {
      const response = await fetch("/api/synthesis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, graphState }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Synthesis failed");
      }

      const result: SynthesisResult = await response.json();
      setSynthesisResult(result);

      // Cache in localStorage so the result survives a page refresh
      try {
        localStorage.setItem(
          `terroir_synthesis_${projectId}`,
          JSON.stringify(result)
        );
      } catch {
        // localStorage write failures are non-fatal
      }
    } catch (err) {
      alert(
        `Synthesis failed: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } finally {
      setIsSynthesisLoading(false);
    }
  }, [projectId, graphState]);

  // ── Phase 2: Scoping handlers ─────────────────────────────────────────────

  /**
   * Sends a message in the scoping dialogue. Strips the <brief> block from
   * the displayed response text and captures the parsed brief separately.
   */
  const handleScopingSend = useCallback(
    async (content: string) => {
      const userMsg: ScopingMessage = {
        id: uuidv4(),
        role: "user",
        content,
      };
      const updatedMessages = [...scopingMessages, userMsg];
      setScopingMessages(updatedMessages);
      setIsScopingLoading(true);

      try {
        const response = await fetch("/api/scoping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: updatedMessages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            projectId,
            projectContext: project
              ? { name: project.name, sector: project.sector }
              : undefined,
            locale,
          }),
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || "Scoping request failed");
        }

        const result: { response: string; brief?: ProjectBrief } =
          await response.json();

        // Strip the <brief>...</brief> block from the visible message
        const cleanedText = result.response
          .replace(/<brief>[\s\S]*?<\/brief>/g, "")
          .trim();

        const assistantMsg: ScopingMessage = {
          id: uuidv4(),
          role: "assistant",
          content: cleanedText || "Brief generated. See the preview below.",
        };
        setScopingMessages((prev) => [...prev, assistantMsg]);

        // Surface the pending brief for the consultant to review + save
        if (result.brief) {
          setPendingBrief(result.brief);
        }
      } catch (err) {
        const errMsg: ScopingMessage = {
          id: uuidv4(),
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Something went wrong"}`,
        };
        setScopingMessages((prev) => [...prev, errMsg]);
      } finally {
        setIsScopingLoading(false);
      }
    },
    [scopingMessages, projectId, project]
  );

  /**
   * Saves the pending brief to the project's metadata in Supabase and
   * updates local state. Closes the scoping modal.
   */
  const handleSaveBrief = useCallback(
    async (brief: ProjectBrief) => {
      if (!projectId) return;
      try {
        await updateProjectMetadata(projectId, { brief });
        setProjectBrief(brief);
        setPendingBrief(undefined);
        setScopingOpen(false);
      } catch (err) {
        console.error("Failed to save brief:", err);
        alert("Failed to save brief. Please try again.");
      }
    },
    [projectId]
  );

  /**
   * Saves an inline edit to one or more brief fields.
   * Called from Inspector → ProjectBrief on blur or radio selection.
   */
  const handleBriefUpdate = useCallback(
    async (updates: Partial<ProjectBrief>) => {
      if (!projectId || !projectBrief) return;
      const merged: ProjectBrief = { ...projectBrief, ...updates };
      setProjectBrief(merged); // optimistic update
      try {
        await updateProjectMetadata(projectId, { brief: merged });
      } catch (err) {
        console.error("Failed to update brief (non-fatal):", err);
        // Revert on failure
        setProjectBrief(projectBrief);
      }
    },
    [projectId, projectBrief]
  );

  /**
   * Re-processes all project documents with the current abstraction layer.
   * Downloads a snapshot of the current graph first, then calls /api/reprocess
   * and replaces the graph state with the rebuilt result.
   */
  const handleReprocess = useCallback(async () => {
    if (!projectId || !projectBrief) return;
    setIsReprocessing(true);

    // Step 1: download current graph as a snapshot before rebuilding
    const snapshotDate = new Date().toISOString().split("T")[0];
    const snapshotJson = JSON.stringify(graphState, null, 2);
    const blob = new Blob([snapshotJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `snapshot-${snapshotDate}.json`;
    a.click();
    URL.revokeObjectURL(url);

    // Step 2: rebuild the graph with the new abstraction layer
    try {
      const response = await fetch("/api/reprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          abstractionLayer: projectBrief.abstractionLayer,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Reprocess failed");
      }

      const result: {
        updatedGraph: GraphState;
        documentCount: number;
        totalUpdates: number;
      } = await response.json();

      setGraphState(autoLayout(result.updatedGraph));
      setDocumentCount(result.documentCount);

      // Add a system message in chat so the consultant knows the graph changed
      const msg: ChatMessage = {
        id: uuidv4(),
        role: "assistant",
        content: `Graph rebuilt using the "${projectBrief.abstractionLayer.replace(/_/g, " ")}" lens across ${result.documentCount} document${result.documentCount === 1 ? "" : "s"}. ${result.updatedGraph.nodes.length} entities extracted.`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, msg]);
    } catch (err) {
      alert(
        `Reprocess failed: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } finally {
      setIsReprocessing(false);
    }
  }, [projectId, projectBrief, graphState]);

  const handleReset = useCallback(async () => {
    if (!confirm("Reset all data for this project? This clears the graph, chat, and all uploaded documents. This cannot be undone.")) return;

    // Clear local state
    clearLocalStorage(projectId ?? undefined);
    setGraphState(emptyGraphState());
    setMessages([]);
    setGraphUpdatesMap({});
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setSynthesisResult(null);
    setDocumentCount(0);

    // Clear synthesis cache from localStorage
    if (projectId) {
      localStorage.removeItem(`terroir_synthesis_${projectId}`);
    }

    // Clear Supabase: ontology tables + documents + chunks
    if (projectId) {
      try {
        await clearOntology(projectId);
        await clearDocuments(projectId);
      } catch (err) {
        console.warn("Supabase clear failed (non-fatal):", err);
      }
    }
  }, [projectId]);

  // Phase 1 migration: import the legacy unscoped localStorage graph into this project
  const handleMigrateLegacy = useCallback(() => {
    const legacy = loadLegacyGraphFromLocalStorage();
    if (!legacy || legacy.nodes.length === 0) {
      alert('No Phase 1 graph found in localStorage to migrate.');
      return;
    }
    if (!confirm(`Import ${legacy.nodes.length} nodes and ${legacy.relationships.length} relationships from the Phase 1 graph into this project?`)) return;
    const laidOut = autoLayout(legacy);
    setGraphState(laidOut);
  }, []);

  // ── Loading state ────────────────────────────────────────────────────────

  if (!hydrated) {
    return (
      <div className="flex h-screen items-center justify-center bg-stone-50">
        <p className="text-sm text-stone-400">
          {project ? `Loading ${project.name}…` : 'Loading…'}
        </p>
      </div>
    );
  }

  // Compute attractor preset + zone data
  const attractorPreset = ((project?.metadata as Record<string, unknown>)?.attractorPreset ?? 'startup') as AttractorPreset;
  const activeAttractors = getAttractorsForPreset(attractorPreset);
  const graphZones = computeGraphZones(graphState.nodes, graphState.relationships);
  const nodeZoneCounts = { emergent: 0, attracted: 0, integrated: 0 };
  for (const [nodeId, zone] of graphZones.entries()) {
    // Only count non-hub nodes for zone counts
    const node = graphState.nodes.find((n) => n.id === nodeId);
    if (node && !node.is_hub) {
      nodeZoneCounts[zone]++;
    }
  }

  // Apply hub filter or zone filter
  // typeFilter is an attractor_id slug (e.g. "domain", "capability") — we find the hub node
  // and filter to its members via belongs_to_hub relationships.
  const filteredGraphState = (() => {
    if (!typeFilter && !zoneFilter) return graphState;

    let filteredNodes = graphState.nodes;

    if (typeFilter) {
      // Find the hub node matching this attractor slug
      const hubNode = graphState.nodes.find(
        (n) => n.is_hub && (n.properties?.attractor_id === typeFilter)
      );

      if (hubNode) {
        // Primary set: nodes with belongs_to_hub relationship to this hub
        const memberIds = new Set(
          graphState.relationships
            .filter((r) => r.type === HUB_RELATIONSHIP_TYPE && r.targetId === hubNode.id)
            .map((r) => r.sourceId)
        );
        // Always include the hub node itself
        memberIds.add(hubNode.id);

        // Expand to direct neighbors (non-hub relationships)
        const neighborIds = new Set<string>();
        for (const rel of graphState.relationships) {
          if (rel.type === HUB_RELATIONSHIP_TYPE) continue; // skip hub edges for neighbor expansion
          if (memberIds.has(rel.sourceId)) neighborIds.add(rel.targetId);
          if (memberIds.has(rel.targetId)) neighborIds.add(rel.sourceId);
        }

        filteredNodes = filteredNodes.filter(
          (n) => memberIds.has(n.id) || neighborIds.has(n.id)
        );
      } else {
        // Fallback: filter by attractor property (backwards compat for unmigrated data)
        const matchingIds = new Set(
          filteredNodes
            .filter((n) => (n.attractor ?? "emergent") === typeFilter)
            .map((n) => n.id)
        );
        const neighborIds = new Set<string>();
        for (const rel of graphState.relationships) {
          if (matchingIds.has(rel.sourceId)) neighborIds.add(rel.targetId);
          if (matchingIds.has(rel.targetId)) neighborIds.add(rel.sourceId);
        }
        filteredNodes = filteredNodes.filter(
          (n) => matchingIds.has(n.id) || neighborIds.has(n.id)
        );
      }
    }

    if (zoneFilter) {
      filteredNodes = filteredNodes.filter((n) => !n.is_hub && graphZones.get(n.id) === zoneFilter);
    }

    const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));
    return {
      ...graphState,
      nodes: filteredNodes,
      relationships: graphState.relationships.filter(
        (r) => filteredNodeIds.has(r.sourceId) && filteredNodeIds.has(r.targetId)
      ),
    };
  })();

  return (
    <div className="flex h-screen bg-stone-50 overflow-hidden">
      {/* ── Phase 2: Scoping modal (renders above everything) ─────────────── */}
      <ScopingModal
        isOpen={scopingOpen}
        messages={scopingMessages}
        isLoading={isScopingLoading}
        pendingBrief={pendingBrief}
        onSend={handleScopingSend}
        onSaveBrief={handleSaveBrief}
        onClose={() => {
          setScopingOpen(false);
          setPendingBrief(undefined);
        }}
      />

      {/* Chat panel */}
      <div className="w-[360px] shrink-0 border-r border-stone-200 bg-white flex flex-col min-h-0">
        <Chat
          messages={messages}
          onSend={handleSend}
          onExtract={handleExtract}
          isLoading={isLoading}
          graphUpdatesMap={graphUpdatesMap}
          projectId={projectId ?? null}
          graphState={graphState}
          onGraphUpdate={handleGraphUpdate}
          // ── Phase 2: Synthesis ───────────────────────────────────────────
          synthesisResult={synthesisResult}
          onRunSynthesis={handleRunSynthesis}
          isSynthesisLoading={isSynthesisLoading}
          documentCount={documentCount}
          projectBrief={projectBrief}
          // ── Reflect tab ──────────────────────────────────────────────────
          onSignalReflect={handleSignalReflect}
          onTensionResolve={handleTensionResolve}
          onSignalDedup={handleSignalDedup}
          optimizationHypothesis={optimizationHypothesis}
          onEnrichSignals={handleEnrichSignals}
          onHighlightNodes={setHighlightedNodeNames}
          // ── Suppressed tensions (paste-text extraction) ──────────────────
          pendingTensions={pendingTensions}
          onTensionAdd={handleTensionAdd}
        />
        {/* Bottom actions */}
        <div className="border-t border-stone-100 px-4 py-2 flex items-center gap-3">
          <button
            onClick={handleReset}
            className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
          >
            {t("bottombar.resetAll")}
          </button>
          <span className="text-stone-200 select-none">|</span>
          <button
            onClick={handleImport}
            className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
          >
            {t("bottombar.import")}
          </button>
          <button
            onClick={handleExport}
            className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
          >
            {t("bottombar.export")}
          </button>
          <button
            onClick={handleExportBundle}
            className="text-[10px] text-stone-500 hover:text-stone-700 font-medium transition-colors"
            title="Export full project bundle (graph + synthesis + brief) as JSON"
          >
            {t("bottombar.bundle")}
          </button>
          <button
            onClick={handleMigrateLegacy}
            className="text-[10px] text-amber-500 hover:text-amber-700 transition-colors"
            title="Import Phase 1 graph from localStorage into this project"
          >
            ↑ Migrate v1
          </button>
          <span className="text-stone-200 select-none">|</span>
          <Link
            href="/projects"
            className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
          >
            {t("bottombar.allProjects")}
          </Link>
          <span className="text-stone-200 select-none">|</span>
          <Link
            href="/compare"
            className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
          >
            {t("bottombar.compare")}
          </Link>
          <input
            ref={importFileRef}
            type="file"
            accept=".json"
            onChange={handleImportFile}
            className="hidden"
          />
        </div>
      </div>

      {/* Canvas panel */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Project name bar */}
        {project && (
          <div className="px-4 py-1.5 bg-white border-b border-stone-100 flex items-center gap-2">
            <span className="text-[11px] font-medium text-stone-600">{project.name}</span>
            <span className="text-stone-300 text-[10px]">·</span>
            <span className="text-[10px] text-stone-400">{project.phase}</span>
            {/* Spacer pushes Share to the right */}
            <span className="flex-1" />
            <button
              onClick={handleShare}
              className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
              title="Copy shareable link — anyone with this URL can open this project"
            >
              {shareCopied ? t("topbar.copied") : t("topbar.share")}
            </button>
            <span className="text-stone-200 text-[10px] select-none mx-1">|</span>
            {/* DE | EN language toggle */}
            <div className="flex items-center gap-0.5 text-[10px] font-medium">
              <button
                onClick={() => setLocale("de")}
                className={locale === "de" ? "text-stone-800 font-bold underline underline-offset-2" : "text-stone-400 hover:text-stone-600 transition-colors"}
              >
                {t("topbar.de")}
              </button>
              <span className="text-stone-300 select-none">|</span>
              <button
                onClick={() => setLocale("en")}
                className={locale === "en" ? "text-stone-800 font-bold underline underline-offset-2" : "text-stone-400 hover:text-stone-600 transition-colors"}
              >
                {t("topbar.en")}
              </button>
            </div>
          </div>
        )}
        <TypePalette
          entityTypes={graphState.entityTypes}
          attractors={activeAttractors}
          nodeZoneCounts={nodeZoneCounts}
          onTypeUpdate={handleTypeUpdate}
          onTypeAdd={handleTypeAdd}
          activeFilter={typeFilter}
          onFilterChange={setTypeFilter}
          zoneFilter={zoneFilter}
          onZoneFilterChange={setZoneFilter}
        />
        <div className="flex-1 relative">
          <Canvas
            graphState={filteredGraphState}
            onNodeSelect={setSelectedNodeId}
            onEdgeSelect={setSelectedEdgeId}
            onAddNode={handleAddNode}
            onAddRelationship={handleAddRelationship}
            onNodePositionChange={handleNodePositionChange}
            onDeleteNode={handleDeleteNode}
            onDeleteRelationship={handleDeleteRelationship}
            onAutoLayout={handleAutoLayout}
            onExport={handleExport}
            onImport={handleImport}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            attractors={activeAttractors}
            graphZones={graphZones}
            totalNodeCount={graphState.nodes.filter((n) => !n.is_hub).length}
            synthesisHighlightedNodeNames={highlightedNodeNames}
            onClearSynthesisHighlight={() => setHighlightedNodeNames([])}
          />
        </div>
      </div>

      {/* ── Inspector panel — collapsible ─────────────────────────────────── */}
      {/* The chevron strip is always visible so the user can re-open the inspector
          without hunting for a hidden button. Width transitions: 304px open, 24px closed. */}
      <div className={`shrink-0 flex transition-all duration-200 ${inspectorOpen ? "w-[304px]" : "w-6"}`}>
        {/* Chevron toggle — anchored to the left edge of the inspector area */}
        <button
          onClick={() => setInspectorOpen((prev) => !prev)}
          className="w-6 shrink-0 flex items-center justify-center border-l border-stone-200 bg-white hover:bg-stone-50 transition-colors"
          title={inspectorOpen ? "Collapse inspector" : "Expand inspector"}
          aria-label={inspectorOpen ? "Collapse inspector" : "Expand inspector"}
        >
          <span className="text-stone-400 text-[10px] select-none">
            {inspectorOpen ? "›" : "‹"}
          </span>
        </button>

        {/* Full inspector — only rendered when open */}
        {inspectorOpen && (
          <div className="w-[280px]">
            <Inspector
              graphState={graphState}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onUpdateNode={handleUpdateNode}
              onUpdateRelationship={handleUpdateRelationship}
              onClose={() => {
                setSelectedNodeId(null);
                setSelectedEdgeId(null);
              }}
              // ── Phase 2 ──────────────────────────────────────────────────
              brief={projectBrief}
              documentCount={documentCount}
              isReprocessing={isReprocessing}
              onBriefUpdate={handleBriefUpdate}
              onStartScoping={() => setScopingOpen(true)}
              onReprocess={handleReprocess}
              attractors={activeAttractors}
              projectId={projectId ?? undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}
