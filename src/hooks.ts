import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLiveConfig } from "./live-config.js";
import { getGlobalPipeline } from "./router-pipeline.js";
import { getSyntheticProviderId, resolvePrecisionFromProvider } from "./provider.js";
import {
  getCurrentLoopId,
  notifyDetectionStart,
  notifyGenerating,
  notifyInputEstimate,
  notifyLlmComplete,
  recordDetection,
  setLoopRouting,
  startNewLoop,
} from "./session-state.js";
import { getGlobalCollector, lookupPricing } from "./token-stats.js";
import type { Precision } from "./types.js";

type LiveSessionStoreEntry = {
  sessionId: string;
  updatedAt: number;
  providerOverride?: string;
  modelOverride?: string;
};

type LiveSessionStore = Record<string, LiveSessionStoreEntry>;

type RoutedModelSelection = {
  provider: string;
  model: string;
};

function resolveHookSessionKey(ctx: { sessionKey?: string; sessionId?: string }): string {
  return ctx.sessionKey || ctx.sessionId || "";
}

function parseModelRef(ref: string | undefined): RoutedModelSelection | null {
  const trimmed = ref?.trim();
  if (!trimmed) return null;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return null;
  return {
    provider: trimmed.slice(0, slashIndex),
    model: trimmed.slice(slashIndex + 1),
  };
}

function resolveConfiguredAgentModel(
  config: Record<string, unknown>,
  agentId: string,
): RoutedModelSelection | null {
  const agents = config.agents as {
    defaults?: { provider?: string; model?: { primary?: string } };
    list?: Array<{ id?: string; model?: string }>;
  } | undefined;

  const agentModel = agents?.list?.find((entry) => entry.id === agentId)?.model;
  const resolvedAgentModel = parseModelRef(agentModel);
  if (resolvedAgentModel) return resolvedAgentModel;

  const primaryRef = agents?.defaults?.model?.primary;
  const resolvedPrimary = parseModelRef(primaryRef);
  if (resolvedPrimary) return resolvedPrimary;

  const defaultProvider = agents?.defaults?.provider?.trim();
  if (!defaultProvider) return null;
  return { provider: defaultProvider, model: "" };
}

function resolveLiveSessionStorePath(storeTemplate: string | undefined, agentId: string): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/root";
  if (!storeTemplate) {
    return path.resolve(homeDir, ".openclaw", "agents", agentId, "sessions", "sessions.json");
  }

  const withAgent = storeTemplate.includes("{agentId}")
    ? storeTemplate.replaceAll("{agentId}", agentId)
    : storeTemplate;
  const expanded = withAgent.startsWith("~")
    ? path.join(homeDir, withAgent.slice(1))
    : withAgent;
  return path.resolve(expanded);
}

function loadLiveSessionStore(storePath: string): LiveSessionStore {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw) as LiveSessionStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistLiveSessionSelection(params: {
  storePath: string;
  sessionKey: string;
  sessionId?: string;
  selection: RoutedModelSelection;
}): boolean {
  const { storePath, sessionKey, selection } = params;
  const sessionId = params.sessionId?.trim() || sessionKey;
  if (!sessionKey || !selection.provider || !selection.model) return false;

  const store = loadLiveSessionStore(storePath);
  const existing = store[sessionKey];
  const nextEntry: LiveSessionStoreEntry = existing
    ? { ...existing }
    : { sessionId, updatedAt: Date.now() };

  const changed =
    nextEntry.sessionId !== sessionId ||
    nextEntry.providerOverride !== selection.provider ||
    nextEntry.modelOverride !== selection.model;
  if (!changed) return false;

  nextEntry.sessionId = sessionId;
  nextEntry.providerOverride = selection.provider;
  nextEntry.modelOverride = selection.model;
  nextEntry.updatedAt = Date.now();
  store[sessionKey] = nextEntry;

  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  return true;
}

function routeWithLiveSessionSync(params: {
  api: OpenClawPluginApi;
  config: Record<string, unknown>;
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
  provider: string;
  model?: string;
  fallbackSelection?: RoutedModelSelection | null;
}): { providerOverride: string; modelOverride?: string } {
  const provider = params.provider.trim();
  const resolvedModel = params.model?.trim() || params.fallbackSelection?.model?.trim() || "";
  if (!provider) return { providerOverride: params.provider };
  if (!resolvedModel) return { providerOverride: provider };

  const selection: RoutedModelSelection = { provider, model: resolvedModel };
  const agentId = params.agentId?.trim() || "main";
  const sessionCfg = params.config.session as { store?: string } | undefined;
  const storePath = resolveLiveSessionStorePath(sessionCfg?.store, agentId);

  try {
    persistLiveSessionSelection({
      storePath,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      selection,
    });
  } catch (err) {
    params.api.logger.warn(`[QuantClaw] Failed to sync live session selection for ${params.sessionKey}: ${String(err)}`);
  }

  return {
    providerOverride: selection.provider,
    modelOverride: selection.model,
  };
}

function normalizeUsage(usage: Record<string, unknown> | undefined): { input?: number; output?: number; cacheRead?: number; total?: number } | undefined {
  if (!usage) return undefined;
  const input = Number(usage.input ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const output = Number(usage.output ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0);
  const cacheRead = Number(usage.cacheRead ?? usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? 0);
  const total = Number(usage.total ?? usage.totalTokens ?? usage.total_tokens ?? (input + output));
  return { input, output, cacheRead, total };
}

function estimateTokens(text: string | undefined): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

function estimateHistoryTokens(historyMessages: unknown): number {
  if (!Array.isArray(historyMessages)) return 0;
  let total = 0;
  for (const message of historyMessages) {
    total += estimateTokens(typeof message === "string" ? message : JSON.stringify(message));
  }
  return total;
}

export function registerHooks(api: OpenClawPluginApi): void {
  api.on("before_model_resolve", async (event, ctx) => {
    try {
      const sessionKey = resolveHookSessionKey(ctx) || event.sessionId || "";
      if (!sessionKey) return;

      const prompt = String(event.prompt ?? "");
      if (!prompt.trim()) return;

      const quantConfig = getLiveConfig();
      if (!quantConfig.enabled) return;

      const agentId = ctx.agentId?.trim() || "main";
      const configuredSelection = resolveConfiguredAgentModel(api.config as Record<string, unknown>, agentId);
      const route = (provider: string, model?: string) => routeWithLiveSessionSync({
        api,
        config: api.config as Record<string, unknown>,
        sessionKey,
        sessionId: ctx.sessionId,
        agentId,
        provider,
        model,
        fallbackSelection: configuredSelection,
      });

      const loopId = startNewLoop(sessionKey, prompt);
      notifyDetectionStart(sessionKey, loopId);

      const pipeline = getGlobalPipeline();
      if (!pipeline) {
        api.logger.warn("[QuantClaw] Router pipeline not initialized");
        return;
      }

      const decision = await pipeline.run(
        "onUserMessage",
        {
          checkpoint: "onUserMessage",
          message: prompt,
          sessionKey,
          agentId: ctx.agentId,
        },
        {
          quant: quantConfig,
          hostConfig: api.config as Record<string, unknown>,
        },
      );

      const routedTarget = decision.target ? `${decision.target.provider}/${decision.target.model}` : undefined;
      recordDetection(sessionKey, {
        reason: decision.reason,
        routerId: decision.routerId,
        action: decision.action,
        target: routedTarget,
        taskTypeId: decision.taskTypeId,
        precision: decision.precision,
        fallbackPath: decision.fallbackPath,
        loopId,
      });
      setLoopRouting(sessionKey, {
        taskTypeId: decision.taskTypeId,
        precision: decision.precision,
        fallbackPath: decision.fallbackPath,
        routedModel: routedTarget,
        routerAction: decision.action,
      });

      if ((decision.action ?? "passthrough") !== "passthrough") {
        notifyGenerating(sessionKey, {
          reason: decision.reason,
          routerId: decision.routerId,
          action: decision.action,
          target: routedTarget,
          taskTypeId: decision.taskTypeId,
          precision: decision.precision,
          fallbackPath: decision.fallbackPath,
          loopId,
        });
      }

      if (decision.action !== "redirect" || !decision.precision || !decision.target) {
        return;
      }

      const syntheticProvider = getSyntheticProviderId(decision.precision);
      api.logger.info(
        `[QuantClaw] ROUTE session=${sessionKey} taskType=${decision.taskTypeId} precision=${decision.precision} target=${routedTarget}`,
      );
      return route(syntheticProvider, decision.target.model);
    } catch (err) {
      api.logger.error(`[QuantClaw] Error in before_model_resolve: ${String(err)}`);
    }
  });

  api.on("llm_output", async (event, ctx) => {
    try {
      const sessionKey = resolveHookSessionKey(ctx) || event.sessionId || "";
      const loopId = getCurrentLoopId(sessionKey);
      const usage = normalizeUsage(event.usage as Record<string, unknown> | undefined);
      const precision = resolvePrecisionFromProvider(event.provider);
      const collector = getGlobalCollector();
      collector?.record({
        sessionKey,
        provider: event.provider ?? "unknown",
        model: event.model ?? "unknown",
        source: "task",
        usage,
        loopId,
        precision,
      });

      if (sessionKey) {
        const inputTok = usage?.input ?? 0;
        const outputTok = usage?.output ?? 0;
        const summary = `${event.model ?? "unknown"} - in:${inputTok} out:${outputTok}`;
        recordDetection(sessionKey, {
          reason: summary,
          target: `${event.provider ?? "unknown"}/${event.model ?? "unknown"}`,
          precision,
          loopId,
        });
        notifyLlmComplete(sessionKey);
      }
    } catch (err) {
      api.logger.error(`[QuantClaw] Error in llm_output hook: ${String(err)}`);
    }
  });

  api.on("llm_input", async (event, ctx) => {
    try {
      const sessionKey = resolveHookSessionKey(ctx) || event.sessionId || "";
      const precision = resolvePrecisionFromProvider(event.provider as string | undefined);
      const inputTokens =
        estimateTokens(event.systemPrompt) +
        estimateTokens(event.prompt) +
        estimateHistoryTokens(event.historyMessages);
      const pricing = lookupPricing(event.model ?? "unknown", precision as Precision | undefined);
      const estimatedCost = (inputTokens * pricing.inputPer1M) / 1_000_000;

      notifyInputEstimate(sessionKey, {
        estimatedInputTokens: inputTokens,
        estimatedCost,
        model: event.model ?? "unknown",
        provider: event.provider ?? "unknown",
        precision,
      });
    } catch (err) {
      api.logger.error(`[QuantClaw] Error in llm_input hook: ${String(err)}`);
    }
  });
}
