export function resolveDefaultBaseUrl(provider: string, api?: string): string {
  const p = provider.toLowerCase();
  const a = (api ?? "").toLowerCase();

  if (
    p === "google" ||
    p.includes("gemini") ||
    p.includes("vertex") ||
    a.includes("google") ||
    a.includes("gemini")
  ) {
    return "https://generativelanguage.googleapis.com/v1beta";
  }

  if (p === "anthropic" || a === "anthropic-messages") {
    return "https://api.anthropic.com";
  }

  return "https://api.openai.com/v1";
}
