import fs from "node:fs";
import path from "node:path";

export type AeoState = {
  lastRunDateUtc?: string; // YYYY-MM-DD
};

export function statePath(baseDir: string): string {
  return path.join(baseDir, "data", "state.json");
}

export function loadState(baseDir: string): AeoState {
  const p = statePath(baseDir);
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function saveState(baseDir: string, state: AeoState): void {
  const p = statePath(baseDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}
