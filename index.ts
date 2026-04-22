import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { defaultQuantConfig, quantClawConfigSchema } from "./src/config-schema.js";
import { initDashboard, statsHttpHandler } from "./src/stats-dashboard.js";
import { QUANTCLAW_CONFIG_PATH } from "./src/dashboard-config-io.js";
import { registerHooks } from "./src/hooks.js";
import { getLiveConfig, initLiveConfig, mergeConfig, watchConfigFile } from "./src/live-config.js";
import { installSyntheticProviders, quantClawSyntheticProviders } from "./src/provider.js";
import { RouterPipeline, setGlobalPipeline } from "./src/router-pipeline.js";
import { quantRouter } from "./src/routers/quant.js";
import { setGlobalCollector, TokenStatsCollector } from "./src/token-stats.js";
import type { QuantConfig } from "./src/types.js";

const OPENCLAW_DIR = join(process.env.HOME ?? "/tmp", ".openclaw");
const QUANTCLAW_STATS_PATH = join(OPENCLAW_DIR, "quantclaw-stats.json");

function loadQuantClawConfigFile(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(QUANTCLAW_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeQuantClawConfigFile(config: Record<string, unknown>): void {
  try {
    mkdirSync(OPENCLAW_DIR, { recursive: true });
    writeFileSync(QUANTCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch {
    // Best effort.
  }
}

function applySyntheticProviders(api: OpenClawPluginApi): void {
  const liveConfig = getLiveConfig();
  installSyntheticProviders(api.config as Record<string, unknown>, liveConfig);
  try {
    const runtimeConfig = api.runtime.config.loadConfig() as Record<string, unknown>;
    if (runtimeConfig && runtimeConfig !== api.config) {
      installSyntheticProviders(runtimeConfig, liveConfig);
    }
  } catch {
    // Best effort runtime sync.
  }
}

export default definePluginEntry({
  id: "quantclaw",
  name: "QuantClaw",
  description: "Task-type based quantization router that balances accuracy and cost across 4bit, 8bit, and 16bit model targets.",
  configSchema: quantClawConfigSchema,

  register(api: OpenClawPluginApi) {
    let resolvedPluginConfig: Record<string, unknown>;
    const fileConfig = loadQuantClawConfigFile();
    if (fileConfig) {
      resolvedPluginConfig = fileConfig;
      api.logger.info("[QuantClaw] Config loaded from quantclaw.json");
    } else {
      const userQuant = ((api.pluginConfig ?? {}) as Record<string, unknown>).quant as QuantConfig | undefined;
      resolvedPluginConfig = { quant: mergeConfig(userQuant ?? defaultQuantConfig) };
      writeQuantClawConfigFile(resolvedPluginConfig);
      api.logger.info("[QuantClaw] Generated quantclaw.json with full defaults");
    }

    initLiveConfig(resolvedPluginConfig);
    resolvedPluginConfig = { quant: getLiveConfig() };

    for (const provider of quantClawSyntheticProviders) {
      api.registerProvider(provider as Parameters<typeof api.registerProvider>[0]);
    }
    applySyntheticProviders(api);

    const pipeline = new RouterPipeline(api.logger);
    pipeline.register(quantRouter, { enabled: true, type: "builtin", weight: 100 });
    pipeline.configure({
      routers: { "quant-router": { enabled: true, type: "builtin", weight: 100 } },
      pipeline: { onUserMessage: ["quant-router"] },
    });
    setGlobalPipeline(pipeline);

    watchConfigFile(QUANTCLAW_CONFIG_PATH, api.logger);

    const collector = new TokenStatsCollector(QUANTCLAW_STATS_PATH);
    setGlobalCollector(collector);
    collector.load().then(() => {
      collector.startAutoFlush();
      api.logger.info(`[QuantClaw] Token stats initialized (${QUANTCLAW_STATS_PATH})`);
    }).catch((err) => {
      api.logger.error(`[QuantClaw] Failed to load token stats: ${String(err)}`);
    });

    initDashboard({
      pluginId: "quantclaw",
      pluginConfig: resolvedPluginConfig,
      pipeline,
      hostConfig: api.config as Record<string, unknown>,
      refreshRuntimeProviders: () => applySyntheticProviders(api),
    });

    api.registerHttpRoute({
      path: "/plugins/quantclaw/stats",
      auth: "plugin",
      match: "prefix",
      handler: async (req, res) => {
        const handled = await statsHttpHandler(req, res);
        if (!handled) {
          res.writeHead(404);
          res.end("Not Found");
        }
      },
    });

    registerHooks(api);

    api.logger.info("[QuantClaw] Dashboard registered at /plugins/quantclaw/stats");
    api.logger.info("[QuantClaw] Plugin initialized (quant router + synthetic providers + dashboard)");

    const c = "\x1b[36m";
    const g = "\x1b[32m";
    const y = "\x1b[33m";
    const b = "\x1b[1m";
    const d = "\x1b[2m";
    const r = "\x1b[0m";
    const bg = "\x1b[46m\x1b[30m";
    const W = 70;
    const bar = "═".repeat(W);
    const pad = (colored: string, visLen: number) => {
      const sp = " ".repeat(Math.max(0, W - visLen));
      return c + "  ║" + r + colored + sp + c + "║" + r;
    };

    api.logger.info("");
    api.logger.info(c + "  ╔" + bar + "╗" + r);
    api.logger.info(pad("  " + bg + b + " ⚡ QuantClaw " + r + g + b + "  Ready!" + r, 24));
    api.logger.info(pad("", 0));
    api.logger.info(pad("  " + y + "Dashboard" + r + " " + d + "→" + r + "  " + b + "http://127.0.0.1:18789/plugins/quantclaw/stats" + r, 61));
    api.logger.info(pad("  " + y + "Config" + r + "    " + d + "→" + r + "  " + b + "~/.openclaw/quantclaw.json" + r, 37));
    api.logger.info(pad("", 0));
    api.logger.info(pad("  " + d + "Use the Dashboard to configure judge, task types, and quant targets." + r, 69));
    api.logger.info(c + "  ╚" + bar + "╝" + r);
    api.logger.info("");
  },
});
