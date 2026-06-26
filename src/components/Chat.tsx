"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import ChatMessage from "./ChatMessage";
import Sources from "./Sources";
import SynthesisResults from "./SynthesisResults";
import type {
  ChatMessage as ChatMessageType,
  EvaluativeSignal,
  Resonance,
  GraphState,
  GraphUpdate,
  SynthesisResult,
  ProjectBrief,
} from "@/types";

interface ChatProps {
  messages: ChatMessageType[];
  onSend: (message: string) => void;
  onExtract: (text: string) => void;
  isLoading: boolean;
  graphUpdatesMap: Record<string, GraphUpdate[]>;
  // Sources panel
  projectId: string | null;
  graphState: GraphState;
  onGraphUpdate: (updatedGraph: GraphState, updates: GraphUpdate[]) => void;
  // Synthesis tab
  synthesisResult?: SynthesisResult | null;
  onRunSynthesis?: () => void;
  isSynthesisLoading?: boolean;
  documentCount?: number;
  /** Passed through to Sources so new uploads use the project's extraction lens */
  projectBrief?: ProjectBrief | null;
  /**
   * Called optimistically when the user rates a signal in the Reflect tab.
   * Keeps graphState (and saveOntology) in sync alongside the direct API write.
   */
  onSignalReflect?: (
    signalId: string,
    updates: Partial<Pick<EvaluativeSignal, "resonance" | "reflectedAt" | "userNote" | "sharingScope">>
  ) => void;
  /** Called when the user resolves a tension in the Reflect tab. */
  onTensionResolve?: (tensionId: string) => void;
  /**
   * Tensions Sonnet found beyond the auto-apply cap during paste-text extraction.
   * Shown in the Reflect tab as a "pending review" section.
   */
  pendingTensions?: { id: string; description: string; relatedLabels: string[] }[];
  /** Called when the consultant promotes a pending tension to the graph. */
  onTensionAdd?: (tension: { id: string; description: string; relatedLabels: string[] }) => void;
  /** Called after signal deduplication completes — updates graphState with merged signals. */
  onSignalDedup?: (updatedSignals: EvaluativeSignal[]) => void;
  /** Optimisation hypothesis from the topology-signal pass — null until first enrichment. */
  optimizationHypothesis?: string | null;
  /** Called after topology enrichment completes — updates signals + hypothesis in page state. */
  onEnrichSignals?: (updatedSignals: EvaluativeSignal[], hypothesis: string) => void;
  /** Called when the user clicks a node chip in the Invitation block — highlights nodes on canvas */
  onHighlightNodes?: (nodeNames: string[]) => void;
}

// ── Direction icon map ────────────────────────────────────────────────────────
const DIRECTION_ICON: Record<string, string> = {
  toward:    "→",
  away_from: "←",
  protecting: "◆",
};

// ── ResonancePicker ───────────────────────────────────────────────────────────
// Three-state resonance verdict: dissonant / equivocal / resonant. Replaces the
// old relevance × intensity dials. Dissonant is information (mis-voiced — re-voice
// it), not a low score, so it gets its own visible state rather than an empty one.
const RESONANCE_OPTIONS: { value: Resonance; label: string; title: string; color: string }[] = [
  { value: "dissonant", label: "D", title: "Dissonant — rings false or mis-voiced; re-voice it", color: "#b45309" },
  { value: "equivocal", label: "E", title: "Equivocal — partly true, not yet settled",           color: "#a8a29e" },
  { value: "resonant",  label: "R", title: "Resonant — rings true against the field",             color: "#4d7c0f" },
];

function ResonancePicker({
  value,
  onChange,
}: {
  value: Resonance | null | undefined;
  onChange: (value: Resonance) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-stone-400 w-16 shrink-0">Resonance</span>
      <div className="flex gap-1">
        {RESONANCE_OPTIONS.map((opt) => {
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              title={opt.title}
              aria-label={opt.title}
              aria-pressed={selected}
              className="w-5 h-5 rounded text-[10px] font-semibold flex items-center justify-center border transition-colors"
              style={{
                borderColor: selected ? opt.color : "#e7e5e4",
                backgroundColor: selected ? opt.color : "transparent",
                color: selected ? "#ffffff" : "#a8a29e",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Relative timestamp formatter ──────────────────────────────────────────────
function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 1)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

// ── SignalCard ────────────────────────────────────────────────────────────────
// Interactive card for a single evaluative signal in the Reflect tab.
// Auto-saves scores to /api/reflect on each change (fire-and-forget).
// Clicking the label area expands the card to show the full label, at_cost_of,
// and a source excerpt — collapsed by default to keep the list scannable.
function SignalCard({
  signal,
  projectId,
  onReflect,
}: {
  signal: EvaluativeSignal;
  projectId: string | null;
  onReflect: (updates: Partial<Pick<EvaluativeSignal, "resonance" | "reflectedAt" | "userNote" | "sharingScope">>) => void;
}) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const [noteOpen, setNoteOpen] = useState(!!signal.userNote);
  const [noteValue, setNoteValue] = useState(signal.userNote ?? "");

  // Keep local note in sync if the parent signal changes (e.g. on project load)
  useEffect(() => {
    setNoteValue(signal.userNote ?? "");
    setNoteOpen(!!signal.userNote);
  }, [signal.userNote]);

  /** Persists a resonance verdict to Supabase and notifies the parent. */
  const saveResonance = async (value: Resonance) => {
    const reflectedAt = new Date().toISOString();
    // Optimistic update to parent graphState first
    onReflect({ resonance: value, reflectedAt });

    // Fire-and-forget persist — server stamps its own reflected_at
    if (projectId) {
      fetch("/api/reflect", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalId: signal.id, projectId, resonance: value }),
      }).catch((err) => console.warn("[reflect] resonance save failed (non-fatal):", err));
    }
  };

  /** Persists a note on blur. */
  const saveNote = async () => {
    const trimmed = noteValue.trim();
    const reflectedAt = new Date().toISOString();
    onReflect({ userNote: trimmed || null, reflectedAt });

    if (projectId) {
      fetch("/api/reflect", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signalId: signal.id,
          projectId,
          userNote: trimmed || null,
        }),
      }).catch((err) => console.warn("[reflect] note save failed (non-fatal):", err));
    }
  };

  const isRated = signal.resonance != null;

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 space-y-2 transition-colors ${
        isRated
          ? "border-stone-200 bg-white"
          : "border-stone-100 bg-stone-50"
      }`}
    >
      {/* Header: direction icon + label + expand toggle */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start justify-between gap-2 text-left"
        title={expanded ? "Collapse" : "Expand to read full signal"}
      >
        <div className="flex items-start gap-2 min-w-0">
          <span
            className="shrink-0 text-sm text-stone-400 mt-px"
            title={signal.direction.replace("_", " ")}
          >
            {DIRECTION_ICON[signal.direction] ?? "→"}
          </span>
          <span
            className={`text-xs font-medium leading-tight ${
              expanded ? "whitespace-normal" : "truncate"
            } ${isRated ? "text-stone-700" : "text-stone-500"}`}
          >
            {signal.label}
          </span>
        </div>
        <span className="shrink-0 text-[10px] text-stone-300 mt-px select-none">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {/* Expanded detail: at_cost_of + source excerpt */}
      {expanded && (
        <div className="pl-5 space-y-1.5 pb-0.5">
          {signal.atCostOf && (
            <p className="text-[11px] text-stone-500 leading-snug">
              <span className="font-medium text-stone-400">At cost of: </span>
              {signal.atCostOf}
            </p>
          )}
          {signal.sourceDescription && (
            <p className="text-[11px] text-stone-400 leading-snug italic">
              "{signal.sourceDescription.slice(0, 160)}{signal.sourceDescription.length > 160 ? "…" : ""}"
            </p>
          )}
          {signal.reflectedAt && (
            <p className="text-[10px] text-stone-300">
              {relativeTime(signal.reflectedAt)}
            </p>
          )}
          <div className="flex items-center gap-1.5 pt-1">
            <span className="text-[10px] text-stone-400">{t("reflect.signals.sharing")}</span>
            <select
              value={signal.sharingScope ?? "private"}
              onChange={(e) => onReflect({ sharingScope: e.target.value as EvaluativeSignal["sharingScope"] })}
              className="rounded border border-stone-200 px-1.5 py-0.5 text-[10px] text-stone-500 focus:outline-none bg-white"
            >
              <option value="private">{t("reflect.signals.sharingPrivate")}</option>
              <option value="team">{t("reflect.signals.sharingTeam")}</option>
              <option value="division">{t("reflect.signals.sharingDivision")}</option>
              <option value="company">{t("reflect.signals.sharingCompany")}</option>
            </select>
          </div>
        </div>
      )}

      {/* Resonance verdict */}
      <div className="space-y-1 pl-5">
        <ResonancePicker
          value={signal.resonance}
          onChange={(value) => saveResonance(value)}
        />
      </div>

      {/* Note — revealed on demand */}
      <div className="pl-5">
        {noteOpen ? (
          <input
            type="text"
            value={noteValue}
            onChange={(e) => setNoteValue(e.target.value)}
            onBlur={saveNote}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            placeholder={t("reflect.signals.notePlaceholder")}
            className="w-full rounded border border-stone-200 bg-white px-2 py-1 text-[11px] text-stone-600 placeholder:text-stone-300 focus:border-stone-400 focus:outline-none"
          />
        ) : (
          <button
            onClick={() => setNoteOpen(true)}
            className="text-[10px] text-stone-300 hover:text-stone-500 transition-colors"
          >
            {t("reflect.signals.addNote")}
          </button>
        )}
      </div>
    </div>
  );
}

// ── TensionCard ───────────────────────────────────────────────────────────────
// Displays a single unresolved tension with linked entity labels + resolve button.
function TensionCard({
  tension,
  nodes,
  onResolve,
}: {
  tension: import("@/types").TensionMarker;
  nodes: import("@/types").GraphNode[];
  onResolve?: (tensionId: string) => void;
}) {
  const t = useTranslations();
  const linkedLabels = tension.relatedNodeIds
    .map((id) => nodes.find((n) => n.id === id)?.label)
    .filter(Boolean) as string[];

  return (
    <div className="rounded-lg border border-red-100 bg-red-50/40 px-3 py-2.5 space-y-1.5">
      <p className="text-xs text-stone-700 leading-snug">{tension.description}</p>
      {linkedLabels.length > 0 && (
        <p className="text-[10px] text-stone-400 leading-tight">
          {linkedLabels.join(" · ")}
        </p>
      )}
      {onResolve && (
        <button
          onClick={() => onResolve(tension.id)}
          className="text-[10px] text-stone-500 hover:text-stone-700 transition-colors border border-stone-200 rounded px-2 py-0.5 hover:bg-white"
        >
          {t("reflect.tensions.markResolved")}
        </button>
      )}
    </div>
  );
}

// ── Chat component ────────────────────────────────────────────────────────────

export default function Chat({
  messages,
  onSend,
  onExtract,
  isLoading,
  graphUpdatesMap,
  projectId,
  graphState,
  onGraphUpdate,
  synthesisResult,
  onRunSynthesis,
  isSynthesisLoading = false,
  documentCount = 0,
  projectBrief,
  onSignalReflect,
  onTensionResolve,
  onSignalDedup,
  optimizationHypothesis,
  onEnrichSignals,
  onHighlightNodes,
  pendingTensions = [],
  onTensionAdd,
}: ChatProps) {
  const t = useTranslations();

  // ── Panel mode ────────────────────────────────────────────────────────────
  // "sources" mode is triggered by the + menu, not a tab, but lives in the
  // mode union so Sources stays always-mounted for file-state preservation.
  const [mode, setMode] = useState<"chat" | "sources" | "synthesis" | "reflect">("chat");
  // Track which tab was active before entering sources, so we can return to it
  const [preSourcesToab, setPreSourcesTab] = useState<"chat" | "synthesis" | "reflect">("chat");

  // ── Chat input state ─────────────────────────────────────────────────────
  const [input, setInput] = useState("");

  // ── Paste-text state (replaces the old "Extract" tab) ────────────────────
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteInput, setPasteInput] = useState("");

  // ── Signal dedup state ───────────────────────────────────────────────────
  const [dedupState, setDedupState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [dedupSummary, setDedupSummary] = useState<string>("");

  // ── Session Delta state ───────────────────────────────────────────────────
  const [deltaState, setDeltaState] = useState<"idle" | "running" | "done" | "no_snapshots" | "error">("idle");
  const [deltaNarration, setDeltaNarration] = useState<string>("");
  const [deltaOpen, setDeltaOpen] = useState(false);

  // ── Topology enrichment state ─────────────────────────────────────────────
  const [enrichState, setEnrichState] = useState<"idle" | "running" | "done" | "error">("idle");

  // ── Meta-tension (fault line) state ──────────────────────────────────────
  const [metaTensionState, setMetaTensionState] = useState<"idle" | "running" | "done" | "error">("idle");

  // ── + menu state ──────────────────────────────────────────────────────────
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Scroll to bottom on new messages — only if user is already near the bottom
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 120) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isLoading]);

  // Auto-resize chat textarea
  useEffect(() => {
    if (textareaRef.current && mode === "chat" && !pasteMode) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input, mode, pasteMode]);

  // Close + menu when clicking outside
  useEffect(() => {
    if (!showPlusMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setShowPlusMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showPlusMenu]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleChatSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handlePasteExtract = () => {
    const trimmed = pasteInput.trim();
    if (!trimmed || isLoading) return;
    onExtract(trimmed);
    setPasteInput("");
    setPasteMode(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleChatSubmit();
    }
  };

  /** Called by SynthesisResults "Ask about this in Chat" buttons. */
  const handleAskInChat = (question: string) => {
    setMode("chat");
    setInput(question);
  };

  /** Opens the Sources panel, remembering which tab to return to. */
  const handleOpenSources = () => {
    setPreSourcesTab(mode as "chat" | "synthesis" | "reflect");
    setMode("sources");
    setShowPlusMenu(false);
  };

  // ── Signal dedup handler ─────────────────────────────────────────────────
  const handleDedup = async () => {
    if (!projectId || dedupState === "running") return;
    setDedupState("running");
    try {
      const res = await fetch("/api/signals/deduplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          signals: graphState.evaluativeSignals,
          projectBrief,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Deduplication failed");
      }
      const { updatedSignals, clusterCount, originalCount, mergedCount } = await res.json();
      onSignalDedup?.(updatedSignals);
      if (clusterCount === 0) {
        setDedupSummary("No duplicates found");
      } else {
        setDedupSummary(`${originalCount} → ${updatedSignals.length} signals (${mergedCount} merged into ${clusterCount} cluster${clusterCount === 1 ? "" : "s"})`);
      }
      setDedupState("done");
    } catch (err) {
      console.error("[dedup]", err);
      setDedupState("error");
    }
  };

  // ── Session Delta handler ────────────────────────────────────────────────
  const handleSessionDelta = async () => {
    if (!projectId || deltaState === "running") return;
    setDeltaState("running");
    setDeltaOpen(true);
    try {
      const res = await fetch("/api/session-delta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Session delta failed");
      }
      const { narration, error } = await res.json();
      if (error === "no_snapshots") {
        setDeltaState("no_snapshots");
      } else {
        setDeltaNarration(narration);
        setDeltaState("done");
      }
    } catch (err) {
      console.error("[session-delta]", err);
      setDeltaState("error");
    }
  };

  // ── Topology enrichment handler ──────────────────────────────────────────
  const handleEnrich = async () => {
    if (!projectId || enrichState === "running") return;
    setEnrichState("running");
    try {
      const res = await fetch("/api/topology-signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Enrichment failed");
      }
      const { updatedSignals, optimizationHypothesis: hypothesis } = await res.json();
      onEnrichSignals?.(updatedSignals, hypothesis);
      setEnrichState("done");
    } catch (err) {
      console.error("[enrich]", err);
      setEnrichState("error");
    }
  };

  // ── Meta-tension (fault line) handler ───────────────────────────────────
  const handleMetaTensions = async () => {
    if (!projectId || metaTensionState === "running") return;
    setMetaTensionState("running");
    try {
      const res = await fetch("/api/meta-tensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Fault line detection failed");
      }
      const { updatedGraph } = await res.json();
      onGraphUpdate(updatedGraph, []);
      setMetaTensionState("done");
    } catch (err) {
      console.error("[meta-tensions]", err);
      setMetaTensionState("error");
    }
  };

  // ── Tab button renderer ───────────────────────────────────────────────────
  // When in sources mode, the pre-sources tab stays visually active so the
  // user always knows where they came from and how to get back.
  const unresolvedTensionCount = graphState.tensions.filter((t) => t.status === "unresolved").length;

  const tabBtn = (label: string, value: "chat" | "synthesis" | "reflect") => {
    const isActive = mode === value || (mode === "sources" && preSourcesToab === value);
    const badge = value === "reflect" && unresolvedTensionCount > 0 ? unresolvedTensionCount : null;
    return (
      <button
        onClick={() => { setMode(value); setPasteMode(false); }}
        className={`relative rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
          isActive
            ? "bg-stone-800 text-white"
            : "bg-stone-100 text-stone-500 hover:bg-stone-200"
        }`}
      >
        {label}
        {badge !== null && (
          <span className={`ml-1 text-[9px] px-1 rounded-full ${isActive ? "bg-white/20" : "bg-red-100 text-red-600"}`}>
            {badge}
          </span>
        )}
      </button>
    );
  };

  return (
    // flex-1 + min-h-0: Chat takes remaining space in the parent flex column,
    // leaving the bottom action bar visible. h-full would consume 100% of the
    // parent height and push the bar off-screen.
    <div className="flex flex-1 flex-col min-h-0">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-stone-200 px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold text-stone-800">{t("chat.title")}</h2>
          <p className="text-[10px] text-stone-500">{t("chat.subtitle")}</p>
        </div>
        {/* Three tabs — Extract promoted to + menu in the input area */}
        <div className="flex gap-1">
          {tabBtn(t("chat.tabs.chat"),      "chat")}
          {tabBtn(t("chat.tabs.synthesis"), "synthesis")}
          {tabBtn(t("chat.tabs.reflect"),   "reflect")}
        </div>
      </div>

      {/* ── Sources panel — always mounted to preserve file state ─────────── */}
      <div
        className="flex-1 overflow-hidden"
        style={{ display: mode === "sources" ? "flex" : "none", flexDirection: "column" }}
      >
        <Sources
          projectId={projectId}
          graphState={graphState}
          onGraphUpdate={onGraphUpdate}
          projectBrief={projectBrief}
        />
      </div>

      {/* ── Synthesis tab ─────────────────────────────────────────────────── */}
      {mode === "synthesis" && (
        <div className="flex-1 overflow-hidden flex flex-col">
          <SynthesisResults
            result={synthesisResult ?? null}
            documentCount={documentCount}
            isLoading={isSynthesisLoading}
            onRunSynthesis={onRunSynthesis ?? (() => {})}
            onAskInChat={handleAskInChat}
            onHighlightNodes={onHighlightNodes ?? (() => {})}
          />
          {/* ── Fault line trigger — appears once hub nodes exist ─────────── */}
          {graphState.nodes.some((n) => n.is_hub) && (
            <div className="px-4 py-3 border-t border-stone-100 flex items-center justify-between gap-2 shrink-0">
              <div className="flex flex-col">
                <span className="text-[10px] font-medium text-stone-500 uppercase tracking-wide">
                  Cross-graph fault lines
                </span>
                {metaTensionState === "done" && (
                  <span className="text-[10px] text-red-400 normal-case">
                    {graphState.tensions.filter((t) => t.scope === "cross-graph").length} fault{" "}
                    {graphState.tensions.filter((t) => t.scope === "cross-graph").length === 1 ? "line" : "lines"} surfaced
                  </span>
                )}
                {metaTensionState === "error" && (
                  <span className="text-[10px] text-red-400 normal-case">Detection failed — try again</span>
                )}
              </div>
              <button
                onClick={handleMetaTensions}
                disabled={metaTensionState === "running" || !projectId}
                className="text-[10px] text-red-600 hover:text-red-800 transition-colors border border-red-200 rounded px-2 py-0.5 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                title="Surface cross-hub structural tensions using somatic pattern recognition"
              >
                {metaTensionState === "running"
                  ? "Detecting…"
                  : metaTensionState === "done"
                  ? "Re-run"
                  : "Surface fault lines"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Reflect tab ───────────────────────────────────────────────────── */}
      {mode === "reflect" && (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

          {/* ── Session Delta card ───────────────────────────────────────── */}
          <div className="rounded-lg border border-stone-200 bg-white overflow-hidden">
            <button
              onClick={() => {
                if (deltaState === "idle" || deltaState === "error") {
                  handleSessionDelta();
                } else {
                  setDeltaOpen((v) => !v);
                }
              }}
              disabled={!projectId || deltaState === "running"}
              className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-stone-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="text-[10px] font-medium text-stone-500 uppercase tracking-wide">
                {t("reflect.delta.title")}
              </span>
              <span className="text-[10px] text-stone-400">
                {deltaState === "running"
                  ? t("reflect.delta.describing")
                  : deltaState === "no_snapshots"
                    ? t("reflect.delta.noSnapshots")
                    : deltaState === "done"
                      ? (deltaOpen ? "▲" : "▼")
                      : deltaState === "error"
                        ? t("reflect.delta.failed")
                        : t("reflect.delta.prompt")}
              </span>
            </button>
            {deltaOpen && deltaState === "done" && deltaNarration && (
              <div className="px-3 pb-3 pt-0 border-t border-stone-100">
                <p className="text-xs text-stone-700 leading-relaxed whitespace-pre-wrap">
                  {deltaNarration}
                </p>
                <button
                  onClick={handleSessionDelta}
                  className="mt-2 text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
                >
                  {t("reflect.delta.refresh")}
                </button>
              </div>
            )}
          </div>

          {/* ── Pending tensions (suppressed by auto-apply cap) ──────────── */}
          {/* Shown when a paste-text Sonnet extraction found more tensions    */}
          {/* than the 3-tension cap. Consultant reviews and adds individually. */}
          {pendingTensions.length > 0 && (
            <div>
              <p className="text-[10px] font-medium text-stone-400 uppercase tracking-wide mb-2">
                Tensions — review
                <span className="ml-1.5 normal-case font-normal text-amber-500">
                  — {pendingTensions.length} flagged for review
                </span>
              </p>
              <div className="space-y-2">
                {pendingTensions.map((tension) => {
                  const linkedLabels = tension.relatedLabels.filter(Boolean);
                  return (
                    <div
                      key={tension.id}
                      className="rounded-lg border border-amber-100 bg-amber-50/40 px-3 py-2.5 space-y-1.5"
                    >
                      <p className="text-xs text-stone-700 leading-snug">{tension.description}</p>
                      {linkedLabels.length > 0 && (
                        <p className="text-[10px] text-stone-400 leading-tight">
                          {linkedLabels.join(" · ")}
                        </p>
                      )}
                      {onTensionAdd && (
                        <button
                          onClick={() => onTensionAdd(tension)}
                          className="text-[10px] text-stone-500 hover:text-stone-700 transition-colors border border-stone-200 rounded px-2 py-0.5 hover:bg-white"
                        >
                          {t("reflect.tensions.addToGraph")}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Local tensions section ───────────────────────────────────── */}
          {(() => {
            const localUnresolved = graphState.tensions.filter(
              (t) => t.status === "unresolved" && (t.scope ?? "local") === "local"
            );
            return localUnresolved.length > 0 ? (
              <div>
                <p className="text-[10px] font-medium text-stone-400 uppercase tracking-wide mb-2">
                  {t("reflect.tensions.title")}
                  <span className="ml-1.5 normal-case font-normal text-red-500">
                    — {t("reflect.tensions.unresolved", { count: localUnresolved.length })}
                  </span>
                </p>
                <div className="space-y-2">
                  {localUnresolved.map((tension) => (
                    <TensionCard
                      key={tension.id}
                      tension={tension}
                      nodes={graphState.nodes}
                      onResolve={onTensionResolve}
                    />
                  ))}
                </div>
              </div>
            ) : null;
          })()}

          {/* ── Meta tensions section (cross-graph fault lines) ──────────── */}
          {(() => {
            const metaUnresolved = graphState.tensions.filter(
              (t) => t.status === "unresolved" && t.scope === "cross-graph"
            );
            return metaUnresolved.length > 0 ? (
              <div>
                <p className="text-[10px] font-medium text-stone-400 uppercase tracking-wide mb-2">
                  Meta tensions
                  <span className="ml-1.5 normal-case font-normal text-red-500">
                    — {metaUnresolved.length} fault {metaUnresolved.length === 1 ? "line" : "lines"}
                  </span>
                </p>
                <div className="space-y-2">
                  {metaUnresolved.map((tension) => (
                    <TensionCard
                      key={tension.id}
                      tension={tension}
                      nodes={graphState.nodes}
                      onResolve={onTensionResolve}
                    />
                  ))}
                </div>
              </div>
            ) : null;
          })()}

          {/* ── Optimisation hypothesis card ─────────────────────────────── */}
          {optimizationHypothesis && (
            <div className="rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2.5 space-y-1">
              <p className="text-[10px] font-medium text-amber-700 uppercase tracking-wide">
                {t("reflect.hypothesis")}
              </p>
              <p className="text-xs text-stone-700 leading-relaxed">
                {optimizationHypothesis}
              </p>
            </div>
          )}

          {/* ── Evaluative signals section ───────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-medium text-stone-400 uppercase tracking-wide">
                {t("reflect.signals.title")}
                {graphState.evaluativeSignals.length > 0 && (
                  <span className="ml-1.5 normal-case font-normal">
                    — {t("reflect.signals.rated", {
                      rated: graphState.evaluativeSignals.filter(
                        (s) => s.resonance != null
                      ).length,
                      total: graphState.evaluativeSignals.length,
                    })}
                  </span>
                )}
              </p>
              {/* Enrich button — topology-aware signal enrichment pass */}
              <div className="flex items-center gap-1.5">
                {enrichState === "running" && (
                  <span className="text-[10px] text-amber-500 italic">{t("reflect.signals.enriching")}</span>
                )}
                {enrichState !== "running" && graphState.evaluativeSignals.length > 0 && (
                  <button
                    onClick={handleEnrich}
                    className="text-[10px] text-amber-600 hover:text-amber-800 transition-colors border border-amber-200 rounded px-2 py-0.5 hover:bg-amber-50"
                    title="Enrich signals using graph topology — surfaces reachability framing and optimisation hypothesis"
                  >
                    {enrichState === "done" ? t("reflect.signals.reenrich") : t("reflect.signals.enrich")}
                  </button>
                )}
                {enrichState === "error" && (
                  <span className="text-[10px] text-red-400">{t("reflect.signals.enrichFailed")}</span>
                )}
              </div>
            </div>

            {/* Dedup button row — only shown when signal count > 20 */}
            {(graphState.evaluativeSignals.length > 20 || dedupState === "running") && (
              <div className="flex justify-end mb-1">
                {dedupState !== "running" && (
                  <button
                    onClick={handleDedup}
                    className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors border border-stone-200 rounded px-2 py-0.5 hover:bg-stone-50"
                  >
                    {t("reflect.signals.dedup")}
                  </button>
                )}
                {dedupState === "running" && (
                  <span className="text-[10px] text-stone-400 italic">{t("reflect.signals.deduplicating")}</span>
                )}
              </div>
            )}

            {/* Dedup result banner */}
            {dedupState === "done" && dedupSummary && (
              <div className="mb-2 rounded-lg bg-stone-50 border border-stone-200 px-3 py-2 text-[10px] text-stone-500 flex items-center justify-between">
                <span>{dedupSummary}</span>
                <button onClick={() => setDedupState("idle")} className="text-stone-300 hover:text-stone-500 ml-2">×</button>
              </div>
            )}
            {dedupState === "error" && (
              <div className="mb-2 rounded-lg bg-red-50 border border-red-100 px-3 py-2 text-[10px] text-red-500 flex items-center justify-between">
                <span>{t("reflect.signals.dedupFailed")}</span>
                <button onClick={() => setDedupState("idle")} className="text-red-300 hover:text-red-500 ml-2">×</button>
              </div>
            )}

            {graphState.evaluativeSignals.length === 0 ? (
              <div className="flex items-start justify-center pt-8">
                <p className="text-xs text-stone-400 text-center leading-relaxed max-w-[240px]">
                  {t("reflect.signals.emptyState")}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {graphState.evaluativeSignals.map((s) => (
                  <SignalCard
                    key={s.id}
                    signal={s}
                    projectId={projectId}
                    onReflect={(updates) => onSignalReflect?.(s.id, updates)}
                  />
                ))}
              </div>
            )}
          </div>

        </div>
      )}

      {/* ── Chat mode ─────────────────────────────────────────────────────── */}
      {mode === "chat" && (
        <>
          {/* Messages */}
          <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-[280px] text-center">
                  <p className="text-xs text-stone-500">
                    {t("chat.emptyState")}
                  </p>
                </div>
              </div>
            )}
            {messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                role={msg.role}
                content={msg.content}
                graphUpdates={graphUpdatesMap[msg.id]}
              />
            ))}
            {isLoading && (
              <div className="flex justify-start mb-3">
                <div className="rounded-2xl bg-stone-100 px-4 py-3">
                  <div className="flex gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-stone-400 animate-bounce [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-stone-400 animate-bounce [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-stone-400 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* ── Input area ──────────────────────────────────────────────── */}
          <div className="border-t border-stone-200 px-4 py-2.5">
            {pasteMode ? (
              /* Paste-text mode: large textarea + extract button */
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-stone-400">{t("chat.input.pasteLabel")}</span>
                  <button
                    onClick={() => { setPasteMode(false); setPasteInput(""); }}
                    className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
                <textarea
                  autoFocus
                  value={pasteInput}
                  onChange={(e) => setPasteInput(e.target.value)}
                  placeholder={t("chat.input.pastePlaceholder")}
                  rows={6}
                  className="w-full resize-none rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs text-stone-800 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none"
                  disabled={isLoading}
                />
                <button
                  onClick={handlePasteExtract}
                  disabled={!pasteInput.trim() || isLoading}
                  className="mt-2 w-full rounded-xl bg-stone-800 py-2 text-xs font-medium text-white hover:bg-stone-700 disabled:bg-stone-300 disabled:cursor-not-allowed transition-colors"
                >
                  {isLoading ? t("chat.input.extractingButton") : t("chat.input.extractButton")}
                </button>
              </div>
            ) : (
              /* Normal chat: + button + textarea + send */
              <div className="flex items-end gap-2">
                {/* + button — opens upload/paste menu */}
                <div className="relative shrink-0" ref={plusMenuRef}>
                  <button
                    onClick={() => setShowPlusMenu((prev) => !prev)}
                    className="flex h-8 w-8 items-center justify-center rounded-xl border border-stone-200 bg-white text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-700"
                    title="Add documents or paste text"
                    aria-label="Add content"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5"  y1="12" x2="19" y2="12" />
                    </svg>
                  </button>

                  {/* Dropdown */}
                  {showPlusMenu && (
                    <div className="absolute bottom-full left-0 mb-1.5 w-44 rounded-xl border border-stone-200 bg-white py-1 shadow-md">
                      <button
                        onClick={handleOpenSources}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-stone-700 hover:bg-stone-50 transition-colors"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        {t("chat.plusMenu.upload")}
                      </button>
                      <button
                        onClick={() => { setPasteMode(true); setShowPlusMenu(false); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-stone-700 hover:bg-stone-50 transition-colors"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                          <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                        </svg>
                        {t("chat.plusMenu.paste")}
                      </button>
                    </div>
                  )}
                </div>

                {/* Chat textarea */}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t("chat.input.placeholder")}
                  rows={1}
                  className="flex-1 resize-none rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs text-stone-800 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none"
                  disabled={isLoading}
                />

                {/* Send button */}
                <button
                  onClick={handleChatSubmit}
                  disabled={!input.trim() || isLoading}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-stone-800 text-white transition-colors hover:bg-stone-700 disabled:bg-stone-300 disabled:cursor-not-allowed"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
