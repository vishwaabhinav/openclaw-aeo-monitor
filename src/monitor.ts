/**
 * AEO Monitor — native TypeScript implementation.
 *
 * Queries OpenAI (GPT-4o-mini) and Google Gemini (2.5-flash) with three tiers
 * of queries (branded, category, dynamic) and checks whether the CORRECT Nomie
 * Wellness app (mynomie.com URL) is mentioned in responses.
 *
 * Uses URL-based detection to distinguish from the old open-source Nomie tracker.
 */

import axios from "axios";
import fs from "node:fs";
import path from "node:path";

// =================== Config ===================

export const BRANDED_QUERIES = [
  "What is Nomie app?",
  "Nomie wellness app",
  "Nomie app review",
  "Nomie AI companion",
  "Nomie vs Calm",
  "Nomie vs Headspace",
  "Nomie vs Replika",
  "Nomie vs Woebot",
  "Nomie anti doomscrolling app",
  "Nomie bloomscrolling",
  "mynomie.com",
  "Is Nomie app free?",
  "Nomie app for anxiety",
];

export const CATEGORY_QUERIES = [
  "What are the best AI wellness apps in 2026?",
  "What is the best app for anxiety journaling?",
  "Best apps to stop doomscrolling",
  "AI companion apps for mental health",
  "Best apps for nervous system regulation",
  "What are the best somatic wellness apps?",
  "Best AI journaling apps 2026",
  "Apps that help with phone addiction",
  "What is bloomscrolling?",
  "Best alternatives to Calm and Headspace",
  "Best app for panic attacks",
  "Somatic breathing app",
  "AI app that remembers you",
  "Anti doomscrolling app",
  "Best app for anxiety relief",
  "AI mental health companion app",
  "Best self care apps 2026",
  "Apps for nervous system dysregulation",
  "Digital fidget app for anxiety",
  "Best app for burnout recovery",
];

export const BRAND_TERMS = ["nomie", "mynomie", "mynomie.com", "nomie wellness", "bloomscrolling"];

// URL-based signals — only way to confirm it's the correct Nomie (not the old tracker)
export const CORRECT_NOMIE_URLS = [
  "mynomie.com",
  "mynomie",
  "apps.apple.com/us/app/nomie-ai-wellness-companion",
];

// =================== Types ===================

export type Tier = "branded" | "category" | "dynamic";

export type QueryResult = {
  query: string;
  engine: "chatgpt" | "gemini";
  model: string;
  tier: Tier;
  timestamp: string;
  mentioned: boolean;
  correct_nomie: boolean;
  terms_found: string[];
  response_preview: string;
  error: string | null;
};

export type Summary = {
  date: string;
  timestamp: string;
  overall_score: number;
  branded_score: number;
  category_score: number;
  dynamic_score: number;
  total_queries: number;
  dynamic_queries_used: string[];
  engines: Record<string, { total: number; correct: number; mentioned_wrong: number; errors: number; score: number }>;
};

// =================== Query helpers ===================

function checkResponse(text: string): { mentioned: boolean; correct_nomie: boolean; terms_found: string[] } {
  const lower = text.toLowerCase();
  const mentions = BRAND_TERMS.filter((t) => lower.includes(t));
  const correct = CORRECT_NOMIE_URLS.some((u) => lower.includes(u));
  return { mentioned: mentions.length > 0, correct_nomie: correct, terms_found: mentions };
}

export async function queryOpenAI(question: string, apiKey: string): Promise<{ text: string; error: string | null }> {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: question }],
        max_tokens: 1024,
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: 60000,
      }
    );
    const text: string = resp.data?.choices?.[0]?.message?.content ?? "";
    return { text, error: null };
  } catch (e: any) {
    return { text: "", error: String(e?.response?.data?.error?.message || e?.message || e) };
  }
}

export async function queryGemini(question: string, apiKey: string): Promise<{ text: string; error: string | null }> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const resp = await axios.post(
      url,
      {
        contents: [{ parts: [{ text: question }] }],
        generationConfig: { maxOutputTokens: 1024 },
      },
      { timeout: 60000 }
    );
    const text: string = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return { text, error: null };
  } catch (e: any) {
    return { text: "", error: String(e?.response?.data?.error?.message || e?.message || e) };
  }
}

// =================== Dynamic query generation ===================

export async function generateDynamicQueries(openaiApiKey: string): Promise<string[]> {
  const prompt = `Generate 10 realistic search queries someone might ask ChatGPT or Google when looking for a wellness/anxiety/mental health app. A somatic AI wellness companion (breathing exercises, digital fidgets, AI companion with memory, bloomscrolling, nervous system regulation, anti-doomscrolling) would be relevant. Mix: "best X app", "how to Y", comparison, feature, and trending queries. Return ONLY a JSON array of 10 strings.`;
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 512,
        temperature: 0.9,
      },
      {
        headers: { Authorization: `Bearer ${openaiApiKey}`, "Content-Type": "application/json" },
        timeout: 60000,
      }
    );
    let text: string = resp.data?.choices?.[0]?.message?.content?.trim() ?? "";
    // Strip markdown code fences
    if (text.startsWith("```")) {
      text = text.split("\n").slice(1).join("\n");
      const closeIdx = text.lastIndexOf("```");
      if (closeIdx >= 0) text = text.slice(0, closeIdx).trim();
    }
    if (!text.startsWith("[")) {
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      if (start >= 0 && end > start) text = text.slice(start, end + 1);
    }
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return [];
    return arr.filter((q: any) => typeof q === "string").slice(0, 10);
  } catch (e: any) {
    console.error(`[aeo-monitor] dynamic query generation failed: ${e?.message || e}`);
    return [];
  }
}

// =================== Main run ===================

export type RunOptions = {
  openaiApiKey?: string;
  geminiApiKey?: string;
  logDir: string;
  onProgress?: (msg: string) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runMonitor(opts: RunOptions): Promise<{ summary: Summary; results: QueryResult[] }> {
  const { openaiApiKey, geminiApiKey, logDir, onProgress } = opts;
  const log = (m: string) => {
    if (onProgress) onProgress(m);
  };

  if (!openaiApiKey && !geminiApiKey) {
    throw new Error("No API keys configured (need OPENAI_API_KEY or GEMINI_API_KEY)");
  }

  fs.mkdirSync(logDir, { recursive: true });

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString();
  const jsonlPath = path.join(logDir, `aeo-${dateStr}.jsonl`);

  log("Generating dynamic queries...");
  const dynamic = openaiApiKey ? await generateDynamicQueries(openaiApiKey) : [];
  log(`  Got ${dynamic.length} dynamic queries`);

  const allQueries: Array<{ tier: Tier; query: string }> = [
    ...BRANDED_QUERIES.map((q) => ({ tier: "branded" as Tier, query: q })),
    ...CATEGORY_QUERIES.map((q) => ({ tier: "category" as Tier, query: q })),
    ...dynamic.map((q) => ({ tier: "dynamic" as Tier, query: q })),
  ];

  const results: QueryResult[] = [];
  const total = allQueries.length;

  for (let i = 0; i < allQueries.length; i++) {
    const { tier, query } = allQueries[i];
    const pct = Math.round((i / total) * 100);
    const hits: string[] = [];

    if (openaiApiKey) {
      const { text, error } = await queryOpenAI(query, openaiApiKey);
      const check = checkResponse(text);
      const r: QueryResult = {
        query,
        engine: "chatgpt",
        model: "gpt-4o-mini",
        tier,
        timestamp,
        mentioned: check.mentioned,
        correct_nomie: check.correct_nomie,
        terms_found: check.terms_found,
        response_preview: text.slice(0, 500),
        error,
      };
      results.push(r);
      fs.appendFileSync(jsonlPath, JSON.stringify(r) + "\n");
      hits.push(`gpt:${error ? "!" : check.correct_nomie ? "+" : check.mentioned ? "~" : "-"}`);
      await sleep(200);
    }

    if (geminiApiKey) {
      const { text, error } = await queryGemini(query, geminiApiKey);
      const check = checkResponse(text);
      const r: QueryResult = {
        query,
        engine: "gemini",
        model: "gemini-2.5-flash",
        tier,
        timestamp,
        mentioned: check.mentioned,
        correct_nomie: check.correct_nomie,
        terms_found: check.terms_found,
        response_preview: text.slice(0, 500),
        error,
      };
      results.push(r);
      fs.appendFileSync(jsonlPath, JSON.stringify(r) + "\n");
      hits.push(`gem:${error ? "!" : check.correct_nomie ? "+" : check.mentioned ? "~" : "-"}`);
      await sleep(200);
    }

    log(`  [${String(pct).padStart(3)}%] (${tier.padEnd(8)}) ${hits.join(" ").padEnd(16)} | ${query}`);
  }

  // Calculate scores
  const calcScore = (filt: (r: QueryResult) => boolean) => {
    const subset = results.filter(filt);
    const valid = subset.filter((r) => !r.error).length;
    const correct = subset.filter((r) => r.correct_nomie).length;
    return Math.round((correct / Math.max(valid, 1)) * 100);
  };

  const overall_score = calcScore(() => true);
  const branded_score = calcScore((r) => r.tier === "branded");
  const category_score = calcScore((r) => r.tier === "category");
  const dynamic_score = calcScore((r) => r.tier === "dynamic");

  const engines: Record<string, any> = {};
  for (const eng of ["chatgpt", "gemini"] as const) {
    const er = results.filter((r) => r.engine === eng);
    const valid = er.filter((r) => !r.error).length;
    const correct = er.filter((r) => r.correct_nomie).length;
    const mentioned = er.filter((r) => r.mentioned).length;
    engines[eng] = {
      total: er.length,
      correct,
      mentioned_wrong: mentioned - correct,
      errors: er.filter((r) => r.error).length,
      score: Math.round((correct / Math.max(valid, 1)) * 100),
    };
  }

  // Append CSV
  const csvPath = path.join(logDir, "aeo-scores.csv");
  const header = "date,timestamp,overall,branded,category,dynamic,chatgpt_score,gemini_score,total_queries\n";
  if (!fs.existsSync(csvPath) || fs.statSync(csvPath).size === 0) {
    fs.writeFileSync(csvPath, header);
  }
  fs.appendFileSync(
    csvPath,
    `${dateStr},${timestamp},${overall_score},${branded_score},${category_score},${dynamic_score},${engines.chatgpt?.score ?? 0},${engines.gemini?.score ?? 0},${total}\n`
  );

  const summary: Summary = {
    date: dateStr,
    timestamp,
    overall_score,
    branded_score,
    category_score,
    dynamic_score,
    total_queries: total,
    dynamic_queries_used: dynamic,
    engines,
  };

  return { summary, results };
}
