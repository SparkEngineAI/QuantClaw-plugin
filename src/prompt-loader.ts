import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolvePromptsDir(): string {
  const candidates = [
    resolve(__dirname, "../prompts"),
    resolve(__dirname, "../../prompts"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

const PROMPTS_DIR = resolvePromptsDir();
const cache = new Map<string, string>();

export function loadPrompt(name: string, fallback: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const filePath = resolve(PROMPTS_DIR, `${name}.md`);
  let content = fallback;
  try {
    if (existsSync(filePath)) {
      content = readFileSync(filePath, "utf-8").trim();
      console.log(`[QuantClaw] Loaded custom prompt: prompts/${name}.md`);
    }
  } catch {
    console.warn(`[QuantClaw] Failed to read prompts/${name}.md, using default`);
  }
  cache.set(name, content);
  return content;
}

export function invalidatePrompt(name: string): void {
  cache.delete(name);
}

export function writePrompt(name: string, content: string): void {
  mkdirSync(PROMPTS_DIR, { recursive: true });
  const filePath = resolve(PROMPTS_DIR, `${name}.md`);
  writeFileSync(filePath, content, "utf-8");
  invalidatePrompt(name);
}

export function readPromptFromDisk(name: string): string | null {
  const filePath = resolve(PROMPTS_DIR, `${name}.md`);
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, "utf-8").trim();
    }
  } catch {
    // Ignore unreadable file.
  }
  return null;
}
