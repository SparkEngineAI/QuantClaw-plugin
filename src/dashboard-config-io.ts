import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME_DIR = process.env.HOME ?? "/tmp";

export const QUANTCLAW_CONFIG_PATH = join(HOME_DIR, ".openclaw", "quantclaw.json");

export function saveQuantClawConfig(quant: Record<string, unknown>): void {
  try {
    const dir = join(HOME_DIR, ".openclaw");
    mkdirSync(dir, { recursive: true });
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(QUANTCLAW_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    } catch {
      // File may not exist yet.
    }
    const updated = { ...existing, quant };
    writeFileSync(QUANTCLAW_CONFIG_PATH, JSON.stringify(updated, null, 2), "utf-8");
  } catch {
    // Best-effort persistence.
  }
}
