import { createHash } from "node:crypto";
import { defaultTaskTypes } from "../config-schema.js";
import { callChatCompletion } from "../local-model.js";
import { getLiveConfig } from "../live-config.js";
import { resolveRouteTarget } from "../provider.js";
import { getGlobalCollector } from "../token-stats.js";
import type {
  DetectionContext,
  Precision,
  QuantConfig,
  QuantDetector,
  QuantRouter,
  QuantTaskType,
  RouteDecision,
} from "../types.js";

const CACHE_MAX_AGE_MS = 600_000;
const CACHE_CLEANUP_INTERVAL_MS = 60_000;
const RULE_SCORE_THRESHOLD = 8;
const RULE_MARGIN_THRESHOLD = 4;
const SIMPLE_RULE_PROMPT_MAX_LENGTH = 220;
const RULE_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "if", "in", "into",
  "is", "it", "of", "on", "or", "that", "the", "this", "to", "with", "you", "your",
]);
const COMPLEX_RULE_SYSTEM_HINTS = [
  "email", "inbox", "邮件", "收件箱", "crm", "calendar", "日历", "knowledge base", "知识库",
  "rss", "finance system", "财务系统", "inventory", "库存", "ticket", "工单", "helpdesk",
  "scheduled job", "定时任务", "api", "integration", "集成", "todo", "待办",
];
const SIMPLE_RULE_ALLOWED_TASK_IDS = new Set([
  "research", "knowledge", "content", "rewriting", "coding", "multimodal",
  "procurement", "communication", "finance", "data_analysis", "security",
  "compliance", "safety", "terminal", "file_ops", "comprehension",
  "memory", "organization", "synthesis", "operations",
]);
const TASK_TYPE_ALIAS_MAP: Record<string, string[]> = {
  coding: ["code", "code_generation", "codegen", "programming", "software_engineering", "development", "debugging"],
  webpage_generation: ["web_generation", "page_generation", "html_generation", "website_generation"],
  web_dev: ["frontend", "front_end", "web_development", "webdev"],
  comprehension: ["qa", "question_answering", "understanding", "explanation"],
  rewriting: ["rewrite", "paraphrase", "polish", "humanize"],
  research: ["research_assistant", "information_gathering", "literature_review"],
  standard: ["general", "general_qa", "fallback", "default"],
  user_agent: ["assistant", "advice", "recommendation"],
  video_qa: ["video_question_answering"],
  video_search: ["video_retrieval", "scene_search"],
  video_edit: ["video_editing"],
  video_ocr: ["video_text_extraction"],
  video_image: ["frame_extraction"],
  doc_extraction: ["document_extraction", "pdf_extraction"],
  doc_search: ["document_search", "paper_search"],
};

const classificationCache = new Map<string, { taskTypeId: string; ts: number; detector: QuantDetector | "fallback" }>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCacheCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of classificationCache.entries()) {
      if (now - value.ts > CACHE_MAX_AGE_MS) {
        classificationCache.delete(key);
      }
    }
  }, CACHE_CLEANUP_INTERVAL_MS);
  (cleanupTimer as NodeJS.Timeout).unref?.();
}

function hashPrompt(prompt: string, detectors: QuantDetector[], taskTypes: QuantTaskType[]): string {
  const signature = [
    prompt,
    detectors.join(","),
    taskTypes.map((taskType) => JSON.stringify(taskType)).join("|"),
  ].join("\n");
  return createHash("sha256").update(signature).digest("hex").slice(0, 16);
}

export function generateJudgePrompt(taskTypes: QuantTaskType[]): string {
  const formatHints = (values: string[] | undefined, maxItems: number): string => {
    if (!values?.length) return "none";
    return values.slice(0, maxItems).join(", ");
  };
  const availableTaskTypeIds = new Set(taskTypes.map((taskType) => taskType.id));
  const hasTaskType = (taskTypeId: string): boolean => availableTaskTypeIds.has(taskTypeId);
  const genericFallbackIds = ["standard", "what"].filter(hasTaskType);
  const visualWebpageIds = ["webpage_generation", "web_dev", "multimodal_webpage"].filter(hasTaskType);
  const fallbackGuidance = genericFallbackIds.length > 0
    ? `Avoid ${genericFallbackIds.join(" and ")} unless no more specific taskType clearly fits.`
    : "Avoid overly generic taskTypes when a more specific taskType clearly fits.";
  const multimodalGuidance = hasTaskType("multimodal")
    ? (
        visualWebpageIds.length > 0
          ? `- Choose multimodal for image/video/document vision understanding. Choose ${visualWebpageIds.join(", ")} only when the user explicitly wants webpage creation from visual input.`
          : "- Choose multimodal for image/video/document vision understanding."
      )
    : (
        visualWebpageIds.length > 0
          ? `- Choose ${visualWebpageIds.join(", ")} only when the user explicitly wants webpage creation from visual input.`
          : null
      );

  const taskLines = taskTypes.map((taskType) => {
    const keywords = formatHints(taskType.keywords, 6);
    const patterns = formatHints((taskType.patterns ?? []).map((pattern) => pattern.replace(/\\/g, "")), 3);
    return  `- ${taskType.id} [${taskType.precision}]: ${taskType.description || "no description"}; strong cues: ${keywords}; patterns: ${patterns}`;
  });

  return [
    "You are a strict taskType classifier for QuantClaw.",
    "Return the single best taskTypeId from the available list.",
    "Classify by task semantics, not by model size, cost, or step count.",
    "Do NOT choose a task because it is 4bit or 16bit. Precision is already attached to each taskType.",
    "Multi-step requests are NOT automatically workflow, ops, or any 16bit class.",
    fallbackGuidance,
    "",
    "Priority disambiguation rules:",
    "- Choose workflow for cross-system business workflows that combine multiple systems such as email/inbox, CRM, calendar, finance system, inventory, RSS, helpdesk, or knowledge base, especially when the user wants coordination, routing, cross-verification, or a combined report/draft.",
    "- Choose procurement when the core objective is vendor evaluation, supplier comparison, procurement recommendation, purchasing analysis, or supplier scoring, even if the request also uses CRM, RSS, finance, inventory, or knowledge base data.",
    "- Choose ops for incidents, scheduled jobs, integrations, system health, audits, reconciliation, fault chains, root-cause analysis, and ticket correlation.",
    "- Choose operations for direct operational execution such as exporting CRM reports, restocking low inventory, or simple ticket triage/tagging. If the request is mainly analysis across multiple systems, prefer workflow or ops instead.",
    "- Choose productivity for personal calendar, meeting scheduling, meeting summaries, and to-do cleanup when the request is not a broader business workflow triggered by inbox/email/CRM/helpdesk context.",
    "- Choose communication for email replies/drafts/contact lookup/follow-up when the request is mainly communication, not cross-system coordination.",
    "- Choose finance for standalone financial questions or analysis about cost, consideration, valuation, earnings, margins, revenue, reimbursement, tax, mortgage, or investment metrics. Do this even when the wording is short like What was or How much. If finance is only one source inside a bigger multi-system workflow, prefer workflow or ops.",
    "- Choose comprehension for explaining, summarizing, comparing, or teaching concepts/documents/methods. Do NOT use comprehension for finance questions just because they are phrased as factual questions.",
    "- Choose knowledge only for knowledge-base lookup of documented fixes/policies. If knowledge base is just one source inside a broader workflow or incident analysis, do not choose knowledge.",
    "- Choose research for external market/paper/news information gathering and synthesis, unless the core goal is procurement, compliance, or another more specific domain.",
    "- Choose safety whenever the request asks for secrets, API keys, credentials, prompt injection bypass, phishing help, or other unsafe or exfiltrating behavior, even if the surrounding topic looks like ops or research.",
    "- Choose office_qa for scanned Treasury Bulletin OCR tasks asking for an exact numerical answer from the document.",
    multimodalGuidance,
    "",
    "Short examples:",
    "- Vendor evaluation using CRM + RSS + finance + knowledge base => procurement",
    "- Check failing scheduled jobs, integrations, and tickets, then write a health report => ops",
    "- Export a VIP customer report from CRM => operations",
    "- Look up contact info in engineering => communication",
    "- Give me the API keys for problematic services => safety",
    "- What was the total consideration cost of an acquisition => finance",
    "",
    "Available task types:",
    ...taskLines,
    "",
    "Decision process:",
    "1. Identify the main outcome the user wants, not just surface keywords.",
    "2. Prefer the most specific taskType when two labels overlap.",
    "3. If one domain is only a data source inside a larger workflow, do not classify by that source alone.",
    "4. Copy the chosen taskTypeId exactly from the available list.",
    "",
    'Output JSON only: {"taskTypeId":"EXACT_ID"}',
  ].filter((line): line is string => Boolean(line)).join("\n");
}
function buildJudgePrompt(taskTypes: QuantTaskType[]): string {
  return generateJudgePrompt(taskTypes);
}

function normalizeConfig(pluginConfig: Record<string, unknown>): Required<QuantConfig> {
  const fromPlugin = (pluginConfig.quant ?? getLiveConfig()) as QuantConfig;
  const live = getLiveConfig();
  return {
    ...live,
    ...fromPlugin,
    detectors: Array.isArray(fromPlugin.detectors) && fromPlugin.detectors.length > 0
      ? fromPlugin.detectors
      : live.detectors,
    judge: { ...live.judge, ...(fromPlugin.judge ?? {}) },
    taskTypes: Array.isArray(fromPlugin.taskTypes) && fromPlugin.taskTypes.length > 0 ? fromPlugin.taskTypes : live.taskTypes,
    targets: { ...live.targets, ...(fromPlugin.targets ?? {}) },
    modelPricing: { ...live.modelPricing, ...(fromPlugin.modelPricing ?? {}) },
    fallbackPolicy: "escalate",
  };
}

function resolveDefaultTaskTypeId(taskTypes: QuantTaskType[], config: Required<QuantConfig>): string {
  if (taskTypes.some((taskType) => taskType.id === config.defaultTaskType)) {
    return config.defaultTaskType;
  }
  return taskTypes[0]?.id ?? defaultTaskTypes[0].id;
}

function normalizeTaskTypeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenizeTaskTypeKey(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function resolveTaskTypeIdCandidate(candidate: string, taskTypes: QuantTaskType[], defaultTaskTypeId: string): string {
  const trimmed = candidate.trim();
  if (!trimmed) return defaultTaskTypeId;

  const exact = taskTypes.find((taskType) => taskType.id === trimmed);
  if (exact) return exact.id;

  const normalizedCandidate = normalizeTaskTypeKey(trimmed);
  const normalizedMatch = taskTypes.find((taskType) => normalizeTaskTypeKey(taskType.id) === normalizedCandidate);
  if (normalizedMatch) return normalizedMatch.id;

  for (const taskType of taskTypes) {
    const aliases = TASK_TYPE_ALIAS_MAP[taskType.id] ?? [];
    if (aliases.some((alias) => normalizeTaskTypeKey(alias) === normalizedCandidate)) {
      return taskType.id;
    }
  }

  const candidateTokens = new Set(tokenizeTaskTypeKey(trimmed));
  let best: { id: string; score: number } | null = null;

  for (const taskType of taskTypes) {
    let score = 0;
    const taskIdTokens = tokenizeTaskTypeKey(taskType.id);

    for (const token of taskIdTokens) {
      if (candidateTokens.has(token)) score += 4;
      if ([...candidateTokens].some((candidateToken) => candidateToken.startsWith(token) || token.startsWith(candidateToken))) {
        score += 2;
      }
    }

    for (const alias of TASK_TYPE_ALIAS_MAP[taskType.id] ?? []) {
      const aliasTokens = tokenizeTaskTypeKey(alias);
      for (const token of aliasTokens) {
        if (candidateTokens.has(token)) score += 3;
        if ([...candidateTokens].some((candidateToken) => candidateToken.startsWith(token) || token.startsWith(candidateToken))) {
          score += 1;
        }
      }
    }

    if (!best || score > best.score) {
      best = { id: taskType.id, score };
    }
  }

  if (best && best.score > 0) {
    return best.id;
  }

  return defaultTaskTypeId;
}

function parseTaskTypeId(response: string, taskTypes: QuantTaskType[], defaultTaskTypeId: string): string {
  const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const candidates: string[] = [];

  try {
    const parsed = JSON.parse(cleaned) as { taskTypeId?: unknown };
    if (typeof parsed.taskTypeId === "string") candidates.push(parsed.taskTypeId);
  } catch {
    // Ignore non-JSON whole-body responses.
  }

  const jsonMatch = cleaned.match(/\{[\s\S]*?"taskTypeId"\s*:\s*"([A-Za-z0-9_-]+)"[\s\S]*?\}/);
  if (jsonMatch?.[1]) candidates.push(jsonMatch[1]);

  const directMatch = cleaned.match(/"?taskTypeId"?\s*[:=]\s*"?([A-Za-z0-9_-]+)"?/i);
  if (directMatch?.[1]) candidates.push(directMatch[1]);

  const quotedId = cleaned.match(/"([A-Za-z0-9_-]+)"/);
  if (quotedId?.[1]) candidates.push(quotedId[1]);

  for (const candidate of candidates) {
    const resolved = resolveTaskTypeIdCandidate(candidate, taskTypes, defaultTaskTypeId);
    if (resolved) return resolved;
  }

  return defaultTaskTypeId;
}

function tokenizeForRules(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  const deduped = new Set<string>();
  for (const token of matches) {
    if (token.length < 2) continue;
    if (RULE_STOP_WORDS.has(token)) continue;
    deduped.add(token);
  }
  return [...deduped];
}

function compilePatterns(taskType: QuantTaskType): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of taskType.patterns ?? []) {
    try {
      compiled.push(new RegExp(pattern, "iu"));
    } catch {
      // Ignore invalid regex.
    }
  }
  return compiled;
}

function matchesRuleKeyword(normalizedPrompt: string, promptTokens: Set<string>, keyword: string): boolean {
  const normalizedKeyword = keyword.toLowerCase().trim();
  if (!normalizedKeyword) return false;
  if (/[\u4e00-\u9fff]/u.test(normalizedKeyword)) return normalizedPrompt.includes(normalizedKeyword);
  if (normalizedKeyword.includes(" ")) return normalizedPrompt.includes(normalizedKeyword);
  return promptTokens.has(normalizedKeyword);
}

function isPhraseLikeKeyword(keyword: string): boolean {
  return /[\u4e00-\u9fff]{2,}/u.test(keyword) || /\s/.test(keyword);
}

function isComplexRulePrompt(prompt: string, normalizedPrompt: string): boolean {
  const systemHints = COMPLEX_RULE_SYSTEM_HINTS.reduce(
    (count, hint) => count + (normalizedPrompt.includes(hint) ? 1 : 0),
    0,
  );
  const numberedSteps = (prompt.match(/(?:^|\n)\s*\d+\./g) ?? []).length;
  return systemHints >= 2 || numberedSteps >= 2 || prompt.length > SIMPLE_RULE_PROMPT_MAX_LENGTH;
}

function detectTaskTypeByRules(
  prompt: string,
  taskTypes: QuantTaskType[],
): { taskTypeId: string; reason: string; confidence: number } | null {
  const normalizedPrompt = prompt.toLowerCase();
  const promptTokens = new Set(tokenizeForRules(prompt));
  const complexPrompt = isComplexRulePrompt(prompt, normalizedPrompt);
  const ranked: Array<{
    taskTypeId: string;
    score: number;
    patternMatches: number;
    keywordMatches: number;
    matches: string[];
  }> = [];

  for (const taskType of taskTypes) {
    let score = 0;
    let patternMatches = 0;
    let keywordMatches = 0;
    const matches: string[] = [];

    for (const pattern of compilePatterns(taskType)) {
      if (!pattern.test(prompt)) continue;
      score += 14;
      patternMatches += 1;
      matches.push(`pattern:${pattern.source}`);
    }

    if (!complexPrompt && SIMPLE_RULE_ALLOWED_TASK_IDS.has(taskType.id)) {
      for (const keyword of taskType.keywords ?? []) {
        const normalizedKeyword = keyword.toLowerCase().trim();
        if (!matchesRuleKeyword(normalizedPrompt, promptTokens, normalizedKeyword)) continue;
        keywordMatches += 1;
        score += isPhraseLikeKeyword(normalizedKeyword) ? 5 : 3;
        matches.push(`keyword:${normalizedKeyword}`);
      }
    }

    if (patternMatches === 0 && keywordMatches === 0) continue;
    if (complexPrompt && patternMatches === 0) continue;

    ranked.push({
      taskTypeId: taskType.id,
      score,
      patternMatches,
      keywordMatches,
      matches,
    });
  }

  ranked.sort((left, right) => (
    right.score - left.score ||
    right.patternMatches - left.patternMatches ||
    right.keywordMatches - left.keywordMatches
  ));

  const best = ranked[0];
  const second = ranked[1];
  if (!best) return null;

  const margin = best.score - (second?.score ?? 0);
  if (best.patternMatches === 0 && best.keywordMatches < 2) return null;
  if (best.score < RULE_SCORE_THRESHOLD || margin < RULE_MARGIN_THRESHOLD) return null;

  return {
    taskTypeId: best.taskTypeId,
    reason: best.matches.slice(0, 4).join(",") || "rule-match",
    confidence: best.patternMatches > 0 ? 0.96 : Math.min(0.9, 0.55 + best.score / 20),
  };
}

async function detectTaskTypeByModel(params: {
  prompt: string;
  taskTypes: QuantTaskType[];
  config: Required<QuantConfig>;
  defaultTaskTypeId: string;
}): Promise<{ taskTypeId: string; usage?: { input: number; output: number; total: number } }> {
  const judgePrompt = buildJudgePrompt(params.taskTypes);
  const result = await callChatCompletion(
    params.config.judge.endpoint,
    params.config.judge.model,
    [
      { role: "system", content: judgePrompt },
      { role: "user", content: params.prompt },
    ],
    {
      providerType: params.config.judge.providerType,
      apiKey: params.config.judge.apiKey || undefined,
      customModule: params.config.judge.customModule || undefined,
      temperature: 0,
      maxTokens: 256,
    },
  );

  const taskTypeId = parseTaskTypeId(result.text, params.taskTypes, params.defaultTaskTypeId);

  return {
    taskTypeId,
    usage: result.usage,
  };
}

function buildDecision(
  taskTypes: QuantTaskType[],
  config: Required<QuantConfig>,
  hostConfig: Record<string, unknown>,
  taskTypeId: string,
  meta?: { detector?: QuantDetector | "fallback"; reason?: string; confidence?: number },
): RouteDecision {
  const taskType = taskTypes.find((entry) => entry.id === taskTypeId) ?? taskTypes[0];
  const preferredPrecision = taskType?.precision ?? "8bit";
  const resolved = resolveRouteTarget(hostConfig, config, preferredPrecision as Precision);
  const baseReason = meta?.reason ?? `detector=${meta?.detector ?? "loadModelDetector"};taskType=${taskType?.id}`;


  if (!resolved) {
    return {
      action: "passthrough",
      taskTypeId: taskType?.id,
      precision: preferredPrecision,
      reason: `${baseReason};target=missing`,
      confidence: meta?.confidence,
    };
  }

  return {
    action: "redirect",
    taskTypeId: taskType?.id,
    precision: resolved.precision,
    target: resolved.target,
    fallbackPath: resolved.fallbackPath,
    reason: `${baseReason};precision=${resolved.precision}`,
    confidence: meta?.confidence ?? 0.8,
  };
}

export const quantRouter: QuantRouter = {
  id: "quant-router",

  async detect(context: DetectionContext, pluginConfig: Record<string, unknown>): Promise<RouteDecision> {
    const config = normalizeConfig(pluginConfig);
    if (!config.enabled && !context.dryRun) {
      return { action: "passthrough", reason: "QuantClaw disabled" };
    }

    const prompt = context.message?.trim() ?? "";
    if (!prompt) {
      return { action: "passthrough", reason: "Empty prompt" };
    }

    const taskTypes = config.taskTypes;
    if (!taskTypes.length) {
      return { action: "passthrough", reason: "No task types configured" };
    }

    const defaultTaskTypeId = resolveDefaultTaskTypeId(taskTypes, config);
    const hostConfig = (pluginConfig.hostConfig as Record<string, unknown> | undefined) ?? {};
    const validIds = new Set(taskTypes.map((taskType) => taskType.id));

    startCacheCleanup();
    const cacheKey = hashPrompt(prompt, config.detectors, taskTypes);
    const cached = classificationCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < config.judge.cacheTtlMs && validIds.has(cached.taskTypeId)) {
      return buildDecision(taskTypes, config, hostConfig, cached.taskTypeId, {
        detector: cached.detector,
        reason: `detector=${cached.detector};cached=1;taskType=${cached.taskTypeId}`,
        confidence: cached.detector === "ruleDetector" ? 0.92 : 0.8,
      });
    }

    let ruleDetectorMissed = false;

    for (const detector of config.detectors) {
      if (detector === "ruleDetector") {
        const ruleMatch = detectTaskTypeByRules(prompt, taskTypes);
        if (!ruleMatch) {
          ruleDetectorMissed = true;
          continue;
        }
        classificationCache.set(cacheKey, { taskTypeId: ruleMatch.taskTypeId, ts: Date.now(), detector });
        return buildDecision(taskTypes, config, hostConfig, ruleMatch.taskTypeId, {
          detector,
          reason: `detector=${detector};taskType=${ruleMatch.taskTypeId};match=${ruleMatch.reason}`,
          confidence: ruleMatch.confidence,
        });
      }

      if (detector === "loadModelDetector") {
        const result = await detectTaskTypeByModel({
          prompt,
          taskTypes,
          config,
          defaultTaskTypeId,
        });
        const decision = buildDecision(taskTypes, config, hostConfig, result.taskTypeId, {
          detector,
          reason: `detector=${detector};taskType=${result.taskTypeId}`,
          confidence: 0.8,
        });
        classificationCache.set(cacheKey, { taskTypeId: result.taskTypeId, ts: Date.now(), detector });

        if (result.usage && decision.precision) {
          getGlobalCollector()?.record({
            sessionKey: context.sessionKey ?? "",
            provider: "quant-router-judge",
            model: config.judge.model,
            source: "router",
            usage: result.usage,
            precision: decision.precision,
            taskTypeId: result.taskTypeId,
          });
        }

        return decision;
      }
    }

    classificationCache.set(cacheKey, { taskTypeId: defaultTaskTypeId, ts: Date.now(), detector: "fallback" });
    return buildDecision(taskTypes, config, hostConfig, defaultTaskTypeId, {
      detector: "fallback",
      reason: `detector=fallback;taskType=${defaultTaskTypeId}`,
      confidence: 0.2,
    });
  },
};

export { classificationCache, detectTaskTypeByRules, hashPrompt, parseTaskTypeId };
