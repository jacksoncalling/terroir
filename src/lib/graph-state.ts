import { v4 as uuidv4 } from "uuid";
import type {
  GraphState,
  GraphNode,
  Relationship,
  TensionMarker,
  EvaluativeSignal,
  EntityTypeConfig,
} from "@/types";
import { HUB_RELATIONSHIP_TYPE } from "@/types";
import { getDefaultEntityTypes, ensureTypeExists, findHubByAttractorId } from "./entity-types";

export function emptyGraphState(): GraphState {
  return {
    nodes: [],
    relationships: [],
    tensions: [],
    evaluativeSignals: [],
    entityTypes: getDefaultEntityTypes(),
  };
}

export function addNode(
  state: GraphState,
  label: string,
  type: string,
  description: string,
  position: { x: number; y: number },
  properties?: Record<string, string>,
  hubId?: string,
  hubDescription?: string
): { state: GraphState; node: GraphNode } {
  // Resolve hub: if hubId is a hub node ID, use it directly.
  // If it's an attractor slug (e.g. "domain"), find the hub node.
  let resolvedHubId: string | undefined;
  let attractorCache = 'emergent';

  if (hubId) {
    const directHub = state.nodes.find((n) => n.id === hubId && n.is_hub);
    if (directHub) {
      resolvedHubId = directHub.id;
      attractorCache = directHub.properties?.attractor_id ?? directHub.label.toLowerCase();
    } else {
      // Try to find hub by attractor_id property (e.g. "domain", "capability")
      const hubBySlug = findHubByAttractorId(hubId, state);
      if (hubBySlug) {
        resolvedHubId = hubBySlug.id;
        attractorCache = hubId;
      }
    }
  }

  // Fallback: find the emergent hub
  if (!resolvedHubId) {
    const emergentHub = findHubByAttractorId('emergent', state);
    if (emergentHub) {
      resolvedHubId = emergentHub.id;
      attractorCache = 'emergent';
    }
  }

  const node: GraphNode = {
    id: uuidv4(),
    label,
    type,
    attractor: attractorCache,
    description,
    position,
    properties,
  };

  const updatedTypes = ensureTypeExists(state.entityTypes, type);
  let newRelationships = state.relationships;

  // Auto-create belongs_to_hub relationship if we found a hub
  if (resolvedHubId) {
    const hubRel: Relationship = {
      id: uuidv4(),
      sourceId: node.id,
      targetId: resolvedHubId,
      type: HUB_RELATIONSHIP_TYPE,
      description: hubDescription,
    };
    newRelationships = [...newRelationships, hubRel];
  }

  return {
    state: {
      ...state,
      nodes: [...state.nodes, node],
      relationships: newRelationships,
      entityTypes: updatedTypes,
    },
    node,
  };
}

export function updateNode(
  state: GraphState,
  id: string,
  updates: Partial<Pick<GraphNode, "label" | "description" | "type" | "attractor" | "properties" | "position" | "sharingScope">>,
  newHubId?: string,
  hubDescription?: string
): GraphState {
  let updatedTypes = state.entityTypes;
  if (updates.type) {
    updatedTypes = ensureTypeExists(updatedTypes, updates.type);
  }

  let updatedRelationships = state.relationships;
  const nodeUpdates = { ...updates };

  // If changing hub, update the belongs_to_hub relationship + attractor cache
  if (newHubId) {
    // Resolve hub (by ID or attractor slug)
    let resolvedHub = state.nodes.find((n) => n.id === newHubId && n.is_hub);
    if (!resolvedHub) {
      resolvedHub = findHubByAttractorId(newHubId, state);
    }

    if (resolvedHub) {
      // Remove old hub relationships for this node
      updatedRelationships = updatedRelationships.filter(
        (r) => !(r.sourceId === id && r.type === HUB_RELATIONSHIP_TYPE)
      );
      // Add new hub relationship
      updatedRelationships = [
        ...updatedRelationships,
        {
          id: uuidv4(),
          sourceId: id,
          targetId: resolvedHub.id,
          type: HUB_RELATIONSHIP_TYPE,
          description: hubDescription,
        },
      ];
      // Update attractor cache
      nodeUpdates.attractor = resolvedHub.properties?.attractor_id ?? resolvedHub.label.toLowerCase();
    }
  }

  return {
    ...state,
    nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...nodeUpdates } : n)),
    relationships: updatedRelationships,
    entityTypes: updatedTypes,
  };
}

/** Add a node to an additional hub (multi-hub membership) */
export function addNodeToHub(
  state: GraphState,
  nodeId: string,
  hubId: string,
  description?: string
): GraphState {
  const hub = state.nodes.find((n) => n.id === hubId && n.is_hub);
  if (!hub) return state;

  // Check if relationship already exists
  const exists = state.relationships.some(
    (r) => r.sourceId === nodeId && r.targetId === hubId && r.type === HUB_RELATIONSHIP_TYPE
  );
  if (exists) return state;

  return {
    ...state,
    relationships: [
      ...state.relationships,
      {
        id: uuidv4(),
        sourceId: nodeId,
        targetId: hubId,
        type: HUB_RELATIONSHIP_TYPE,
        description,
      },
    ],
  };
}

/** Remove a node from a hub */
export function removeNodeFromHub(
  state: GraphState,
  nodeId: string,
  hubId: string
): GraphState {
  return {
    ...state,
    relationships: state.relationships.filter(
      (r) => !(r.sourceId === nodeId && r.targetId === hubId && r.type === HUB_RELATIONSHIP_TYPE)
    ),
  };
}

export function updateNodePosition(
  state: GraphState,
  id: string,
  position: { x: number; y: number }
): GraphState {
  return {
    ...state,
    nodes: state.nodes.map((n) =>
      n.id === id ? { ...n, position } : n
    ),
  };
}

export function deleteNode(state: GraphState, id: string): GraphState {
  return {
    ...state,
    nodes: state.nodes.filter((n) => n.id !== id),
    relationships: state.relationships.filter(
      (r) => r.sourceId !== id && r.targetId !== id
    ),
    tensions: state.tensions.map((t) => ({
      ...t,
      relatedNodeIds: t.relatedNodeIds.filter((nid) => nid !== id),
    })),
  };
}

export function addRelationship(
  state: GraphState,
  sourceId: string,
  targetId: string,
  type: string,
  description?: string
): { state: GraphState; relationship: Relationship } {
  const relationship: Relationship = {
    id: uuidv4(),
    sourceId,
    targetId,
    type,
    description,
  };
  return {
    state: { ...state, relationships: [...state.relationships, relationship] },
    relationship,
  };
}

export function deleteRelationship(state: GraphState, id: string): GraphState {
  return {
    ...state,
    relationships: state.relationships.filter((r) => r.id !== id),
  };
}

export function flagTension(
  state: GraphState,
  description: string,
  relatedNodeIds: string[]
): { state: GraphState; tension: TensionMarker } {
  const tension: TensionMarker = {
    id: uuidv4(),
    description,
    relatedNodeIds,
    status: "unresolved",
  };
  return {
    state: { ...state, tensions: [...state.tensions, tension] },
    tension,
  };
}

export function resolveTension(state: GraphState, id: string): GraphState {
  return {
    ...state,
    tensions: state.tensions.map((t) =>
      t.id === id ? { ...t, status: "resolved" as const } : t
    ),
  };
}

export function setEvaluativeSignal(
  state: GraphState,
  label: string,
  direction: EvaluativeSignal["direction"],
  strength: number,
  sourceDescription: string,
  temporalHorizon?: EvaluativeSignal["temporalHorizon"],
  relatedNodeIds?: string[]
): { state: GraphState; signal: EvaluativeSignal } {
  const existing = state.evaluativeSignals.find((s) => s.label === label);
  if (existing) {
    const updated = {
      ...existing,
      direction,
      strength,
      sourceDescription,
      ...(temporalHorizon !== undefined ? { temporalHorizon } : {}),
      ...(relatedNodeIds !== undefined ? { relatedNodeIds } : {}),
    };
    return {
      state: {
        ...state,
        evaluativeSignals: state.evaluativeSignals.map((s) =>
          s.id === existing.id ? updated : s
        ),
      },
      signal: updated,
    };
  }
  const signal: EvaluativeSignal = {
    id: uuidv4(),
    label,
    direction,
    strength,
    sourceDescription,
    ...(temporalHorizon !== undefined ? { temporalHorizon } : {}),
    ...(relatedNodeIds && relatedNodeIds.length > 0 ? { relatedNodeIds } : {}),
  };
  return {
    state: {
      ...state,
      evaluativeSignals: [...state.evaluativeSignals, signal],
    },
    signal,
  };
}

export function updateEntityTypes(
  state: GraphState,
  entityTypes: EntityTypeConfig[]
): GraphState {
  return { ...state, entityTypes };
}

// Keys — graph is now project-scoped; legacy unscoped key kept for Phase 1 migration only
const LEGACY_STORAGE_KEY = "terroir-graph-state-v2";
const LEGACY_MESSAGES_KEY = "terroir-messages-v2";

const graphKey = (projectId: string) => `terroir-graph-v2:${projectId}`;
const messagesKey = (projectId: string) => `terroir-messages-v2:${projectId}`;

export function saveToLocalStorage(state: GraphState, projectId?: string): void {
  if (typeof window !== "undefined") {
    const key = projectId ? graphKey(projectId) : LEGACY_STORAGE_KEY;
    localStorage.setItem(key, JSON.stringify(state));
  }
}

export function loadFromLocalStorage(projectId?: string): GraphState | null {
  if (typeof window !== "undefined") {
    const key = projectId ? graphKey(projectId) : LEGACY_STORAGE_KEY;
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (!parsed.entityTypes) {
          parsed.entityTypes = getDefaultEntityTypes();
        }
        if (parsed.nodes) {
          parsed.nodes = parsed.nodes.map((n: GraphNode, i: number) => ({
            ...n,
            position: n.position || { x: 200 + (i % 5) * 200, y: 200 + Math.floor(i / 5) * 150 },
          }));
        }
        return parsed;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function saveMessagesToLocalStorage(
  messages: { id: string; role: "user" | "assistant"; content: string; timestamp: number }[],
  projectId?: string
): void {
  if (typeof window !== "undefined") {
    const key = projectId ? messagesKey(projectId) : LEGACY_MESSAGES_KEY;
    localStorage.setItem(key, JSON.stringify(messages));
  }
}

export function loadMessagesFromLocalStorage(projectId?: string): {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}[] | null {
  if (typeof window !== "undefined") {
    const key = projectId ? messagesKey(projectId) : LEGACY_MESSAGES_KEY;
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function clearLocalStorage(projectId?: string): void {
  if (typeof window !== "undefined") {
    if (projectId) {
      localStorage.removeItem(graphKey(projectId));
      localStorage.removeItem(messagesKey(projectId));
    } else {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      localStorage.removeItem(LEGACY_MESSAGES_KEY);
    }
  }
}

// Phase 1 migration: read the unscoped legacy graph (once, for import)
export function loadLegacyGraphFromLocalStorage(): GraphState | null {
  return loadFromLocalStorage(undefined); // reads LEGACY_STORAGE_KEY
}
