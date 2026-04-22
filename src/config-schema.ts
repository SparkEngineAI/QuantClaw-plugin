import { Type } from "@sinclair/typebox";
import type { Precision, QuantConfig, QuantTargetConfig, QuantTaskType } from "./types.js";

const precisionEnum = Type.Union([
  Type.Literal("4bit"),
  Type.Literal("8bit"),
  Type.Literal("16bit"),
]);

const targetSchema = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  endpoint: Type.Optional(Type.String()),
  api: Type.Optional(Type.String()),
  apiKey: Type.Optional(Type.String()),
  customModule: Type.Optional(Type.String()),
  pricing: Type.Optional(
    Type.Object({
      inputPer1M: Type.Optional(Type.Number()),
      outputPer1M: Type.Optional(Type.Number()),
    }),
  ),
  displayName: Type.Optional(Type.String()),
});

const taskTypeSchema = Type.Object({
  id: Type.String(),
  description: Type.String(),
  precision: precisionEnum,
  keywords: Type.Optional(Type.Array(Type.String())),
  patterns: Type.Optional(Type.Array(Type.String())),
});

export const quantClawConfigSchema = Type.Object({
  quant: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      detectors: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("ruleDetector"),
            Type.Literal("loadModelDetector"),
          ]),
        ),
      ),
      judge: Type.Optional(
        Type.Object({
          endpoint: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
          providerType: Type.Optional(
            Type.Union([
              Type.Literal("openai-compatible"),
              Type.Literal("ollama-native"),
              Type.Literal("custom"),
            ]),
          ),
          apiKey: Type.Optional(Type.String()),
          customModule: Type.Optional(Type.String()),
          cacheTtlMs: Type.Optional(Type.Number()),
        }),
      ),
      taskTypes: Type.Optional(Type.Array(taskTypeSchema)),
      defaultTaskType: Type.Optional(Type.String()),
      targets: Type.Optional(
        Type.Object({
          "4bit": Type.Optional(targetSchema),
          "8bit": Type.Optional(targetSchema),
          "16bit": Type.Optional(targetSchema),
        }),
      ),
      fallbackPolicy: Type.Optional(Type.Literal("escalate")),
      modelPricing: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            inputPer1M: Type.Optional(Type.Number()),
            outputPer1M: Type.Optional(Type.Number()),
          }),
        ),
      ),
    }),
  ),
});

export const defaultTaskTypes: QuantTaskType[] = [
  {
    id: "simple",
    precision: "4bit",
    description: "short factual questions, greetings, simple rewrites, tiny lookups, low-risk drafting",
    keywords: ["hello", "rewrite", "summarize", "format", "lookup"],
  },
  {
    id: "standard",
    precision: "8bit",
    description: "general coding help, moderate writing, data cleanup, document summaries, single-file edits",
    keywords: ["refine", "single file", "summarize document", "data cleanup"],
  },
  {
    id: "reasoning",
    precision: "16bit",
    description: "multi-file refactors, difficult debugging, long-document reasoning, complex planning, research-intensive tasks",
    keywords: ["multi-file", "refactor", "debug", "research", "plan"],
  },
];

export const defaultTargets: Record<Precision, QuantTargetConfig> = {
  "4bit": {
    provider: "openai",
    model: "gpt-4o-mini",
    displayName: "4-bit Target",
  },
  "8bit": {
    provider: "openai",
    model: "gpt-4o",
    displayName: "8-bit Target",
  },
  "16bit": {
    provider: "openai",
    model: "gpt-5.4",
    displayName: "16-bit Target",
  },
};

export const defaultQuantConfig: Required<QuantConfig> = {
  enabled: true,
  detectors: ["loadModelDetector"],
  judge: {
    endpoint: "http://localhost:11434",
    model: "openbmb/minicpm4.1",
    providerType: "openai-compatible",
    apiKey: "",
    customModule: "",
    cacheTtlMs: 300_000,
  },
  taskTypes: defaultTaskTypes,
  defaultTaskType: "standard",
  targets: defaultTargets,
  fallbackPolicy: "escalate",
  modelPricing: {
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
    "gpt-5.4": { inputPer1M: 3, outputPer1M: 15 },
  },
};
