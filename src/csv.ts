import fs from "node:fs";

export type ScoreRow = {
  date: string;
  timestamp: string;
  overall: number;
  branded: number;
  category: number;
  dynamic: number;
  chatgpt_score: number;
  gemini_score: number;
  total_queries: number;
};

function toNum(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Very small CSV parser (no quoted fields expected)
export function readScores(csvPath: string): ScoreRow[] {
  if (!fs.existsSync(csvPath)) return [];
  const text = fs.readFileSync(csvPath, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((s) => s.trim());
  const idx = (name: string) => header.indexOf(name);
  const iDate = idx("date");
  const iTs = idx("timestamp");
  const iOverall = idx("overall");
  const iBranded = idx("branded");
  const iCategory = idx("category");
  const iDynamic = idx("dynamic");
  const iChat = idx("chatgpt_score");
  const iGem = idx("gemini_score");
  const iTotal = idx("total_queries");

  const rows: ScoreRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    if (cols.length < header.length) continue;
    const r: ScoreRow = {
      date: cols[iDate] ?? "",
      timestamp: cols[iTs] ?? "",
      overall: toNum(cols[iOverall] ?? "0"),
      branded: toNum(cols[iBranded] ?? "0"),
      category: toNum(cols[iCategory] ?? "0"),
      dynamic: toNum(cols[iDynamic] ?? "0"),
      chatgpt_score: toNum(cols[iChat] ?? "0"),
      gemini_score: toNum(cols[iGem] ?? "0"),
      total_queries: toNum(cols[iTotal] ?? "0"),
    };
    if (r.date) rows.push(r);
  }
  return rows;
}
