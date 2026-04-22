import type { Precision, QuantConfig, QuantTargetConfig, RouteTarget } from "./types.js";
import { PRECISIONS } from "./types.js";
import { resolveDefaultBaseUrl } from "./utils.js";

export const SYNTHETIC_PROVIDER_IDS: Record<Precision, string> = {
  "4bit": "quantclaw-4bit",
  "8bit": "quantclaw-8bit",
  "16bit": "quantclaw-16bit",
};

export const quantClawSyntheticProviders = PRECISIONS.map((precision) => ({
  id: SYNTHETIC_PROVIDER_IDS[precision],
  label: `QuantClaw ${precision}`,
  aliases: [] as string[],
  envVars: [] as string[],
  auth: [] as never[],
}));

export type ResolvedRouteTarget = {
  precision: Precision;
  target: RouteTarget;
  providerOverride: string;
  modelOverride: string;
  fallbackPath: Precision[];
};

type HostProviderConfig = {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: unknown;
};

function getProviders(hostConfig: Record<string, unknown>): Record<string, HostProviderConfig> {
  return ((hostConfig.models as { providers?: Record<string, HostProviderConfig> } | undefined)?.providers ?? {});
}

function getFallbackOrder(preferred: Precision): Precision[] {
  switch (preferred) {
    case "4bit":
      return ["4bit", "8bit", "16bit"];
    case "8bit":
      return ["8bit", "16bit"];
    case "16bit":
    default:
      return ["16bit"];
  }
}

function cloneModelDefinition(modelId: string, sourceModels: unknown): Record<string, unknown> {
  if (Array.isArray(sourceModels)) {
    const match = sourceModels.find((entry) => (entry as Record<string, unknown>).id === modelId) as Record<string, unknown> | undefined;
    if (match) return { ...match };
    const first = sourceModels[0] as Record<string, unknown> | undefined;
    return {
      id: modelId,
      name: modelId,
      ...(first?.contextWindow != null ? { contextWindow: first.contextWindow } : {}),
      ...(first?.maxTokens != null ? { maxTokens: first.maxTokens } : {}),
      ...(first?.reasoning != null ? { reasoning: first.reasoning } : {}),
    };
  }

  if (sourceModels && typeof sourceModels === "object") {
    const entry = (sourceModels as Record<string, unknown>)[modelId];
    if (entry && typeof entry === "object") {
      return { id: modelId, ...(entry as Record<string, unknown>) };
    }
  }

  return { id: modelId, name: modelId };
}

function resolveProviderSettings(target: QuantTargetConfig, hostConfig: Record<string, unknown>) {
  const hostProvider = getProviders(hostConfig)[target.provider];
  const api = target.api ?? hostProvider?.api ?? "openai-completions";
  const baseUrl = target.endpoint ?? hostProvider?.baseUrl ?? resolveDefaultBaseUrl(target.provider, api);
  const apiKey = target.apiKey ?? hostProvider?.apiKey ?? "";
  return { baseUrl, api, apiKey, hostProvider };
}

export function getSyntheticProviderId(precision: Precision): string {
  return SYNTHETIC_PROVIDER_IDS[precision];
}

export function resolvePrecisionFromProvider(provider: string | undefined): Precision | undefined {
  if (!provider) return undefined;
  if (provider === SYNTHETIC_PROVIDER_IDS["4bit"]) return "4bit";
  if (provider === SYNTHETIC_PROVIDER_IDS["8bit"]) return "8bit";
  if (provider === SYNTHETIC_PROVIDER_IDS["16bit"]) return "16bit";
  return undefined;
}

export function installSyntheticProviders(
  hostConfig: Record<string, unknown>,
  quantConfig: Required<QuantConfig>,
): void {
  if (!hostConfig.models) {
    (hostConfig as Record<string, unknown>).models = { providers: {} };
  }
  const models = hostConfig.models as { providers?: Record<string, HostProviderConfig & { models?: unknown }> };
  if (!models.providers) models.providers = {};

  for (const precision of PRECISIONS) {
    const target = quantConfig.targets[precision];
    const { baseUrl, api, apiKey, hostProvider } = resolveProviderSettings(target, hostConfig);
    models.providers[SYNTHETIC_PROVIDER_IDS[precision]] = {
      baseUrl,
      api,
      apiKey,
      models: [cloneModelDefinition(target.model, hostProvider?.models)],
    };
  }
}

export function resolveRouteTarget(
  hostConfig: Record<string, unknown>,
  quantConfig: Required<QuantConfig>,
  preferredPrecision: Precision,
): ResolvedRouteTarget | null {
  const order = getFallbackOrder(preferredPrecision);

  for (let index = 0; index < order.length; index += 1) {
    const precision = order[index];
    const target = quantConfig.targets[precision];
    if (!target?.provider || !target?.model) continue;

    const { baseUrl } = resolveProviderSettings(target, hostConfig);
    if (!baseUrl) continue;

    return {
      precision,
      target: {
        provider: target.provider,
        model: target.model,
        displayName: target.displayName,
      },
      providerOverride: SYNTHETIC_PROVIDER_IDS[precision],
      modelOverride: target.model,
      fallbackPath: order.slice(0, index + 1),
    };
  }

  return null;
}

export function getTargetPricing(
  quantConfig: Required<QuantConfig>,
  precision: Precision | undefined,
  model: string,
): { inputPer1M: number; outputPer1M: number } {
  if (precision) {
    const direct = quantConfig.targets[precision]?.pricing;
    if (direct && (direct.inputPer1M != null || direct.outputPer1M != null)) {
      return {
        inputPer1M: direct.inputPer1M ?? 0,
        outputPer1M: direct.outputPer1M ?? 0,
      };
    }
  }

  const pricing = quantConfig.modelPricing ?? {};
  if (pricing[model]) {
    return {
      inputPer1M: pricing[model].inputPer1M ?? 0,
      outputPer1M: pricing[model].outputPer1M ?? 0,
    };
  }

  const lowerModel = model.toLowerCase();
  for (const [key, value] of Object.entries(pricing)) {
    if (lowerModel.includes(key.toLowerCase())) {
      return {
        inputPer1M: value.inputPer1M ?? 0,
        outputPer1M: value.outputPer1M ?? 0,
      };
    }
  }

  return { inputPer1M: 0, outputPer1M: 0 };
}
