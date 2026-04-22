import type { IncomingMessage, ServerResponse } from "node:http";
import { saveQuantClawConfig } from "./dashboard-config-io.js";
import { getLiveConfig, updateLiveConfig } from "./live-config.js";
import { readPromptFromDisk, writePrompt } from "./prompt-loader.js";
import { generateJudgePrompt } from "./routers/quant.js";
import type { RouterPipeline } from "./router-pipeline.js";
import {
  clearAllSessionStates,
  getAllSessionStates,
  getLastInputEstimate,
  getSessionState,
  onDetection,
} from "./session-state.js";
import { getGlobalCollector, onTokenUpdate } from "./token-stats.js";
import type { QuantConfig } from "./types.js";

export type DashboardDeps = {
  pluginId: string;
  pluginConfig: Record<string, unknown>;
  pipeline: RouterPipeline | null;
  hostConfig: Record<string, unknown>;
  refreshRuntimeProviders?: () => void;
};

let deps: DashboardDeps | null = null;
const MAX_BODY_BYTES = 1024 * 1024;

export function initDashboard(d: DashboardDeps): void {
  deps = d;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" });
  res.end(body);
}

function getPromptPayload() {
  const defaultContent = generateJudgePrompt(getLiveConfig().taskTypes);
  const disk = readPromptFromDisk("quant-router-judge");
  return {
    "quant-router-judge": {
      label: "Quant Router Judge",
      content: disk ?? defaultContent,
      isCustom: disk !== null,
      defaultContent,
    },
  };
}

export async function statsHttpHandler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? "";
  const reqPath = url.split("?")[0];
  const base = `/plugins/${deps?.pluginId ?? "quantclaw"}/stats`;
  if (!reqPath.startsWith(base)) return false;

  const sub = reqPath.slice(base.length) || "/";

  if (req.method === "GET" && sub === "/") {
    html(res, dashboardHtml());
    return true;
  }

  if (req.method === "GET" && sub === "/api/summary") {
    const collector = getGlobalCollector();
    if (!collector) {
      json(res, { error: "not initialized" }, 503);
      return true;
    }
    json(res, collector.getSummary());
    return true;
  }

  if (req.method === "GET" && sub === "/api/hourly") {
    const collector = getGlobalCollector();
    if (!collector) {
      json(res, { error: "not initialized" }, 503);
      return true;
    }
    json(res, collector.getHourly());
    return true;
  }

  if (req.method === "GET" && sub === "/api/sessions") {
    const collector = getGlobalCollector();
    if (!collector) {
      json(res, { error: "not initialized" }, 503);
      return true;
    }
    json(res, collector.getSessionStats());
    return true;
  }

  if (req.method === "POST" && sub === "/api/reset") {
    const collector = getGlobalCollector();
    if (!collector) {
      json(res, { error: "not initialized" }, 503);
      return true;
    }
    await collector.reset();
    clearAllSessionStates();
    json(res, { ok: true });
    return true;
  }

  if (req.method === "GET" && sub === "/api/detections") {
    const events = getAllSessionStates().flatMap((state) => state.detectionHistory);
    events.sort((a, b) => b.timestamp - a.timestamp);
    json(res, events.slice(0, 500));
    return true;
  }

  if (req.method === "GET" && sub === "/api/session-detections") {
    const params = new URL(url, "http://localhost").searchParams;
    const key = params.get("key") ?? "";
    json(res, getSessionState(key)?.detectionHistory ?? []);
    return true;
  }

  if (req.method === "GET" && sub === "/api/session-detections/stream") {
    const params = new URL(url, "http://localhost").searchParams;
    const key = params.get("key") ?? "";
    const loopId = params.get("loopId") ?? "";
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    (res as { flushHeaders?: () => void }).flushHeaders?.();

    const state = getSessionState(key);
    const history = state?.detectionHistory ?? [];
    const filtered = loopId ? history.filter((event) => event.loopId === loopId) : history;
    res.write(`event: snapshot\ndata: ${JSON.stringify(filtered)}\n\n`);
    const estimate = getLastInputEstimate(key);
    if (estimate && (!loopId || estimate.loopId === loopId)) {
      res.write(`event: input_estimate\ndata: ${JSON.stringify(estimate)}\n\n`);
    }

    const unsubDetection = onDetection((event) => {
      if (event.sessionKey !== key) return;
      if (loopId && event.loopId !== loopId) return;
      try {
        res.write(`event: ${event.phase ?? "complete"}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Ignore closed connection.
      }
    });

    const unsubToken = onTokenUpdate((event) => {
      if (event.sessionKey !== key) return;
      if (loopId && event.loopId !== loopId) return;
      try {
        res.write(`event: token_update\ndata: ${JSON.stringify(event.stats)}\n\n`);
      } catch {
        // Ignore closed connection.
      }
    });

    req.on("close", () => {
      unsubDetection();
      unsubToken();
    });
    return true;
  }

  if (req.method === "GET" && sub === "/api/activity-stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    (res as { flushHeaders?: () => void }).flushHeaders?.();
    res.write("event: ping\ndata: {}\n\n");

    const unsubDetection = onDetection((event) => {
      try {
        res.write(`event: activity\ndata: ${JSON.stringify({ sessionKey: event.sessionKey, loopId: event.loopId, phase: event.phase ?? "complete" })}\n\n`);
      } catch {
        // Ignore closed connection.
      }
    });

    const unsubToken = onTokenUpdate((event) => {
      try {
        res.write(`event: activity\ndata: ${JSON.stringify({ sessionKey: event.sessionKey, loopId: event.loopId, phase: "token_update" })}\n\n`);
      } catch {
        // Ignore closed connection.
      }
    });

    req.on("close", () => {
      unsubDetection();
      unsubToken();
    });
    return true;
  }

  if (req.method === "GET" && sub === "/api/config") {
    json(res, { quant: getLiveConfig() });
    return true;
  }

  if (req.method === "POST" && sub === "/api/config") {
    try {
      const body = JSON.parse(await readBody(req)) as { quant?: Partial<QuantConfig> };
      if (!body.quant) {
        json(res, { error: "quant config required" }, 400);
        return true;
      }
      updateLiveConfig(body.quant);
      saveQuantClawConfig(getLiveConfig() as unknown as Record<string, unknown>);
      if (deps) {
        deps.pluginConfig.quant = getLiveConfig();
        deps.refreshRuntimeProviders?.();
      }
      json(res, { ok: true, quant: getLiveConfig() });
    } catch (err) {
      json(res, { error: String(err) }, 400);
    }
    return true;
  }

  if (req.method === "GET" && sub === "/api/prompts") {
    json(res, getPromptPayload());
    return true;
  }

  if (req.method === "POST" && sub === "/api/prompts") {
    try {
      const body = JSON.parse(await readBody(req)) as { name: string; content: string };
      if (body.name !== "quant-router-judge" || typeof body.content !== "string") {
        json(res, { error: "invalid prompt payload" }, 400);
        return true;
      }
      writePrompt(body.name, body.content);
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: String(err) }, 400);
    }
    return true;
  }

  if (req.method === "POST" && sub === "/api/test-classify") {
    if (!deps?.pipeline) {
      json(res, { error: "pipeline not initialized" }, 503);
      return true;
    }
    try {
      const body = JSON.parse(await readBody(req)) as { message: string; router?: string };
      if (!body.message?.trim()) {
        json(res, { error: "message required" }, 400);
        return true;
      }
      const input = { checkpoint: "onUserMessage" as const, message: body.message, sessionKey: "__test__" };
      const config = { quant: getLiveConfig(), hostConfig: deps.hostConfig };
      const decision = body.router
        ? await deps.pipeline.runSingle(body.router, input, config)
        : await deps.pipeline.run("onUserMessage", input, config);
      if (!decision) {
        json(res, { error: "router not found" }, 404);
        return true;
      }
      json(res, {
        action: decision.action,
        taskTypeId: decision.taskTypeId,
        precision: decision.precision,
        target: decision.target,
        fallbackPath: decision.fallbackPath,
        reason: decision.reason,
        confidence: decision.confidence,
        routerId: decision.routerId,
      });
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
    return true;
  }

  return false;
}

function dashboardHtml(): string {
  const baseApi = `/plugins/${deps?.pluginId ?? "quantclaw"}/stats/api`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>⚡ QuantClaw Dashboard</title>
<style>
:root{
  --bg:#edf1f7;
  --panel:#ffffff;
  --panel-soft:#f8fafc;
  --border:#d5ddea;
  --text:#18202d;
  --muted:#627085;
  --shadow:0 18px 44px rgba(17,24,39,.08);
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{
  font-family:"IBM Plex Sans","Segoe UI",sans-serif;
  background:
    radial-gradient(circle at top left, rgba(59,130,246,.14), transparent 28%),
    radial-gradient(circle at bottom right, rgba(245,158,11,.12), transparent 24%),
    var(--bg);
  color:var(--text);
}
.app-shell{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh}
.sidebar{
  background:linear-gradient(180deg,#0f172a 0%,#16243b 100%);
  color:#e5eefc;
  padding:28px 22px;
  position:sticky;
  top:0;
  height:100vh;
  border-right:1px solid rgba(148,163,184,.18);
}
.brand{display:flex;align-items:flex-start;gap:14px;margin-bottom:24px}
.brand-mark{
  width:46px;height:46px;border-radius:14px;display:grid;place-items:center;
  background:linear-gradient(135deg,#f59e0b,#f97316);font-size:24px;
  box-shadow:0 12px 30px rgba(249,115,22,.28);
}
.brand h1{font-size:20px;margin:0 0 4px}
.brand p,.sidebar-note,.sidebar-status{margin:0;color:#b8c6db;font-size:13px;line-height:1.5}
.sidebar-status{margin:18px 0 20px;padding:12px 14px;border-radius:14px;background:rgba(15,23,42,.38);border:1px solid rgba(148,163,184,.16)}
.nav{display:grid;gap:10px;margin-top:14px}
.nav-btn{
  border:1px solid rgba(148,163,184,.18);
  background:rgba(30,41,59,.52);
  color:#e2e8f0;
  padding:12px 14px;
  text-align:left;
  border-radius:14px;
  font:inherit;
  cursor:pointer;
  transition:transform .14s ease, border-color .14s ease, background .14s ease;
}
.nav-btn:hover{transform:translateY(-1px);border-color:rgba(191,219,254,.45)}
.nav-btn.active{background:linear-gradient(135deg,rgba(59,130,246,.22),rgba(14,165,233,.14));border-color:rgba(147,197,253,.65)}
.nav-title{display:block;font-weight:700}
.nav-sub{display:block;font-size:12px;color:#b8c6db;margin-top:4px}
.sidebar-note{margin-top:22px}
.content{min-width:0}
.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:24px 28px 0}
.title-wrap h2{margin:0;font-size:28px}
.title-wrap p{margin:8px 0 0;color:var(--muted)}
.status-row{display:flex;gap:10px;flex-wrap:wrap}
.pill{
  display:inline-flex;align-items:center;gap:8px;
  padding:9px 12px;border-radius:999px;background:rgba(255,255,255,.76);
  border:1px solid rgba(148,163,184,.3);color:#334155;font-size:12px
}
.main{padding:24px 28px 32px}
.view{display:none}
.view.active{display:block}
.grid{display:grid;gap:18px}
.cards{grid-template-columns:repeat(4,minmax(0,1fr))}
.two{grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr)}
.three{grid-template-columns:repeat(3,minmax(0,1fr))}
.panel,.card{
  background:rgba(255,255,255,.92);
  border:1px solid rgba(213,221,234,.92);
  border-radius:22px;
  box-shadow:var(--shadow);
  backdrop-filter:blur(12px);
}
.panel{padding:20px}
.card{padding:18px}
.section-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}
.section-head h2,.section-head h3{margin:0}
.section-head p{margin:6px 0 0;color:var(--muted);font-size:13px}
.metric-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.metric-value{font-size:30px;font-weight:700;margin-top:10px}
.metric-sub{font-size:12px;color:var(--muted);margin-top:8px}
.card.precision-4{background:linear-gradient(180deg,rgba(16,185,129,.11),rgba(255,255,255,.96))}
.card.precision-8{background:linear-gradient(180deg,rgba(59,130,246,.12),rgba(255,255,255,.96))}
.card.precision-16{background:linear-gradient(180deg,rgba(245,158,11,.14),rgba(255,255,255,.96))}
.card.router{background:linear-gradient(180deg,rgba(15,23,42,.06),rgba(255,255,255,.96))}
.split-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.mini-stat{padding:14px;border-radius:16px;background:var(--panel-soft);border:1px solid var(--border)}
.mini-stat strong{display:block;font-size:16px}
.mini-stat span{display:block;margin-top:6px;font-size:12px;color:var(--muted)}
.table-wrap{overflow:auto}
table{width:100%;border-collapse:collapse}
th,td{padding:11px 12px;border-bottom:1px solid #e6ebf2;text-align:left;font-size:13px;vertical-align:top}
th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
tbody tr:hover{background:#f8fbff}
.session-row{cursor:pointer}
.session-row.selected{background:#e8f1ff}
.session-row.selected:hover{background:#dbeafe}
.session-detail{display:grid;gap:14px}
.detail-kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.detail-box{padding:14px;border-radius:16px;background:var(--panel-soft);border:1px solid var(--border)}
.detail-box strong{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:8px}
.detail-box span{display:block;font-size:14px;line-height:1.5}
.detail-box.user-message span{white-space:pre-wrap;word-break:break-word}
.detail-events{max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:16px;background:var(--panel-soft)}
.detail-event{padding:12px 14px;border-bottom:1px solid var(--border)}
.detail-event:last-child{border-bottom:none}
.detail-event-title{font-weight:700}
.detail-event-meta{display:block;color:var(--muted);font-size:12px;margin-top:4px}
.empty{padding:28px 10px;text-align:center;color:var(--muted)}
label{display:block;font-size:12px;color:var(--muted);margin:11px 0 7px;font-weight:700}
input,select,textarea{width:100%;padding:11px 12px;border:1px solid #cfd8e3;border-radius:14px;background:#fff;color:var(--text);font:inherit}
textarea{min-height:140px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:none;border-color:#60a5fa;box-shadow:0 0 0 4px rgba(96,165,250,.14)}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}
.btn{border:none;border-radius:14px;padding:11px 16px;font-weight:700;cursor:pointer;font:inherit;transition:transform .14s ease, box-shadow .14s ease, opacity .14s ease}
.btn:hover{transform:translateY(-1px)}
.btn-primary{background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;box-shadow:0 10px 24px rgba(37,99,235,.22)}
.btn-secondary{background:linear-gradient(135deg,#0f172a,#1e293b);color:#fff}
.btn-outline{background:#fff;border:1px solid #cfd8e3;color:#1f2937}
.badge{display:inline-flex;align-items:center;padding:4px 9px;border-radius:999px;font-size:11px;font-weight:700;background:#eff6ff;color:#1d4ed8}
.badge.precision-4{background:#ecfdf5;color:#047857}
.badge.precision-8{background:#eff6ff;color:#1d4ed8}
.badge.precision-16{background:#fff7ed;color:#c2410c}
.mono{font-family:"IBM Plex Mono","SFMono-Regular",monospace}
pre{margin:0;background:#0f172a;color:#dbeafe;border-radius:18px;padding:16px;overflow:auto;min-height:240px}
.sub{font-size:12px;color:var(--muted);margin-top:7px;line-height:1.5}
.target-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.target-card{padding:16px;border-radius:18px;background:var(--panel-soft);border:1px solid var(--border)}
.target-card h4{margin:0 0 8px}
.target-meta{display:grid;gap:8px;font-size:13px}
.target-meta div{display:flex;justify-content:space-between;gap:10px}
.target-meta span:first-child{color:var(--muted)}
.chart-shell{display:grid;grid-template-columns:1fr;gap:12px}
.hourly-bars{height:260px;padding:18px 12px 10px;border-radius:18px;background:linear-gradient(180deg,#f8fbff,#f3f7fd);border:1px solid var(--border);display:flex;align-items:flex-end;gap:10px;overflow-x:auto}
.hour-group{min-width:64px;display:grid;gap:8px}
.hour-stack{height:190px;border-radius:14px;background:#e8eef7;padding:6px;display:flex;flex-direction:column;justify-content:flex-end;gap:4px}
.hour-segment{border-radius:10px 10px 4px 4px;min-height:0}
.hour-segment.p4{background:linear-gradient(180deg,#10b981,#059669)}
.hour-segment.p8{background:linear-gradient(180deg,#60a5fa,#2563eb)}
.hour-segment.p16{background:linear-gradient(180deg,#fbbf24,#f97316)}
.hour-label{font-size:12px;color:var(--muted);text-align:center}
.legend{display:flex;gap:12px;flex-wrap:wrap}
.legend-item{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.legend-dot{width:10px;height:10px;border-radius:999px}
.activity-feed{display:grid;gap:10px;max-height:430px;overflow:auto}
.activity-item{border:1px solid var(--border);background:var(--panel-soft);border-radius:16px;padding:12px 14px}
.activity-item strong{display:block}
.activity-item small{display:block;color:var(--muted);margin-top:6px}
.config-panels{display:grid;gap:18px}
.status-banner{margin-bottom:18px;padding:12px 14px;border-radius:16px;border:1px solid rgba(96,165,250,.26);background:rgba(255,255,255,.86);color:#1e3a8a}
.status-banner.error{border-color:rgba(220,38,38,.25);color:#991b1b;background:rgba(254,242,242,.96)}
@media(max-width:1180px){
  .app-shell{grid-template-columns:1fr}
  .sidebar{position:relative;height:auto}
  .cards,.two,.three,.target-grid,.split-metrics,.detail-kv{grid-template-columns:1fr}
  .topbar,.main{padding-left:20px;padding-right:20px}
}
</style>
</head>
<body>
<div class="app-shell">
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-mark">⚡</div>
      <div>
        <h1>QuantClaw</h1>
        <p>Precision-aware routing for OpenClaw.</p>
      </div>
    </div>
    <div class="sidebar-status" id="sidebar-status">Loading runtime state...</div>
    <nav class="nav">
      <button class="nav-btn" data-view="overview" type="button">
        <span class="nav-title">Overview</span>
        <span class="nav-sub">Costs, precision mix, current targets</span>
      </button>
      <button class="nav-btn" data-view="activity" type="button">
        <span class="nav-title">Sessions</span>
        <span class="nav-sub">Routing logs, sessions, live activity</span>
      </button>
      <button class="nav-btn" data-view="config" type="button">
        <span class="nav-title">Config</span>
        <span class="nav-sub">Judge, task types, targets, pricing</span>
      </button>
      <button class="nav-btn" data-view="tools" type="button">
        <span class="nav-title">Prompts & Test</span>
        <span class="nav-sub">Judge prompt editor and dry-run classify</span>
      </button>
    </nav>
    <p class="sidebar-note">This dashboard is now self-contained. It no longer depends on external chart CDNs, so it renders correctly even in restricted environments.</p>
  </aside>
  <div class="content">
    <div class="topbar">
      <div class="title-wrap">
        <h2>⚡ QuantClaw Dashboard</h2>
        <p>Task classification, quantized routing, fallback telemetry, and cost tracking.</p>
      </div>
      <div class="status-row">
        <div class="pill" id="last-updated">Updated: loading...</div>
        <div class="pill" id="active-view-label">View: Overview</div>
      </div>
    </div>
    <main class="main">
      <div class="status-banner" id="status-banner">Loading dashboard data...</div>

      <section class="view" data-view="overview">
        <div class="grid cards">
          <div class="card precision-4"><div class="metric-label">4bit Cost</div><div class="metric-value" id="cost-4bit">$0.0000</div><div class="metric-sub" id="tokens-4bit">0 tokens</div></div>
          <div class="card precision-8"><div class="metric-label">8bit Cost</div><div class="metric-value" id="cost-8bit">$0.0000</div><div class="metric-sub" id="tokens-8bit">0 tokens</div></div>
          <div class="card precision-16"><div class="metric-label">16bit Cost</div><div class="metric-value" id="cost-16bit">$0.0000</div><div class="metric-sub" id="tokens-16bit">0 tokens</div></div>
          <div class="card router"><div class="metric-label">Router Overhead</div><div class="metric-value" id="cost-router">$0.0000</div><div class="metric-sub" id="router-requests">0 judge calls</div></div>
        </div>

        <div class="grid two" style="margin-top:18px">
          <section class="panel">
            <div class="section-head">
              <div>
                <h3>Hourly Cost</h3>
                <p>Stacked bars by precision tier, rendered without third-party chart scripts.</p>
              </div>
            </div>
            <div class="chart-shell">
              <div class="legend">
                <span class="legend-item"><span class="legend-dot" style="background:#10b981"></span>4bit</span>
                <span class="legend-item"><span class="legend-dot" style="background:#3b82f6"></span>8bit</span>
                <span class="legend-item"><span class="legend-dot" style="background:#f59e0b"></span>16bit</span>
              </div>
              <div class="hourly-bars" id="hourly-bars"></div>
            </div>
          </section>

          <section class="panel">
            <div class="section-head">
              <div>
                <h3>Routing Snapshot</h3>
                <p>Current detector chain, default task, and overall request mix.</p>
              </div>
            </div>
            <div class="split-metrics">
              <div class="mini-stat">
                <strong id="summary-total-cost">$0.0000</strong>
                <span>Total estimated cost</span>
              </div>
              <div class="mini-stat">
                <strong id="summary-total-requests">0</strong>
                <span>Total task requests</span>
              </div>
              <div class="mini-stat">
                <strong id="summary-router-share">0</strong>
                <span>Judge requests</span>
              </div>
            </div>
            <div style="margin-top:16px" id="config-overview"></div>
          </section>
        </div>

        <section class="panel" style="margin-top:18px">
          <div class="section-head">
            <div>
              <h3>Active Targets</h3>
              <p>Resolved precision buckets and the concrete provider/model targets they map to.</p>
            </div>
          </div>
          <div class="target-grid" id="target-cards"></div>
        </section>
      </section>

      <section class="view" data-view="activity">
        <div class="grid two">
          <section class="panel">
            <div class="section-head">
              <div>
                <h3>Sessions</h3>
                <p>Recent routed sessions with precision and target decisions. Click a row to inspect that loop.</p>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Preview</th><th>Task Type</th><th>Precision</th><th>Target</th><th>Cost</th><th>Last Active</th></tr></thead>
                <tbody id="sessions-body"></tbody>
              </table>
            </div>
          </section>
          <section class="panel">
            <div class="section-head">
              <div>
                <h3>Session Detail</h3>
                <p>Loop-level routing summary, fallback path, token split, and detection history.</p>
              </div>
            </div>
            <div id="session-detail" class="session-detail">
              <div class="empty">Click a session row to inspect this loop.</div>
            </div>
          </section>
        </div>

        <div class="grid two" style="margin-top:18px">
          <section class="panel">
            <div class="section-head">
              <div>
                <h3>Routing Log</h3>
                <p>Detector decisions, precision selection, and fallback outcomes.</p>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Time</th><th>Task Type</th><th>Precision</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead>
                <tbody id="detections-body"></tbody>
              </table>
            </div>
          </section>
          <section class="panel">
            <div class="section-head">
              <div>
                <h3>Live Activity</h3>
                <p>Streaming events from the dashboard SSE endpoint.</p>
              </div>
            </div>
            <div class="activity-feed" id="activity-feed"></div>
          </section>
        </div>
      </section>

      <section class="view" data-view="config">
        <form id="config-form" class="config-panels">
          <section class="panel">
            <div class="section-head">
              <div>
                <h3>Judge</h3>
                <p>Classification model and detector ordering.</p>
              </div>
            </div>
            <div class="grid three">
              <div><label><input type="checkbox" id="enabled"> QuantClaw Enabled</label></div>
              <div><label for="defaultTaskType">Default Task Type</label><input id="defaultTaskType"></div>
              <div><label for="judgeProviderType">Judge Provider Type</label><select id="judgeProviderType"><option value="openai-compatible">openai-compatible</option><option value="ollama-native">ollama-native</option><option value="custom">custom</option></select></div>
            </div>
            <div>
              <label for="detectors">Detectors</label>
              <input id="detectors" placeholder="ruleDetector, loadModelDetector">
              <div class="sub">Comma-separated order. Example: ruleDetector, loadModelDetector.</div>
            </div>
            <div class="grid three">
              <div><label for="judgeEndpoint">Judge Endpoint</label><input id="judgeEndpoint"></div>
              <div><label for="judgeModel">Judge Model</label><input id="judgeModel"></div>
              <div><label for="judgeApiKey">Judge API Key</label><input id="judgeApiKey"></div>
            </div>
            <div class="grid three">
              <div><label for="judgeCustomModule">Judge Custom Module</label><input id="judgeCustomModule"></div>
              <div><label for="judgeCacheTtlMs">Judge Cache TTL (ms)</label><input id="judgeCacheTtlMs" type="number"></div>
              <div></div>
            </div>
          </section>

          <section class="panel">
            <div class="section-head">
              <div>
                <h3>Task Types</h3>
                <p>User-defined routing labels. Optional <span class="mono">keywords</span> and <span class="mono">patterns</span> work with <span class="mono">ruleDetector</span>.</p>
              </div>
            </div>
            <label for="taskTypes">Task Types JSON</label>
            <textarea id="taskTypes"></textarea>
          </section>

          <section class="panel">
            <div class="section-head">
              <div>
                <h3>Precision Targets</h3>
                <p>Each precision bucket routes to a concrete provider/model target.</p>
              </div>
            </div>
            <div class="grid three">
              <div>
                <h3 style="margin-top:0">4bit Target</h3>
                <label>Provider</label><input id="target-4bit-provider">
                <label>Model</label><input id="target-4bit-model">
                <label>Endpoint</label><input id="target-4bit-endpoint">
                <label>API Type</label><input id="target-4bit-api">
                <label>API Key</label><input id="target-4bit-apiKey">
                <label>Custom Module</label><input id="target-4bit-customModule">
                <label>Display Name</label><input id="target-4bit-displayName">
                <label>Pricing Input / 1M</label><input id="target-4bit-inputPer1M" type="number" step="0.0001">
                <label>Pricing Output / 1M</label><input id="target-4bit-outputPer1M" type="number" step="0.0001">
              </div>
              <div>
                <h3 style="margin-top:0">8bit Target</h3>
                <label>Provider</label><input id="target-8bit-provider">
                <label>Model</label><input id="target-8bit-model">
                <label>Endpoint</label><input id="target-8bit-endpoint">
                <label>API Type</label><input id="target-8bit-api">
                <label>API Key</label><input id="target-8bit-apiKey">
                <label>Custom Module</label><input id="target-8bit-customModule">
                <label>Display Name</label><input id="target-8bit-displayName">
                <label>Pricing Input / 1M</label><input id="target-8bit-inputPer1M" type="number" step="0.0001">
                <label>Pricing Output / 1M</label><input id="target-8bit-outputPer1M" type="number" step="0.0001">
              </div>
              <div>
                <h3 style="margin-top:0">16bit Target</h3>
                <label>Provider</label><input id="target-16bit-provider">
                <label>Model</label><input id="target-16bit-model">
                <label>Endpoint</label><input id="target-16bit-endpoint">
                <label>API Type</label><input id="target-16bit-api">
                <label>API Key</label><input id="target-16bit-apiKey">
                <label>Custom Module</label><input id="target-16bit-customModule">
                <label>Display Name</label><input id="target-16bit-displayName">
                <label>Pricing Input / 1M</label><input id="target-16bit-inputPer1M" type="number" step="0.0001">
                <label>Pricing Output / 1M</label><input id="target-16bit-outputPer1M" type="number" step="0.0001">
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="section-head">
              <div>
                <h3>Pricing</h3>
                <p>Fallback model pricing when a target-level pricing override is absent.</p>
              </div>
            </div>
            <label for="modelPricing">Fallback Model Pricing JSON</label>
            <textarea id="modelPricing"></textarea>
            <div class="actions">
              <button class="btn btn-primary" type="submit">Save Config</button>
              <button class="btn btn-outline" type="button" id="reset-stats">Reset Stats</button>
            </div>
          </section>
        </form>
      </section>

      <section class="view" data-view="tools">
        <div class="grid two">
          <section class="panel">
            <div class="section-head">
              <div>
                <h3>Prompt Editor</h3>
                <p>Only the built-in <span class="mono">quant-router-judge</span> prompt is exposed.</p>
              </div>
            </div>
            <label for="judgePrompt">quant-router-judge</label>
            <textarea id="judgePrompt"></textarea>
            <div class="actions"><button class="btn btn-primary" id="save-prompt" type="button">Save Prompt</button></div>
          </section>
          <section class="panel">
            <div class="section-head">
              <div>
                <h3>Test Classification</h3>
                <p>Dry-run a message against the active detector chain and router.</p>
              </div>
            </div>
            <label for="testMessage">Message</label>
            <textarea id="testMessage">Summarize this changelog and rewrite a short release note.</textarea>
            <div class="actions"><button class="btn btn-secondary" id="run-test" type="button">Run Test</button></div>
            <pre id="testResult">Waiting for input.</pre>
          </section>
        </div>
      </section>
    </main>
  </div>
</div>
<script>
const BASE = ${JSON.stringify(baseApi)};
const state = {
  currentView: 'overview',
  activityEvents: [],
  activityStream: null,
  currentSessions: [],
  selectedSessionId: '',
  selectedSessionEvents: []
};
function money(v){ return '$' + Number(v || 0).toFixed(4); }
function num(v){ return Number(v || 0).toLocaleString(); }
function esc(v){ return String(v ?? '').replace(/[&<>\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
async function fetchJSON(path, options){
  const res = await fetch(BASE + path, options);
  const text = await res.text();
  if(!res.ok) throw new Error(text || ('HTTP ' + res.status));
  return text ? JSON.parse(text) : {};
}
function setText(id, value){ document.getElementById(id).textContent = value; }
function totalSessionCost(session){ return ['4bit','8bit','16bit'].reduce((sum, precision) => sum + ((((session.byPrecision || {})[precision] || {}).estimatedCost) || 0), 0); }
function sessionId(session){ return String(session.sessionKey || '') + '::' + String(session.loopId || ''); }
function fallbackPathText(fallbackPath){ return Array.isArray(fallbackPath) && fallbackPath.length ? fallbackPath.join(' -> ') : '-'; }
function selectedSession(){ return state.currentSessions.find((session) => sessionId(session) === state.selectedSessionId); }
async function loadSelectedSessionDetails(){
  const session = selectedSession();
  if (!session) {
    state.selectedSessionEvents = [];
    renderSelectedSessionDetail();
    return;
  }
  const requestId = sessionId(session);
  try {
    const events = await fetchJSON('/session-detections?key=' + encodeURIComponent(session.sessionKey));
    if (state.selectedSessionId !== requestId) return;
    state.selectedSessionEvents = (Array.isArray(events) ? events : []).filter((event) => !session.loopId || event.loopId === session.loopId);
    renderSelectedSessionDetail();
  } catch (err) {
    if (state.selectedSessionId !== requestId) return;
    state.selectedSessionEvents = [];
    renderSelectedSessionDetail(String(err));
  }
}
function renderSelectedSessionDetail(errorMessage){
  const container = document.getElementById('session-detail');
  const session = selectedSession();
  if (!session) {
    container.innerHTML = '<div class="empty">No session selected.</div>';
    return;
  }
  const events = state.selectedSessionEvents || [];
  const bySource = session.bySource || {};
  const routerCost = Number(((bySource.router || {}).estimatedCost) || 0);
  const taskCost = Number(((bySource.task || {}).estimatedCost) || 0);
  const messagePreview = session.userMessage || session.userMessagePreview || session.sessionKey || '-';
  const eventHtml = events.length
    ? events.slice().reverse().map((event) =>
        '<div class="detail-event">' +
          '<div class="detail-event-title">' + esc(event.action || event.phase || '-') + '</div>' +
          '<span class="detail-event-meta">' + esc(new Date(event.timestamp).toLocaleString()) + ' · ' + esc(event.target || event.taskTypeId || '-') + '</span>' +
          '<span>' + esc(event.reason || 'No extra reason recorded.') + '</span>' +
        '</div>'
      ).join('')
    : '<div class="empty">No routing events recorded for this loop.</div>';
  container.innerHTML =
    (errorMessage ? '<div class="status-banner error">' + esc(errorMessage) + '</div>' : '') +
    '<div class="detail-box user-message"><strong>User Message</strong><span>' + esc(messagePreview) + '</span></div>' +
    '<div class="detail-kv">' +
      '<div class="detail-box"><strong>Session Key</strong><span class="mono">' + esc(session.sessionKey || '-') + '</span></div>' +
      '<div class="detail-box"><strong>Loop Id</strong><span class="mono">' + esc(session.loopId || '-') + '</span></div>' +
      '<div class="detail-box"><strong>Task Type</strong><span class="mono">' + esc(session.taskTypeId || '-') + '</span></div>' +
      '<div class="detail-box"><strong>Precision</strong><span>' + esc(session.precision || '-') + '</span></div>' +
      '<div class="detail-box"><strong>Target Model</strong><span class="mono">' + esc(session.routedModel || '-') + '</span></div>' +
      '<div class="detail-box"><strong>Fallback Path</strong><span class="mono">' + esc(fallbackPathText(session.fallbackPath)) + '</span></div>' +
      '<div class="detail-box"><strong>Total Cost</strong><span>' + money(totalSessionCost(session)) + '</span></div>' +
      '<div class="detail-box"><strong>Router vs Task</strong><span>router ' + money(routerCost) + ' · task ' + money(taskCost) + '</span></div>' +
      '<div class="detail-box"><strong>Started</strong><span>' + esc(new Date(session.firstSeenAt).toLocaleString()) + '</span></div>' +
      '<div class="detail-box"><strong>Last Active</strong><span>' + esc(new Date(session.lastActiveAt).toLocaleString()) + '</span></div>' +
    '</div>' +
    '<div>' +
      '<div class="detail-box"><strong>Routing Events</strong><span>Events for the selected loop only.</span></div>' +
      '<div class="detail-events">' + eventHtml + '</div>' +
    '</div>';
}
function setBanner(message, isError){
  const el = document.getElementById('status-banner');
  el.textContent = message;
  el.classList.toggle('error', !!isError);
}
function normalizeView(view){ return ['overview','activity','config','tools'].includes(view) ? view : 'overview'; }
function setView(view){
  const resolved = normalizeView(view);
  state.currentView = resolved;
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('active', section.getAttribute('data-view') === resolved);
  });
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === resolved);
  });
  const labelMap = { overview: 'Overview', activity: 'Sessions', config: 'Config', tools: 'Prompts & Test' };
  setText('active-view-label', 'View: ' + (labelMap[resolved] || resolved));
  if (location.hash !== '#' + resolved) {
    history.replaceState(null, '', '#' + resolved);
  }
}
function connectActivityStream(){
  if (state.activityStream) state.activityStream.close();
  const stream = new EventSource(BASE + '/activity-stream');
  state.activityStream = stream;
  stream.addEventListener('activity', (event) => {
    try {
      const data = JSON.parse(event.data);
      state.activityEvents.unshift({
        sessionKey: data.sessionKey || '-',
        loopId: data.loopId || '-',
        phase: data.phase || '-',
        userMessagePreview: data.userMessagePreview || ''
      });
      state.activityEvents = state.activityEvents.slice(0, 30);
      renderActivityFeed();
    } catch (err) {
      console.error(err);
    }
  });
  stream.onerror = function(){
    setBanner('Dashboard loaded, but the live activity stream is temporarily unavailable. Telemetry polling still works.', false);
  };
}
function renderActivityFeed(){
  const feed = document.getElementById('activity-feed');
  if (!state.activityEvents.length) {
    feed.innerHTML = '<div class="empty">No live activity yet.</div>';
    return;
  }
  feed.innerHTML = state.activityEvents.map((event) =>
    '<div class="activity-item">' +
      '<strong>' + esc(event.phase) + '</strong>' +
      '<small>session: <span class="mono">' + esc(event.sessionKey) + '</span></small>' +
      '<small>loop: <span class="mono">' + esc(event.loopId) + '</span></small>' +
      (event.userMessagePreview ? '<small>' + esc(event.userMessagePreview) + '</small>' : '') +
    '</div>'
  ).join('');
}
function renderConfigOverview(quant){
  const detectors = Array.isArray(quant.detectors) && quant.detectors.length ? quant.detectors.join(' -> ') : 'loadModelDetector';
  const taskTypeCount = Array.isArray(quant.taskTypes) ? quant.taskTypes.length : 0;
  document.getElementById('config-overview').innerHTML =
    '<div class="mini-stat"><strong class="mono">' + esc(quant.defaultTaskType || '-') + '</strong><span>Default task type</span></div>' +
    '<div class="mini-stat" style="margin-top:12px"><strong class="mono">' + esc(detectors) + '</strong><span>Detector chain</span></div>' +
    '<div class="mini-stat" style="margin-top:12px"><strong>' + num(taskTypeCount) + '</strong><span>Configured task types</span></div>';
}
function renderTargetCards(quant){
  const cards = document.getElementById('target-cards');
  const targets = (quant && quant.targets) || {};
  cards.innerHTML = ['4bit', '8bit', '16bit'].map((precision) => {
    const target = targets[precision] || {};
    const title = target.displayName || target.model || '-';
    return '<div class="target-card">' +
      '<h4><span class="badge precision-' + esc(String(precision).replace('bit','')) + '">' + esc(precision) + '</span></h4>' +
      '<div class="target-meta">' +
        '<div><span>Name</span><span class="mono">' + esc(title) + '</span></div>' +
        '<div><span>Provider</span><span class="mono">' + esc(target.provider || '-') + '</span></div>' +
        '<div><span>Model</span><span class="mono">' + esc(target.model || '-') + '</span></div>' +
        '<div><span>Endpoint</span><span class="mono">' + esc(target.endpoint || 'inherit host provider') + '</span></div>' +
      '</div>' +
    '</div>';
  }).join('');
}
function renderSummary(summary){
  let totalCost = 0;
  let totalRequests = 0;
  ['4bit','8bit','16bit'].forEach((precision) => {
    const bucket = (summary.lifetime || {})[precision] || {};
    setText('cost-' + precision, money(bucket.estimatedCost));
    setText('tokens-' + precision, num(bucket.totalTokens) + ' tokens / ' + num(bucket.requestCount) + ' calls');
    totalCost += Number(bucket.estimatedCost || 0);
    totalRequests += Number(bucket.requestCount || 0);
  });
  const router = (summary.bySource || {}).router || {};
  setText('cost-router', money(router.estimatedCost));
  setText('router-requests', num(router.requestCount) + ' judge calls');
  setText('last-updated', 'Updated: ' + new Date(summary.lastUpdatedAt || Date.now()).toLocaleString());
  setText('summary-total-cost', money(totalCost + Number(router.estimatedCost || 0)));
  setText('summary-total-requests', num(totalRequests));
  setText('summary-router-share', num(router.requestCount || 0));
}
function renderHourly(hourly){
  const container = document.getElementById('hourly-bars');
  if (!Array.isArray(hourly) || !hourly.length) {
    container.innerHTML = '<div class="empty" style="width:100%">No hourly telemetry yet.</div>';
    return;
  }
  const totals = hourly.map((entry) => ['4bit','8bit','16bit'].reduce((sum, precision) => sum + Number((((entry.byPrecision || {})[precision] || {}).estimatedCost) || 0), 0));
  const maxTotal = Math.max.apply(null, totals.concat([0.0001]));
  container.innerHTML = hourly.map((entry, index) => {
    const cost4 = Number((((entry.byPrecision || {})['4bit'] || {}).estimatedCost) || 0);
    const cost8 = Number((((entry.byPrecision || {})['8bit'] || {}).estimatedCost) || 0);
    const cost16 = Number((((entry.byPrecision || {})['16bit'] || {}).estimatedCost) || 0);
    const total = totals[index];
    const safeTotal = total > 0 ? total : 0;
    const stackHeight = Math.max((safeTotal / maxTotal) * 100, safeTotal > 0 ? 8 : 0);
    const p4 = safeTotal > 0 ? (cost4 / safeTotal) * 100 : 0;
    const p8 = safeTotal > 0 ? (cost8 / safeTotal) * 100 : 0;
    const p16 = safeTotal > 0 ? (cost16 / safeTotal) * 100 : 0;
    return '<div class="hour-group">' +
      '<div class="hour-stack" title="' + esc(entry.hour + ' total ' + money(total)) + '">' +
        '<div style="height:' + stackHeight + '%;display:flex;flex-direction:column;justify-content:flex-end;gap:4px">' +
          '<div class="hour-segment p16" style="height:' + p16 + '%"></div>' +
          '<div class="hour-segment p8" style="height:' + p8 + '%"></div>' +
          '<div class="hour-segment p4" style="height:' + p4 + '%"></div>' +
        '</div>' +
      '</div>' +
      '<div class="hour-label">' + esc(entry.hour.slice(11, 13) + ':00') + '</div>' +
    '</div>';
  }).join('');
}
function renderSessions(sessions){
  state.currentSessions = Array.isArray(sessions) ? sessions : [];
  const body = document.getElementById('sessions-body');
  const ids = state.currentSessions.map((session) => sessionId(session));
  if (!ids.includes(state.selectedSessionId)) {
    state.selectedSessionId = ids[0] || '';
    state.selectedSessionEvents = [];
  }
  body.innerHTML = state.currentSessions.map((session) => {
    const id = sessionId(session);
    const selected = id === state.selectedSessionId ? ' selected' : '';
    return '<tr class="session-row' + selected + '" data-session-id="' + esc(id) + '">' +
      '<td><div>' + esc(session.userMessagePreview || session.userMessage || session.sessionKey) + '</div><div class="sub mono">' + esc(session.loopId || '-') + '</div></td>' +
      '<td class="mono">' + esc(session.taskTypeId || '-') + '</td>' +
      '<td><span class="badge precision-' + esc(String(session.precision || '-').replace('bit','')) + '">' + esc(session.precision || '-') + '</span></td>' +
      '<td class="mono">' + esc(session.routedModel || '-') + '</td>' +
      '<td>' + money(totalSessionCost(session)) + '</td>' +
      '<td>' + new Date(session.lastActiveAt).toLocaleString() + '</td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="6" class="empty">No sessions yet.</td></tr>';
  Array.from(body.querySelectorAll('.session-row')).forEach((row) => {
    row.addEventListener('click', async () => {
      const nextId = row.getAttribute('data-session-id') || '';
      if (!nextId || nextId === state.selectedSessionId) return;
      state.selectedSessionId = nextId;
      state.selectedSessionEvents = [];
      renderSessions(state.currentSessions);
      renderSelectedSessionDetail();
      await loadSelectedSessionDetails();
    });
  });
  renderSelectedSessionDetail();
}
function renderDetections(events){
  const body = document.getElementById('detections-body');
  body.innerHTML = events.map((event) => '<tr>' +
    '<td>' + new Date(event.timestamp).toLocaleTimeString() + '</td>' +
    '<td class="mono">' + esc(event.taskTypeId || '-') + '</td>' +
    '<td><span class="badge precision-' + esc(String(event.precision || '-').replace('bit','')) + '">' + esc(event.precision || '-') + '</span></td>' +
    '<td>' + esc(event.action || event.phase || '-') + '</td>' +
    '<td class="mono">' + esc(event.target || '-') + '</td>' +
    '<td>' + esc(event.reason || '-') + '</td>' +
    '</tr>').join('') || '<tr><td colspan="6" class="empty">No routing events yet.</td></tr>';
}
function setTarget(prefix, target){
  document.getElementById(prefix + '-provider').value = target.provider || '';
  document.getElementById(prefix + '-model').value = target.model || '';
  document.getElementById(prefix + '-endpoint').value = target.endpoint || '';
  document.getElementById(prefix + '-api').value = target.api || '';
  document.getElementById(prefix + '-apiKey').value = target.apiKey || '';
  document.getElementById(prefix + '-customModule').value = target.customModule || '';
  document.getElementById(prefix + '-displayName').value = target.displayName || '';
  document.getElementById(prefix + '-inputPer1M').value = target.pricing && target.pricing.inputPer1M != null ? target.pricing.inputPer1M : '';
  document.getElementById(prefix + '-outputPer1M').value = target.pricing && target.pricing.outputPer1M != null ? target.pricing.outputPer1M : '';
}
function readTarget(prefix){
  const inputPer1M = document.getElementById(prefix + '-inputPer1M').value;
  const outputPer1M = document.getElementById(prefix + '-outputPer1M').value;
  return {
    provider: document.getElementById(prefix + '-provider').value.trim(),
    model: document.getElementById(prefix + '-model').value.trim(),
    endpoint: document.getElementById(prefix + '-endpoint').value.trim(),
    api: document.getElementById(prefix + '-api').value.trim(),
    apiKey: document.getElementById(prefix + '-apiKey').value.trim(),
    customModule: document.getElementById(prefix + '-customModule').value.trim(),
    displayName: document.getElementById(prefix + '-displayName').value.trim(),
    pricing: {
      inputPer1M: inputPer1M === '' ? undefined : Number(inputPer1M),
      outputPer1M: outputPer1M === '' ? undefined : Number(outputPer1M)
    }
  };
}
function populateConfig(data){
  const quant = data.quant || {};
  document.getElementById('enabled').checked = !!quant.enabled;
  document.getElementById('defaultTaskType').value = quant.defaultTaskType || '';
  document.getElementById('detectors').value = (quant.detectors || []).join(', ');
  document.getElementById('judgeEndpoint').value = (quant.judge || {}).endpoint || '';
  document.getElementById('judgeModel').value = (quant.judge || {}).model || '';
  document.getElementById('judgeProviderType').value = (quant.judge || {}).providerType || 'openai-compatible';
  document.getElementById('judgeApiKey').value = (quant.judge || {}).apiKey || '';
  document.getElementById('judgeCustomModule').value = (quant.judge || {}).customModule || '';
  document.getElementById('judgeCacheTtlMs').value = (quant.judge || {}).cacheTtlMs || 300000;
  document.getElementById('taskTypes').value = JSON.stringify(quant.taskTypes || [], null, 2);
  document.getElementById('modelPricing').value = JSON.stringify(quant.modelPricing || {}, null, 2);
  setTarget('target-4bit', (quant.targets || {})['4bit'] || {});
  setTarget('target-8bit', (quant.targets || {})['8bit'] || {});
  setTarget('target-16bit', (quant.targets || {})['16bit'] || {});
  renderConfigOverview(quant);
  renderTargetCards(quant);
  document.getElementById('sidebar-status').textContent =
    (quant.enabled ? 'Routing enabled' : 'Routing disabled') +
    ' · default=' + (quant.defaultTaskType || '-') +
    ' · detectors=' + ((quant.detectors || []).join(' -> ') || 'loadModelDetector');
}
function collectConfig(){
  return {
    enabled: document.getElementById('enabled').checked,
    detectors: document.getElementById('detectors').value.split(',').map((value) => value.trim()).filter(Boolean),
    defaultTaskType: document.getElementById('defaultTaskType').value.trim(),
    fallbackPolicy: 'escalate',
    judge: {
      endpoint: document.getElementById('judgeEndpoint').value.trim(),
      model: document.getElementById('judgeModel').value.trim(),
      providerType: document.getElementById('judgeProviderType').value,
      apiKey: document.getElementById('judgeApiKey').value.trim(),
      customModule: document.getElementById('judgeCustomModule').value.trim(),
      cacheTtlMs: Number(document.getElementById('judgeCacheTtlMs').value || 300000)
    },
    taskTypes: JSON.parse(document.getElementById('taskTypes').value || '[]'),
    targets: {
      '4bit': readTarget('target-4bit'),
      '8bit': readTarget('target-8bit'),
      '16bit': readTarget('target-16bit')
    },
    modelPricing: JSON.parse(document.getElementById('modelPricing').value || '{}')
  };
}
async function loadPrompts(){
  const prompts = await fetchJSON('/prompts');
  document.getElementById('judgePrompt').value = prompts['quant-router-judge'].content;
}
async function loadTelemetry(){
  const [summary, hourly, sessions, detections] = await Promise.all([
    fetchJSON('/summary'),
    fetchJSON('/hourly'),
    fetchJSON('/sessions'),
    fetchJSON('/detections')
  ]);
  renderSummary(summary);
  renderHourly(hourly);
  renderSessions(sessions);
  await loadSelectedSessionDetails();
  renderDetections(detections);
}
async function loadConfig(){ populateConfig(await fetchJSON('/config')); }
async function loadAll(){ await Promise.all([loadTelemetry(), loadConfig(), loadPrompts()]); }
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', function(){ setView(btn.getAttribute('data-view') || 'overview'); });
});
window.addEventListener('hashchange', function(){ setView((location.hash || '#overview').slice(1)); });
document.getElementById('config-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await fetchJSON('/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ quant: collectConfig() }) });
    await loadAll();
    setBanner('Configuration saved.', false);
    setView('config');
  } catch (err) {
    setBanner(String(err), true);
  }
});
document.getElementById('save-prompt').addEventListener('click', async () => {
  try {
    await fetchJSON('/prompts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name:'quant-router-judge', content: document.getElementById('judgePrompt').value }) });
    setBanner('Prompt saved.', false);
    setView('tools');
  } catch (err) {
    setBanner(String(err), true);
  }
});
document.getElementById('run-test').addEventListener('click', async () => {
  try {
    const result = await fetchJSON('/test-classify', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message: document.getElementById('testMessage').value }) });
    document.getElementById('testResult').textContent = JSON.stringify(result, null, 2);
    setBanner('Classification test completed.', false);
  } catch (err) {
    document.getElementById('testResult').textContent = String(err);
    setBanner(String(err), true);
  }
});
document.getElementById('reset-stats').addEventListener('click', async () => {
  if (!confirm('Reset QuantClaw stats and routing logs?')) return;
  await fetchJSON('/reset', { method:'POST' });
  await loadTelemetry();
  setBanner('Telemetry reset.', false);
});
(async function boot(){
  setView((location.hash || '#overview').slice(1));
  renderActivityFeed();
  connectActivityStream();
  try {
    await loadAll();
    setBanner('Dashboard loaded successfully.', false);
  } catch (err) {
    console.error(err);
    setBanner('Dashboard load failed: ' + String(err), true);
  }
  setInterval(async function(){
    try {
      await loadTelemetry();
    } catch (err) {
      console.error(err);
    }
  }, 5000);
})();
</script>
</body>
</html>`;
}
