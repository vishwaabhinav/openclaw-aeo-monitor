/**
 * AEO gap queue — Loop 1 of the AEO improvement design.
 *
 * Reads recent AEO monitor JSONL logs, picks the top failing
 * category/dynamic queries (where neither ChatGPT nor Gemini mentioned
 * the correct Nomie), and appends them to TOMORROW-POSTS.md in the
 * nomie-website repo so the existing nomie-seo-nightly blog cron picks
 * them up.
 *
 * Design: local notes in nomie-website/docs/plans/2026-04-18-aeo-improvement-loops-design.md
 *
 * Runs weekly Sundays before the blog generation cron. Does not produce
 * content itself — it just adds failing queries to the existing blog
 * pipeline's queue.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { QueryResult } from "./monitor.js";

type QueryFailure = {
  query: string;
  tier: "category" | "dynamic";
  firstSeen: string;
  daysFailing: number;
  engines: string[];
};

export type GapQueueOptions = {
  logDir: string;
  repoPath: string;
  tomorrowPostsPath: string;
  lookbackDays: number;
  maxToAdd: number;
  commitAndPush: boolean;
  onLog?: (m: string) => void;
};

// Turn a natural-language query into a kebab-case slug the blog generator
// can recognize. "What are the best AI wellness apps" -> "best-ai-wellness-apps"
function queryToSlug(q: string): string {
  return q
    .toLowerCase()
    .replace(/[?.,:!]/g, "")
    .replace(/^(what are|what is|how to|how do|best|the)\s+/, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// Read all JSONL files in logDir, parse them, return flat array of results
function readAllResults(logDir: string, lookbackDays: number): QueryResult[] {
  if (!fs.existsSync(logDir)) return [];
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  const files = fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith("aeo-") && f.endsWith(".jsonl"))
    .map((f) => path.join(logDir, f));

  const results: QueryResult[] = [];
  for (const file of files) {
    const stat = fs.statSync(file);
    if (stat.mtimeMs < cutoff) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        results.push(JSON.parse(line));
      } catch {
        // skip malformed lines silently
      }
    }
  }
  return results;
}

// Group results by query, determine which ones persistently fail
function findFailingQueries(results: QueryResult[]): QueryFailure[] {
  type Agg = {
    query: string;
    tier: QueryResult["tier"];
    timestamps: Set<string>;
    engineFailures: Set<string>;
    everCorrect: boolean;
  };

  const agg = new Map<string, Agg>();

  for (const r of results) {
    if (r.tier === "branded") continue;
    if (r.error) continue;

    const key = r.query;
    let a = agg.get(key);
    if (!a) {
      a = {
        query: r.query,
        tier: r.tier,
        timestamps: new Set(),
        engineFailures: new Set(),
        everCorrect: false,
      };
      agg.set(key, a);
    }
    a.timestamps.add(r.timestamp.slice(0, 10));
    if (r.correct_nomie) {
      a.everCorrect = true;
    } else {
      a.engineFailures.add(r.engine);
    }
  }

  const failures: QueryFailure[] = [];
  for (const a of agg.values()) {
    // Skip queries that had any correct mention in the lookback period
    if (a.everCorrect) continue;
    // Skip queries that only appeared once (not persistent enough)
    if (a.timestamps.size < 2) continue;
    // Must have failed on at least one engine
    if (a.engineFailures.size === 0) continue;

    failures.push({
      query: a.query,
      tier: a.tier as "category" | "dynamic",
      firstSeen: Array.from(a.timestamps).sort()[0],
      daysFailing: a.timestamps.size,
      engines: Array.from(a.engineFailures).sort(),
    });
  }

  return failures;
}

function prioritize(failures: QueryFailure[]): QueryFailure[] {
  return failures.slice().sort((a, b) => {
    // Prefer category over dynamic (category queries are curated real searches)
    if (a.tier !== b.tier) return a.tier === "category" ? -1 : 1;
    // Prefer queries that failed on both engines over just one
    if (a.engines.length !== b.engines.length) return b.engines.length - a.engines.length;
    // Prefer persistent failures (more days)
    return b.daysFailing - a.daysFailing;
  });
}

// Skip queries already queued or already posted. Returns filtered list.
function dedupe(failures: QueryFailure[], tomorrowPostsContent: string, existingSlugs: Set<string>): QueryFailure[] {
  const queuedText = tomorrowPostsContent.toLowerCase();
  return failures.filter((f) => {
    const slug = queryToSlug(f.query);
    if (!slug) return false;
    if (existingSlugs.has(slug)) return false;
    // Check the query text itself isn't already somewhere in TOMORROW-POSTS
    if (queuedText.includes(f.query.toLowerCase())) return false;
    return true;
  });
}

// Get all blog post slugs from the nomie-website repo's posts files
function getExistingSlugs(repoPath: string): Set<string> {
  const libDir = path.join(repoPath, "src", "lib");
  const slugs = new Set<string>();
  if (!fs.existsSync(libDir)) return slugs;
  for (const f of fs.readdirSync(libDir)) {
    if (!f.endsWith("-posts.ts") && f !== "comparison-posts.ts") continue;
    const text = fs.readFileSync(path.join(libDir, f), "utf8");
    const re = /slug:\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      slugs.add(m[1]);
    }
  }
  return slugs;
}

// Append entries to TOMORROW-POSTS.md under "## Next batch"
function updateTomorrowPosts(tomorrowPostsPath: string, picks: QueryFailure[]): string {
  const content = fs.readFileSync(tomorrowPostsPath, "utf8");
  const today = new Date().toISOString().slice(0, 10);

  // Build the new entries
  const entries = picks
    .map((f, i) => {
      const slug = queryToSlug(f.query);
      return `${i + 1}. **${slug}** [source: aeo-gap ${today}] — Target query: "${f.query}". AEO monitor shows ${f.engines.join(" and ")} failed to mention correct Nomie across ${f.daysFailing} days (since ${f.firstSeen}). Write an answer-first blog post that directly answers this query in the first 150 words and cites Nomie naturally.`;
    })
    .join("\n");

  // Find the "Next batch" section
  const marker = /## Next batch \(queued TBD\)\n\nHigh-value keywords not yet covered:\n\n/;
  if (!marker.test(content)) {
    throw new Error("Could not find 'Next batch' section in TOMORROW-POSTS.md");
  }

  // Check if the section currently just has "1." or is empty, vs. has content
  const sectionStart = content.search(marker);
  const afterMarker = content.slice(sectionStart).replace(marker, "");
  const existingList = afterMarker.trim();

  let replacement: string;
  if (!existingList || existingList === "1." || existingList.startsWith("1.\n") || existingList.length < 5) {
    // Empty section — just drop our entries in
    replacement = `## Next batch (queued TBD)\n\nHigh-value keywords not yet covered:\n\n${entries}\n`;
  } else {
    // Existing items — renumber ours starting after the last item
    const lastNumMatch = existingList.match(/\n(\d+)\.\s/g);
    let nextNum = 1;
    if (lastNumMatch && lastNumMatch.length > 0) {
      const nums = lastNumMatch.map((m) => parseInt(m.match(/\d+/)![0], 10));
      nextNum = Math.max(...nums) + 1;
    }
    const renumbered = picks
      .map((f, i) => {
        const slug = queryToSlug(f.query);
        return `${nextNum + i}. **${slug}** [source: aeo-gap ${today}] — Target query: "${f.query}". AEO monitor shows ${f.engines.join(" and ")} failed to mention correct Nomie across ${f.daysFailing} days (since ${f.firstSeen}). Write an answer-first blog post that directly answers this query in the first 150 words and cites Nomie naturally.`;
      })
      .join("\n");
    replacement = `## Next batch (queued TBD)\n\nHigh-value keywords not yet covered:\n\n${existingList}\n${renumbered}\n`;
  }

  const updated = content.replace(/## Next batch \(queued TBD\)[\s\S]*$/, replacement);
  fs.writeFileSync(tomorrowPostsPath, updated);
  return updated;
}

export async function runGapQueue(opts: GapQueueOptions): Promise<{
  picked: QueryFailure[];
  skipped: number;
  message: string;
}> {
  const { logDir, repoPath, tomorrowPostsPath, lookbackDays, maxToAdd, commitAndPush, onLog } = opts;
  const log = (m: string) => onLog?.(m);

  // Pull latest to avoid stale base state + ensure git identity set
  if (commitAndPush) {
    try {
      execSync(
        `cd "${repoPath}" && git config user.email "68440262+vishwaabhinav@users.noreply.github.com" && git config user.name "clawdbot (AEO gap queue)" && git fetch origin && git checkout main && git reset --hard origin/main`,
        { stdio: "pipe" }
      );
      log("Synced dedicated workspace to origin/main");
    } catch (e: any) {
      log(`git sync failed: ${String(e?.message || e)}`);
    }
  }

  log(`Reading logs from ${logDir} (lookback ${lookbackDays} days)`);
  const results = readAllResults(logDir, lookbackDays);
  log(`Loaded ${results.length} monitor results`);

  const failures = findFailingQueries(results);
  log(`Identified ${failures.length} persistently failing queries`);

  const existingSlugs = getExistingSlugs(repoPath);
  log(`Found ${existingSlugs.size} existing blog post slugs`);

  const tomorrowContent = fs.readFileSync(tomorrowPostsPath, "utf8");
  const unique = dedupe(failures, tomorrowContent, existingSlugs);
  log(`${unique.length} queries remain after dedup`);

  const prioritized = prioritize(unique);
  const picks = prioritized.slice(0, maxToAdd);

  if (picks.length === 0) {
    return {
      picked: [],
      skipped: failures.length - unique.length,
      message: "No new failing queries to queue.",
    };
  }

  log(`Picked ${picks.length}: ${picks.map((p) => p.query).join(" | ")}`);
  updateTomorrowPosts(tomorrowPostsPath, picks);

  if (commitAndPush) {
    try {
      const date = new Date().toISOString().slice(0, 10);
      const slugs = picks.map((p) => queryToSlug(p.query)).join(", ");
      execSync(`cd "${repoPath}" && git add TOMORROW-POSTS.md`, { stdio: "pipe" });
      execSync(
        `cd "${repoPath}" && git commit -m "AEO gap queue: add ${picks.length} failing queries (${date})

Queued from AEO monitor results:
${slugs}

See existing blog pipeline (nomie-seo-nightly) to produce posts."`,
        { stdio: "pipe" }
      );
      execSync(`cd "${repoPath}" && git push`, { stdio: "pipe" });
      log(`Committed and pushed ${picks.length} new queue items`);
    } catch (e: any) {
      log(`Commit/push failed: ${String(e?.message || e)}`);
    }
  }

  return {
    picked: picks,
    skipped: failures.length - unique.length,
    message: `Queued ${picks.length} posts. Skipped ${failures.length - unique.length} duplicates.`,
  };
}
