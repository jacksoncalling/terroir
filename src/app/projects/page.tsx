'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { Project, ProjectPhase, AttractorPreset, CommonsSynthesisResult } from '@/types';
import { getProjects, createProject, adoptProject, unnestProject } from '@/lib/supabase';
import { useProject } from '@/lib/project-context';
import { ATTRACTOR_PRESETS } from '@/lib/entity-types';

// ── Phase badge ──────────────────────────────────────────────────────────────

const PHASE_STYLES: Record<ProjectPhase, string> = {
  preparation: 'bg-stone-100 text-stone-500',
  workshop:    'bg-amber-100 text-amber-700',
  synthesis:   'bg-violet-100 text-violet-700',
  validation:  'bg-blue-100 text-blue-700',
  live:        'bg-emerald-100 text-emerald-700',
};

function PhaseBadge({ phase }: { phase: ProjectPhase }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${PHASE_STYLES[phase]}`}>
      {phase}
    </span>
  );
}

// ── New project modal ────────────────────────────────────────────────────────

const EMBEDDING_MODELS = [
  { value: 'paraphrase-multilingual-MiniLM-L12-v2', label: 'Multilingual MiniLM L12 (recommended)' },
  { value: 'all-MiniLM-L6-v2', label: 'MiniLM L6 (English only)' },
];

interface NewProjectModalProps {
  onClose: () => void;
  onCreated: (project: Project) => void;
}

function NewProjectModal({ onClose, onCreated, parentProjectId }: NewProjectModalProps & { parentProjectId?: string }) {
  const t = useTranslations();
  const [name, setName] = useState('');
  const [sector, setSector] = useState('');
  const [description, setDescription] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState(EMBEDDING_MODELS[0].value);
  const [attractorPreset, setAttractorPreset] = useState<AttractorPreset>('startup');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setSaving(true);
    setError(null);
    try {
      const project = await createProject({
        name: name.trim(),
        sector: sector.trim() || undefined,
        description: description.trim() || undefined,
        embedding_model: embeddingModel,
        phase: 'preparation',
        metadata: { attractorPreset },
        ...(parentProjectId ? { parent_project_id: parentProjectId } : {}),
      });
      onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-stone-800">{t("projects.newProjectModal.title")}</h2>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 text-lg leading-none"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              {t("projects.newProjectModal.name")} <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Babor Beauty Group"
              className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-300 bg-stone-50"
              autoFocus
            />
          </div>

          {/* Sector */}
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              {t("projects.newProjectModal.sector")} <span className="text-stone-400">{t("projects.newProjectModal.sectorOptional")}</span>
            </label>
            <input
              type="text"
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              placeholder="e.g. Skincare / E-Commerce"
              className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-300 bg-stone-50"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              {t("projects.newProjectModal.description")} <span className="text-stone-400">{t("projects.newProjectModal.sectorOptional")}</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project about?"
              rows={2}
              className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-300 bg-stone-50 resize-none"
            />
          </div>

          {/* Attractor preset */}
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1.5">
              Ontology scaffolding
            </label>
            <div className="flex flex-col gap-2">
              {([
                { value: 'startup'    as const, label: 'Small team / Startup',     desc: 'Domain, Capability, Toolchain, Customer, Method, Value' },
                { value: 'enterprise' as const, label: 'Enterprise / Mittelstand', desc: 'Identity, Policy, Structure, People, Functions, Processes, Resources' },
                { value: 'individual' as const, label: 'Individual',               desc: 'Identity, Belonging, Projects, Skills, Values' },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setAttractorPreset(opt.value)}
                  className={`text-left p-3 rounded-lg border transition-all ${
                    attractorPreset === opt.value
                      ? 'border-stone-800 bg-stone-50 ring-1 ring-stone-800'
                      : 'border-stone-200 hover:border-stone-300 bg-white'
                  }`}
                >
                  <span className="block text-xs font-medium text-stone-700">{opt.label}</span>
                  <span className="block text-[10px] text-stone-400 mt-1 leading-tight">{opt.desc}</span>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-stone-400 mt-1.5">
              Attractor categories guide where entities land. You can customize them later.
            </p>
          </div>

          {/* Embedding model */}
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Embedding model
            </label>
            <select
              value={embeddingModel}
              onChange={(e) => setEmbeddingModel(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-300 bg-stone-50"
            >
              {EMBEDDING_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-stone-400 mt-1">
              Must match the model used when ingesting documents. Cannot be changed later.
            </p>
          </div>

          {error && (
            <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-stone-500 hover:text-stone-700 transition-colors"
            >
              {t("projects.newProjectModal.cancel")}
            </button>
            <button
              type="submit"
              disabled={!name.trim() || saving}
              className="px-4 py-2 text-sm bg-stone-800 text-white rounded-lg hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? t("projects.newProjectModal.creating") : t("projects.newProjectModal.create")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Nest under modal ────────────────────────────────────────────────────────

interface NestModalProps {
  project: Project;
  eligibleParents: Project[];
  onClose: () => void;
  onNest: (childId: string, parentId: string) => Promise<void>;
}

function NestModal({ project, eligibleParents, onClose, onNest }: NestModalProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleNest = async (parentId: string) => {
    setSaving(true);
    setError(null);
    try {
      await onNest(project.id, parentId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to nest project');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-stone-800">
            Nest "{project.name}" under…
          </h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-lg leading-none">
            ×
          </button>
        </div>

        {eligibleParents.length === 0 ? (
          <p className="text-xs text-stone-400 py-4">No eligible parent projects.</p>
        ) : (
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {eligibleParents.map((p) => (
              <button
                key={p.id}
                onClick={() => handleNest(p.id)}
                disabled={saving}
                className="w-full text-left px-3 py-2.5 rounded-lg border border-stone-200 hover:border-stone-400 hover:bg-stone-50 transition-all disabled:opacity-40"
              >
                <span className="text-xs font-medium text-stone-700">{p.name}</span>
                {p.sector && (
                  <span className="text-[10px] text-stone-400 ml-2">{p.sector}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {error && (
          <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-lg mt-3">{error}</p>
        )}
      </div>
    </div>
  );
}

// ── Project card ─────────────────────────────────────────────────────────────

interface ProjectCardProps {
  project: Project;
  onSelect: (project: Project) => void;
  onAddSubProject?: (parentId: string) => void;
  onNestUnder?: (project: Project) => void;
  onUnnest?: (projectId: string) => void;
  isChild?: boolean;
  parentName?: string;
  checked?: boolean;
  onCheck?: (projectId: string, checked: boolean) => void;
}

function ProjectCard({ project, onSelect, onAddSubProject, onNestUnder, onUnnest, isChild, parentName, checked, onCheck }: ProjectCardProps) {
  const updatedAt = new Date(project.updated_at);
  const relativeTime = formatRelativeTime(updatedAt);
  const preset = (project.metadata as Record<string, unknown>)?.attractorPreset as string | undefined;

  return (
    <div className={`w-full text-left bg-white border rounded-xl p-5 hover:border-stone-400 hover:shadow-sm transition-all group ${isChild ? 'ml-6 border-l-2 border-l-stone-300' : ''} ${checked ? 'border-violet-400 ring-1 ring-violet-200' : 'border-stone-200'}`}>
      <div className="flex items-start gap-3">
        {onCheck && (
          <input
            type="checkbox"
            checked={checked ?? false}
            onChange={(e) => { e.stopPropagation(); onCheck(project.id, e.target.checked); }}
            className="mt-1 h-3.5 w-3.5 rounded border-stone-300 text-violet-600 focus:ring-violet-300 shrink-0 cursor-pointer accent-violet-600"
          />
        )}
        <button onClick={() => onSelect(project)} className="w-full text-left min-w-0">
          {parentName && (
            <p className="text-[10px] text-stone-400 mb-1">{parentName} /</p>
          )}
          <div className="flex items-start justify-between gap-3 mb-2">
            <h3 className="text-sm font-semibold text-stone-800 group-hover:text-stone-900 leading-tight">
              {project.name}
            </h3>
            <PhaseBadge phase={project.phase} />
          </div>

          {project.sector && (
            <p className="text-[11px] text-stone-400 mb-2">{project.sector}</p>
          )}

          {project.description && (
            <p className="text-xs text-stone-500 mb-3 line-clamp-2">{project.description}</p>
          )}

          <div className="flex items-center gap-3 text-[10px] text-stone-400">
            <span>Updated {relativeTime}</span>
            {preset && (
              <>
                <span className="text-stone-200">·</span>
                <span className="capitalize">{preset}</span>
              </>
            )}
          </div>
        </button>
      </div>

      {/* Card actions */}
      <div className="mt-3 flex items-center gap-3">
        {!isChild && onAddSubProject && (
          <button
            onClick={(e) => { e.stopPropagation(); onAddSubProject(project.id); }}
            className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
          >
            + Add sub-project
          </button>
        )}
        {!isChild && !project.parent_project_id && onNestUnder && (
          <button
            onClick={(e) => { e.stopPropagation(); onNestUnder(project); }}
            className="text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
          >
            Nest under…
          </button>
        )}
        {isChild && onUnnest && (
          <button
            onClick={(e) => { e.stopPropagation(); onUnnest(project.id); }}
            className="text-[10px] text-stone-400 hover:text-red-500 transition-colors"
          >
            Make independent
          </button>
        )}
      </div>
    </div>
  );
}

// ── Commons results modal ──────────────────────────────────────────────────

function CommonsResultsModal({
  result,
  onClose,
}: {
  result: CommonsSynthesisResult;
  onClose: () => void;
}) {
  const t = useTranslations("projects.commons");
  const hasResults =
    result.convergence.length > 0 ||
    result.contactPoints.length > 0 ||
    result.evaluativeDivergence.length > 0 ||
    result.reachabilityGaps.length > 0;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 p-6 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-stone-800">{t("title")}</h2>
            <p className="text-[11px] text-stone-400 mt-0.5">{t("subtitle")}</p>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 text-lg leading-none"
          >
            ×
          </button>
        </div>

        {!hasResults && (
          <p className="text-sm text-stone-400 py-8 text-center">{t("noResults")}</p>
        )}

        {result.convergence.length > 0 && (
          <section className="mb-6">
            <h3 className="text-xs font-semibold text-violet-700 uppercase tracking-wide mb-1">{t("convergence")}</h3>
            <p className="text-[10px] text-stone-400 mb-3">{t("convergenceDesc")}</p>
            <div className="space-y-2">
              {result.convergence.map((c, i) => (
                <div key={i} className="bg-violet-50 border border-violet-100 rounded-lg p-3">
                  <p className="text-xs font-medium text-stone-700">{c.label}</p>
                  <p className="text-[10px] text-stone-500 mt-1">{c.rationale}</p>
                  <p className="text-[10px] text-violet-500 mt-1">{c.projects.join(" · ")}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {result.contactPoints.length > 0 && (
          <section className="mb-6">
            <h3 className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">{t("contactPoints")}</h3>
            <p className="text-[10px] text-stone-400 mb-3">{t("contactPointsDesc")}</p>
            <div className="space-y-2">
              {result.contactPoints.map((c, i) => (
                <div key={i} className="bg-amber-50 border border-amber-100 rounded-lg p-3">
                  <p className="text-xs font-medium text-stone-700">{c.theme}</p>
                  <p className="text-[10px] text-stone-500 mt-1">{c.description}</p>
                  <p className="text-[10px] text-amber-500 mt-1">{c.projects.join(" · ")}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {result.evaluativeDivergence.length > 0 && (
          <section className="mb-6">
            <h3 className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">{t("divergence")}</h3>
            <p className="text-[10px] text-stone-400 mb-3">{t("divergenceDesc")}</p>
            <div className="space-y-2">
              {result.evaluativeDivergence.map((d, i) => (
                <div key={i} className="bg-red-50 border border-red-100 rounded-lg p-3">
                  <p className="text-xs font-medium text-stone-700">{d.signal}</p>
                  <p className="text-[10px] text-stone-500 mt-1">{d.divergence}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {result.reachabilityGaps.length > 0 && (
          <section className="mb-6">
            <h3 className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1">{t("gaps")}</h3>
            <p className="text-[10px] text-stone-400 mb-3">{t("gapsDesc")}</p>
            <div className="space-y-2">
              {result.reachabilityGaps.map((g, i) => (
                <div key={i} className="bg-blue-50 border border-blue-100 rounded-lg p-3">
                  <p className="text-xs font-medium text-stone-700">{g.node}</p>
                  <div className="flex gap-4 mt-1">
                    <p className="text-[10px] text-blue-600">{t("presentIn")}: {g.presentIn}</p>
                    <p className="text-[10px] text-stone-400">{t("absentFrom")}: {g.absentFrom}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="flex justify-end pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-stone-500 hover:text-stone-700 transition-colors"
          >
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ProjectsPage() {
  const router = useRouter();
  const { setProjectId } = useProject();
  const t = useTranslations();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [newProjectParentId, setNewProjectParentId] = useState<string | undefined>();
  const [nestTarget, setNestTarget] = useState<Project | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [commonsLoading, setCommonsLoading] = useState(false);
  const [commonsResult, setCommonsResult] = useState<CommonsSynthesisResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getProjects();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSelect = useCallback(
    (project: Project) => {
      setProjectId(project.id);
      router.push('/');
    },
    [setProjectId, router]
  );

  const handleCreated = useCallback(
    (project: Project) => {
      setShowModal(false);
      setProjectId(project.id);
      router.push('/');
    },
    [setProjectId, router]
  );

  const handleNest = useCallback(
    async (childId: string, parentId: string) => {
      await adoptProject(childId, parentId);
      // NestModal calls onClose() after this succeeds — no need to clear nestTarget here
      await load();
    },
    [load]
  );

  const handleUnnest = useCallback(
    async (projectId: string) => {
      try {
        await unnestProject(projectId);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to unnest project');
      }
    },
    [load]
  );

  const handleCheck = useCallback((projectId: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  }, []);

  const handleFindCommons = useCallback(async () => {
    if (selectedIds.size < 2) return;
    setCommonsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/commons-synthesis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectIds: [...selectedIds], scope: "team" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Commons synthesis failed");
      setCommonsResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Commons synthesis failed");
    } finally {
      setCommonsLoading(false);
    }
  }, [selectedIds]);

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Header */}
      <header className="border-b border-stone-200 bg-white px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-stone-800 tracking-tight">{t("projects.title")}</h1>
            <p className="text-[11px] text-stone-400 mt-0.5">{t("projects.subtitle")}</p>
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="px-4 py-2 text-sm bg-stone-800 text-white rounded-lg hover:bg-stone-700 transition-colors"
          >
            {t("projects.newProject")}
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 py-8">
        {loading && (
          <div className="flex items-center justify-center py-20">
            <p className="text-sm text-stone-400">{t("projects.loading")}</p>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
            <p className="text-sm text-red-600">{error}</p>
            <button
              onClick={load}
              className="text-xs text-red-500 underline mt-1"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && projects.length === 0 && (
          <div className="text-center py-20">
            <p className="text-stone-500 mb-2 text-sm">{t("projects.noProjects")}</p>
            <p className="text-stone-400 text-xs mb-6">
              {t("projects.noProjectsDesc")}
            </p>
            <button
              onClick={() => setShowModal(true)}
              className="px-4 py-2 text-sm bg-stone-800 text-white rounded-lg hover:bg-stone-700 transition-colors"
            >
              {t("projects.newProject")}
            </button>
          </div>
        )}

        {!loading && projects.length > 0 && (() => {
          const parentProjects = projects.filter((p) => !p.parent_project_id);
          const childrenByParent = projects.reduce<Record<string, Project[]>>((acc, p) => {
            if (p.parent_project_id) {
              if (!acc[p.parent_project_id]) acc[p.parent_project_id] = [];
              acc[p.parent_project_id].push(p);
            }
            return acc;
          }, {});

          return (
            <>
              <p className="text-xs text-stone-400 mb-4">
                {projects.length} {projects.length === 1 ? 'project' : 'projects'}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {parentProjects.map((project) => (
                  <div key={project.id} className="space-y-2">
                    <ProjectCard
                      project={project}
                      onSelect={handleSelect}
                      onAddSubProject={(parentId) => {
                        setNewProjectParentId(parentId);
                        setShowModal(true);
                      }}
                      onNestUnder={(p) => setNestTarget(p)}
                      onUnnest={handleUnnest}
                      checked={selectedIds.has(project.id)}
                      onCheck={handleCheck}
                    />
                    {childrenByParent[project.id]?.map((child) => (
                      <ProjectCard
                        key={child.id}
                        project={child}
                        onSelect={handleSelect}
                        isChild
                        parentName={project.name}
                        onUnnest={handleUnnest}
                        checked={selectedIds.has(child.id)}
                        onCheck={handleCheck}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </>
          );
        })()}
      </main>

      {showModal && (
        <NewProjectModal
          onClose={() => { setShowModal(false); setNewProjectParentId(undefined); }}
          onCreated={handleCreated}
          parentProjectId={newProjectParentId}
        />
      )}

      {nestTarget && (
        <NestModal
          project={nestTarget}
          eligibleParents={projects.filter((p) =>
            // Eligible: no parent of its own, not the target itself, not already a child of the target
            !p.parent_project_id && p.id !== nestTarget.id
          )}
          onClose={() => setNestTarget(null)}
          onNest={handleNest}
        />
      )}

      {/* Floating commons bar */}
      {selectedIds.size >= 2 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-stone-800 text-white rounded-full shadow-xl px-5 py-2.5 flex items-center gap-4 z-40">
          <span className="text-xs text-stone-300">
            {t("projects.commons.selected", { count: selectedIds.size })}
          </span>
          <button
            onClick={handleFindCommons}
            disabled={commonsLoading}
            className="px-4 py-1.5 text-sm bg-violet-600 rounded-full hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {commonsLoading ? t("projects.commons.running") : t("projects.commons.findCommons")}
          </button>
        </div>
      )}

      {commonsResult && (
        <CommonsResultsModal
          result={commonsResult}
          onClose={() => setCommonsResult(null)}
        />
      )}
    </div>
  );
}
