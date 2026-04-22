import type { DetectionEvent, LoopMeta, Precision, SessionRouteState } from "./types.js";

const sessionStates = new Map<string, SessionRouteState>();
const currentLoopIds = new Map<string, string>();
const loopMetas = new Map<string, LoopMeta>();
const lastInputEstimates = new Map<string, DetectionEvent>();
const detectionListeners = new Set<(event: DetectionEvent) => void>();
let loopCounter = 0;

function ensureSession(sessionKey: string): SessionRouteState {
  let state = sessionStates.get(sessionKey);
  if (!state) {
    state = { sessionKey, detectionHistory: [] };
    sessionStates.set(sessionKey, state);
  }
  return state;
}

function emit(event: DetectionEvent): void {
  for (const listener of detectionListeners) {
    try {
      listener(event);
    } catch {
      // Ignore listener errors.
    }
  }
}

function previewMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}...` : trimmed;
}

export function startNewLoop(sessionKey: string, userMessage: string): string {
  const loopId = `${Date.now()}-${++loopCounter}`;
  currentLoopIds.set(sessionKey, loopId);
  const state = ensureSession(sessionKey);
  state.currentLoopId = loopId;
  state.userMessage = userMessage;
  state.userMessagePreview = previewMessage(userMessage);
  loopMetas.set(loopId, {
    loopId,
    sessionKey,
    userMessage,
    userMessagePreview: state.userMessagePreview,
    startedAt: Date.now(),
  });
  return loopId;
}

export function getCurrentLoopId(sessionKey: string): string | undefined {
  return currentLoopIds.get(sessionKey);
}

export function getLoopMeta(loopId: string): LoopMeta | undefined {
  return loopMetas.get(loopId);
}

export function onDetection(fn: (event: DetectionEvent) => void): () => void {
  detectionListeners.add(fn);
  return () => detectionListeners.delete(fn);
}

export function notifyDetectionStart(sessionKey: string, loopId?: string): void {
  emit({
    sessionKey,
    timestamp: Date.now(),
    checkpoint: "onUserMessage",
    phase: "start",
    loopId,
  });
}

export function recordDetection(sessionKey: string, event: Omit<DetectionEvent, "sessionKey" | "timestamp" | "checkpoint" | "phase">): void {
  const state = ensureSession(sessionKey);
  state.taskTypeId = event.taskTypeId ?? state.taskTypeId;
  state.precision = event.precision ?? state.precision;
  state.fallbackPath = event.fallbackPath ?? state.fallbackPath;
  state.routedModel = event.target ?? state.routedModel;
  state.routerAction = event.action ?? state.routerAction;

  const fullEvent: DetectionEvent = {
    sessionKey,
    timestamp: Date.now(),
    checkpoint: "onUserMessage",
    phase: "complete",
    ...event,
  };
  state.detectionHistory.push(fullEvent);
  if (state.detectionHistory.length > 500) {
    state.detectionHistory = state.detectionHistory.slice(-500);
  }
  emit(fullEvent);
}

export function notifyGenerating(sessionKey: string, payload: Omit<DetectionEvent, "sessionKey" | "timestamp" | "checkpoint" | "phase">): void {
  emit({
    sessionKey,
    timestamp: Date.now(),
    checkpoint: "onUserMessage",
    phase: "generating",
    ...payload,
  });
}

export function notifyLlmComplete(sessionKey: string): void {
  lastInputEstimates.delete(sessionKey);
  emit({
    sessionKey,
    timestamp: Date.now(),
    checkpoint: "onUserMessage",
    phase: "llm_complete",
    loopId: getCurrentLoopId(sessionKey),
  });
}

export function notifyInputEstimate(
  sessionKey: string,
  data: {
    estimatedInputTokens: number;
    estimatedCost: number;
    model: string;
    provider: string;
    precision?: Precision;
  },
): void {
  const event: DetectionEvent = {
    sessionKey,
    timestamp: Date.now(),
    checkpoint: "onUserMessage",
    phase: "input_estimate",
    loopId: getCurrentLoopId(sessionKey),
    ...data,
  };
  lastInputEstimates.set(sessionKey, event);
  emit(event);
}

export function getLastInputEstimate(sessionKey: string): DetectionEvent | undefined {
  return lastInputEstimates.get(sessionKey);
}

export function setLoopRouting(
  sessionKey: string,
  routing: {
    taskTypeId?: string;
    precision?: Precision;
    fallbackPath?: Precision[];
    routedModel?: string;
    routerAction?: string;
  },
): void {
  const state = ensureSession(sessionKey);
  state.taskTypeId = routing.taskTypeId ?? state.taskTypeId;
  state.precision = routing.precision ?? state.precision;
  state.fallbackPath = routing.fallbackPath ?? state.fallbackPath;
  state.routedModel = routing.routedModel ?? state.routedModel;
  state.routerAction = routing.routerAction ?? state.routerAction;

  const loopId = currentLoopIds.get(sessionKey);
  if (!loopId) return;
  const meta = loopMetas.get(loopId);
  if (!meta) return;
  meta.taskTypeId = routing.taskTypeId ?? meta.taskTypeId;
  meta.precision = routing.precision ?? meta.precision;
  meta.fallbackPath = routing.fallbackPath ?? meta.fallbackPath;
  meta.routedModel = routing.routedModel ?? meta.routedModel;
  meta.routerAction = routing.routerAction ?? meta.routerAction;
}

export function getSessionState(sessionKey: string): SessionRouteState | undefined {
  return sessionStates.get(sessionKey);
}

export function getAllSessionStates(): SessionRouteState[] {
  return Array.from(sessionStates.values());
}

export function clearAllSessionStates(): void {
  sessionStates.clear();
  currentLoopIds.clear();
  loopMetas.clear();
  lastInputEstimates.clear();
}
