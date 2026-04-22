import type { EdgeProviderType } from "./types.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatCompletionOptions = {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  frequencyPenalty?: number;
  apiKey?: string;
  providerType?: EdgeProviderType;
  customModule?: string;
};

export type LlmUsageInfo = {
  input: number;
  output: number;
  total: number;
};

export type ChatCompletionResult = {
  text: string;
  usage?: LlmUsageInfo;
};

export interface CustomEdgeProvider {
  callChat(
    endpoint: string,
    model: string,
    messages: ChatMessage[],
    options?: ChatCompletionOptions,
  ): Promise<string>;
}

const customProviderCache = new Map<string, CustomEdgeProvider>();
const FETCH_TIMEOUT_MS = 60_000;

function summarizeText(text: string, maxLen = 300): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}

function maskApiKey(apiKey?: string): string | undefined {
  if (!apiKey) return undefined;
  if (apiKey.length <= 8) return "***";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

async function loadCustomProvider(modulePath: string): Promise<CustomEdgeProvider> {
  const cached = customProviderCache.get(modulePath);
  if (cached) return cached;
  const mod = await import(modulePath) as CustomEdgeProvider;
  if (typeof mod.callChat !== "function") {
    throw new Error(`Custom edge provider at \"${modulePath}\" must export callChat()`);
  }
  customProviderCache.set(modulePath, mod);
  return mod;
}

function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function consumeSSEStream(body: ReadableStream<Uint8Array>): Promise<ChatCompletionResult> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  const textParts: string[] = [];
  let usage: LlmUsageInfo | undefined;
  let chunkCount = 0;
  let eventCount = 0;
  let malformedChunkCount = 0;
  let accumulatedTextLength = 0;

  // console.log("[quantclaw][consumeSSEStream] begin");

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunkCount += 1;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        eventCount += 1;
        const payload = trimmed.slice(5).trim();
        if (!payload) {
          continue;
        }
        if (payload === "[DONE]") {
          continue;
        }
        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            textParts.push(delta);
            accumulatedTextLength += delta.length;
          }
          if (chunk.usage) {
            usage = {
              input: chunk.usage.prompt_tokens ?? 0,
              output: chunk.usage.completion_tokens ?? 0,
              total: chunk.usage.total_tokens ?? 0,
            };
          }
        } catch (error) {
          malformedChunkCount += 1;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const rawText = textParts.join("");
  const finalText = stripThinkingTags(rawText);
  void chunkCount;
  void eventCount;
  void malformedChunkCount;
  void accumulatedTextLength;
  void summarizeText;

  return { text: finalText, usage };
}

async function callOpenAICompatible(
  endpoint: string,
  model: string,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<ChatCompletionResult> {
  const base = endpoint.replace(/\/v1\/?$/, "");
  const url = `${base}/v1/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options?.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  const requestBody = {
    model,
    messages,
    temperature: options?.temperature ?? 0,
    max_tokens: options?.maxTokens ?? 512,
    stream: true,
    chat_template_kwargs: { enable_thinking: false },
    ...(options?.stop ? { stop: options.stop } : {}),
    ...(options?.frequencyPenalty != null ? { frequency_penalty: options.frequencyPenalty } : {}),
  };
  const requestBodyText = JSON.stringify(requestBody);

  void maskApiKey;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: requestBodyText,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw error;
  }


  if (!response.ok) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 300);
    } catch {
      // Ignore body read failure.
    }

    throw new Error(`Chat completions API error: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`);
  }

  const contentType = response.headers.get("content-type") ?? "";


  if (contentType.includes("text/event-stream") && response.body) {
    const result = await consumeSSEStream(response.body);
    return result;
  }

  if (!response.body) {
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const result = {
    text: stripThinkingTags(data.choices?.[0]?.message?.content ?? ""),
    usage: data.usage
      ? {
          input: data.usage.prompt_tokens ?? 0,
          output: data.usage.completion_tokens ?? 0,
          total: data.usage.total_tokens ?? ((data.usage.prompt_tokens ?? 0) + (data.usage.completion_tokens ?? 0)),
        }
      : undefined,
  };


  return result;
}

async function callOllamaNative(
  endpoint: string,
  model: string,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<ChatCompletionResult> {
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        temperature: options?.temperature ?? 0,
        num_predict: options?.maxTokens ?? 512,
      },
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };

  return {
    text: stripThinkingTags(data.message?.content ?? ""),
    usage: {
      input: data.prompt_eval_count ?? 0,
      output: data.eval_count ?? 0,
      total: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    },
  };
}

export async function callChatCompletion(
  endpoint: string,
  model: string,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<ChatCompletionResult> {
  const providerType = options?.providerType ?? "openai-compatible";
  if (providerType === "custom") {
    if (!options?.customModule) {
      throw new Error("Custom provider requires customModule");
    }
    const provider = await loadCustomProvider(options.customModule);
    const text = await provider.callChat(endpoint, model, messages, options);
    return { text: stripThinkingTags(text) };
  }

  if (providerType === "ollama-native") {
    return callOllamaNative(endpoint, model, messages, options);
  }

  return callOpenAICompatible(endpoint, model, messages, options);
}
