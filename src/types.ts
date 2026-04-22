export const PRECISIONS = ["4bit", "8bit", "16bit"] as const;

export type Precision = typeof PRECISIONS[number];

export const QUANT_DETECTORS = ["ruleDetector", "loadModelDetector"] as const;

export type QuantDetector = typeof QUANT_DETECTORS[number];

export type EdgeProviderType = "openai-compatible" | "ollama-native" | "custom";

export type PricingConfig = {
  inputPer1M?: number;
  outputPer1M?: number;
};

export type QuantTargetConfig = {
  provider: string;
  model: string;
  endpoint?: string;
  api?: string;
  apiKey?: string;
  customModule?: string;
  pricing?: PricingConfig;
  displayName?: string;
};

export type QuantTaskType = {
  id: string;
  description: string;
  precision: Precision;
  keywords?: string[];
  patterns?: string[];
};

export type QuantJudgeConfig = {
  endpoint: string;
  model: string;
  providerType: EdgeProviderType;
  apiKey?: string;
  customModule?: string;
  cacheTtlMs: number;
};

export type QuantConfig = {
  enabled?: boolean;
  detectors?: QuantDetector[];
  judge?: QuantJudgeConfig;
  taskTypes?: QuantTaskType[];
  defaultTaskType?: string;
  targets?: Record<Precision, QuantTargetConfig>;
  fallbackPolicy?: "escalate";
  modelPricing?: Record<string, PricingConfig>;
};

export type Checkpoint = "onUserMessage";

export type DetectionContext = {
  checkpoint: Checkpoint;
  message?: string;
  sessionKey?: string;
  agentId?: string;
  dryRun?: boolean;
};

export type RouteTarget = {
  provider: string;
  model: string;
  displayName?: string;
};

export type RouterAction = "passthrough" | "redirect";

export type RouteDecision = {
  action?: RouterAction;
  taskTypeId?: string;
  precision?: Precision;
  target?: RouteTarget;
  fallbackPath?: Precision[];
  reason?: string;
  confidence?: number;
  routerId?: string;
};

export interface QuantRouter {
  id: string;
  detect(context: DetectionContext, config: Record<string, unknown>): Promise<RouteDecision>;
}

export type RouterRegistration = {
  enabled?: boolean;
  type?: "builtin" | "custom";
  module?: string;
  weight?: number;
};

export type PipelineConfig = {
  onUserMessage?: string[];
};

export type DetectionEvent = {
  sessionKey: string;
  timestamp: number;
  checkpoint: Checkpoint;
  phase?: "start" | "complete" | "generating" | "llm_complete" | "input_estimate";
  reason?: string;
  routerId?: string;
  action?: string;
  target?: string;
  taskTypeId?: string;
  precision?: Precision;
  fallbackPath?: Precision[];
  estimatedInputTokens?: number;
  estimatedCost?: number;
  model?: string;
  provider?: string;
  loopId?: string;
};

export type LoopMeta = {
  loopId: string;
  sessionKey: string;
  userMessage: string;
  userMessagePreview: string;
  startedAt: number;
  taskTypeId?: string;
  precision?: Precision;
  fallbackPath?: Precision[];
  routedModel?: string;
  routerAction?: string;
};

export type SessionRouteState = {
  sessionKey: string;
  detectionHistory: DetectionEvent[];
  currentLoopId?: string;
  userMessage?: string;
  userMessagePreview?: string;
  taskTypeId?: string;
  precision?: Precision;
  fallbackPath?: Precision[];
  routedModel?: string;
  routerAction?: string;
};
