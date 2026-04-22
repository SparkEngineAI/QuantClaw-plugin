import { readFileSync, watch, type FSWatcher } from "node:fs";
import type { Precision, QuantConfig, QuantDetector, QuantTargetConfig } from "./types.js";
import { defaultQuantConfig, defaultTaskTypes, defaultTargets } from "./config-schema.js";

let liveConfig: Required<QuantConfig> = mergeConfig({});
let configWatcher: FSWatcher | null = null;

function mergeTarget(precision: Precision, target?: QuantTargetConfig): QuantTargetConfig {
  return {
    ...defaultTargets[precision],
    ...(target ?? {}),
    pricing: {
      ...(defaultTargets[precision].pricing ?? {}),
      ...(target?.pricing ?? {}),
    },
  };
}

function normalizeTaskTypes(taskTypes?: QuantConfig["taskTypes"]) {
  return Array.isArray(taskTypes) && taskTypes.length > 0 ? taskTypes : defaultTaskTypes;
}

function normalizeDetectors(detectors?: QuantConfig["detectors"]): QuantDetector[] {
  const valid = (detectors ?? []).filter(
    (detector): detector is QuantDetector => detector === "ruleDetector" || detector === "loadModelDetector",
  );
  return valid.length > 0 ? valid : defaultQuantConfig.detectors;
}

export function mergeConfig(userConfig: QuantConfig): Required<QuantConfig> {
  return {
    enabled: userConfig.enabled ?? defaultQuantConfig.enabled,
    detectors: normalizeDetectors(userConfig.detectors),
    judge: {
      ...defaultQuantConfig.judge,
      ...(userConfig.judge ?? {}),
    },
    taskTypes: normalizeTaskTypes(userConfig.taskTypes),
    defaultTaskType: userConfig.defaultTaskType ?? defaultQuantConfig.defaultTaskType,
    targets: {
      "4bit": mergeTarget("4bit", userConfig.targets?.["4bit"]),
      "8bit": mergeTarget("8bit", userConfig.targets?.["8bit"]),
      "16bit": mergeTarget("16bit", userConfig.targets?.["16bit"]),
    },
    fallbackPolicy: "escalate",
    modelPricing: {
      ...defaultQuantConfig.modelPricing,
      ...(userConfig.modelPricing ?? {}),
    },
  };
}

export function initLiveConfig(pluginConfig: Record<string, unknown> | undefined): void {
  const userConfig = (pluginConfig?.quant ?? {}) as QuantConfig;
  liveConfig = mergeConfig(userConfig);
}

export function watchConfigFile(
  configPath: string,
  logger: { info: (msg: string) => void },
): void {
  if (configWatcher) return;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  try {
    configWatcher = watch(configPath, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
          liveConfig = mergeConfig((raw.quant ?? {}) as QuantConfig);
          logger.info("[QuantClaw] quantclaw.json changed - config hot-reloaded");
        } catch {
          // Ignore partial writes.
        }
      }, 300);
    });
    // Don't block process exit for one-shot commands like `agents add`
    configWatcher.unref();
  } catch {
    // File may not exist yet.
  }
}

export function getLiveConfig(): Required<QuantConfig> {
  return liveConfig;
}

export function updateLiveConfig(patch: Partial<QuantConfig>): void {
  liveConfig = mergeConfig({ ...liveConfig, ...patch });
}
