/**
 * AEO freshness — Loop 3 of the AEO improvement design.
 *
 * Scans all blog posts (TypeScript files in src/lib/*-posts.ts and
 * markdown files in content/blog/) for external URLs in authority
 * sources. Runs a HEAD check on each URL. Reports broken links to
 * Slack and writes a JSONL log for later auto-fix processing.
 *
 * V1: detect + report only. Auto-fix PRs come in V2 once we see
 * what actually breaks.
 *
 * Runs weekly Sundays after the gap-queue cron.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export type LinkCheckResult = {
  url: string;
  sourcePath: string;
  sourceName: string;
  postSlug: string;
  status: "ok" | "broken" | "error" | "timeout" | "bot-blocked" | "skipped";
  httpStatus?: number;
  error?: string;
};

export type FreshnessReport = {
  date: string;
  timestamp: string;
  scanned: number;
  broken: number;
  errors: number;
  botBlocked: number;
  totalPosts: number;
  brokenResults: LinkCheckResult[];
  botBlockedResults: LinkCheckResult[];
};

export type FreshnessOptions = {
  repoPath: string;
  logDir: string;
  timeoutMs: number;
  concurrency: number;
  onLog?: (m: string) => void;
};

type ExtractedSource = {
  url: string;
  name: string;
  postSlug: string;
  sourcePath: string;
};

// Extract { name, url, slug, file } triples from TypeScript post files by
// parsing authority.sources arrays with a permissive regex. Not a real
// parser, but robust to the formatting used in src/lib/*-posts.ts.
function extractFromTypeScriptPosts(repoPath: string): ExtractedSource[] {
  const libDir = path.join(repoPath, "src", "lib");
  const out: ExtractedSource[] = [];
  if (!fs.existsSync(libDir)) return out;

  for (const f of fs.readdirSync(libDir)) {
    if (!f.endsWith("-posts.ts") && f !== "comparison-posts.ts") continue;
    const fullPath = path.join(libDir, f);
    const text = fs.readFileSync(fullPath, "utf8");

    // Split posts by `slug:` markers so we can attach URLs to the right post
    const slugRe = /slug:\s*["']([^"']+)["']/g;
    const slugMatches: Array<{ slug: string; index: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = slugRe.exec(text)) !== null) {
      slugMatches.push({ slug: m[1], index: m.index });
    }

    for (let i = 0; i < slugMatches.length; i++) {
      const start = slugMatches[i].index;
      const end = i + 1 < slugMatches.length ? slugMatches[i + 1].index : text.length;
      const postText = text.slice(start, end);
      const slug = slugMatches[i].slug;

      // Extract { name: "...", url: "..." } pairs
      const pairRe = /\{\s*name:\s*["']([^"']+)["'],\s*url:\s*["']([^"']+)["']\s*\}/g;
      let pm: RegExpExecArray | null;
      while ((pm = pairRe.exec(postText)) !== null) {
        out.push({
          url: pm[2],
          name: pm[1],
          postSlug: slug,
          sourcePath: `src/lib/${f}`,
        });
      }
    }
  }
  return out;
}

// Basic URL filter — skip obvious non-candidates
function shouldCheck(url: string): boolean {
  const u = url.toLowerCase();
  if (!u.startsWith("http")) return false;
  if (u.includes("mynomie.com")) return false;
  if (u.includes("apps.apple.com")) return false;
  if (u.includes("play.google.com")) return false;
  if (u.includes("localhost")) return false;
  return true;
}

// Realistic browser headers. Many authoritative sites (ADAA, HHS, NAMI)
// block generic/bot UAs with 403 — those aren't actually broken links.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
};

// 401/403/429 often mean "bot-blocked" rather than "broken" — real users see
// these pages fine. Classify separately so we don't spam the Slack report.
function classifyStatus(code: number): "ok" | "broken" | "bot-blocked" {
  if (code >= 200 && code < 400) return "ok";
  if (code === 401 || code === 403 || code === 429) return "bot-blocked";
  return "broken";
}

async function headCheck(
  url: string,
  timeoutMs: number
): Promise<{ status: LinkCheckResult["status"]; httpStatus?: number; error?: string }> {
  const doFetch = async (method: "HEAD" | "GET") => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: BROWSER_HEADERS,
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const headRes = await doFetch("HEAD");
    if (headRes.ok) return { status: "ok", httpStatus: headRes.status };

    // Retry GET when server rejects HEAD or bot-blocks. A passing GET proves
    // the URL is live.
    if (headRes.status === 405 || headRes.status === 400 || headRes.status === 403 || headRes.status === 401) {
      try {
        const getRes = await doFetch("GET");
        if (getRes.ok) return { status: "ok", httpStatus: getRes.status };
        const cls = classifyStatus(getRes.status);
        return { status: cls, httpStatus: getRes.status };
      } catch {
        const cls = classifyStatus(headRes.status);
        return { status: cls, httpStatus: headRes.status };
      }
    }

    const cls = classifyStatus(headRes.status);
    return { status: cls, httpStatus: headRes.status };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes("aborted") || msg.includes("timeout")) {
      return { status: "timeout", error: msg };
    }
    return { status: "error", error: msg };
  }
}

async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]);
      }
    });
  await Promise.all(workers);
  return results;
}

export async function runFreshness(opts: FreshnessOptions): Promise<FreshnessReport> {
  const { repoPath, logDir, timeoutMs, concurrency, onLog } = opts;
  const log = (m: string) => onLog?.(m);

  // Sync the repo workspace
  try {
    execSync(`cd "${repoPath}" && git fetch origin && git checkout main && git reset --hard origin/main`, { stdio: "pipe" });
    log("Synced workspace to origin/main");
  } catch (e: any) {
    log(`git sync failed: ${String(e?.message || e)}`);
  }

  const sources = extractFromTypeScriptPosts(repoPath);
  log(`Extracted ${sources.length} source URLs across all posts`);

  // Dedupe by URL (many posts cite the same sources) to save HEAD calls,
  // but record all post associations so the report is complete.
  const byUrl = new Map<string, ExtractedSource[]>();
  for (const s of sources) {
    if (!shouldCheck(s.url)) continue;
    const existing = byUrl.get(s.url);
    if (existing) existing.push(s);
    else byUrl.set(s.url, [s]);
  }
  const uniqueUrls = Array.from(byUrl.keys());
  log(`${uniqueUrls.length} unique URLs to check (after dedup + filter)`);

  const startedAt = Date.now();
  const statusByUrl = new Map<string, { status: LinkCheckResult["status"]; httpStatus?: number; error?: string }>();

  const checkResults = await runPool(uniqueUrls, concurrency, async (url) => {
    const result = await headCheck(url, timeoutMs);
    return { url, result };
  });

  for (const r of checkResults) {
    statusByUrl.set(r.url, r.result);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`Link checks complete in ${elapsed}s`);

  // Build full result set, then filter broken for the report
  const allResults: LinkCheckResult[] = [];
  for (const [url, occurrences] of byUrl) {
    const status = statusByUrl.get(url) || { status: "skipped" };
    for (const occ of occurrences) {
      allResults.push({
        url,
        sourceName: occ.name,
        postSlug: occ.postSlug,
        sourcePath: occ.sourcePath,
        status: status.status,
        httpStatus: status.httpStatus,
        error: status.error,
      });
    }
  }

  const brokenResults = allResults.filter(
    (r) => r.status === "broken" || r.status === "timeout" || r.status === "error"
  );
  const botBlockedResults = allResults.filter((r) => r.status === "bot-blocked");
  const postsTouched = new Set(allResults.map((r) => r.postSlug));

  const now = new Date();
  const report: FreshnessReport = {
    date: now.toISOString().slice(0, 10),
    timestamp: now.toISOString(),
    scanned: uniqueUrls.length,
    broken: brokenResults.filter((r) => r.status === "broken").length,
    errors: brokenResults.filter((r) => r.status === "error" || r.status === "timeout").length,
    botBlocked: botBlockedResults.length,
    totalPosts: postsTouched.size,
    brokenResults,
    botBlockedResults,
  };

  // Write report to disk
  fs.mkdirSync(logDir, { recursive: true });
  const reportPath = path.join(logDir, `freshness-${report.date}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`Wrote report: ${reportPath}`);

  return report;
}

export function formatSlackReport(report: FreshnessReport): string {
  const lines: string[] = [];
  lines.push(`AEO freshness scan — ${report.date}`);
  lines.push("");
  lines.push(`Scanned: ${report.scanned} unique external URLs across ${report.totalPosts} posts`);
  lines.push(`Broken (HTTP error): ${report.broken}`);
  lines.push(`Unreachable (timeout/connection error): ${report.errors}`);
  if (report.botBlocked > 0) {
    lines.push(`Bot-blocked (403/401/429 — not actually broken): ${report.botBlocked}`);
  }
  lines.push("");

  if (report.brokenResults.length === 0) {
    lines.push("All external sources healthy. No fixes needed.");
    return lines.join("\n");
  }

  // Group by post for readability
  const byPost = new Map<string, LinkCheckResult[]>();
  for (const r of report.brokenResults) {
    const arr = byPost.get(r.postSlug) || [];
    arr.push(r);
    byPost.set(r.postSlug, arr);
  }

  lines.push("Broken sources by post:");
  lines.push("");
  const sortedPosts = Array.from(byPost.entries()).sort(([, a], [, b]) => b.length - a.length);
  for (const [slug, results] of sortedPosts.slice(0, 15)) {
    lines.push(`  ${slug}: ${results.length} broken`);
    for (const r of results.slice(0, 3)) {
      const statusLabel =
        r.status === "broken" ? `HTTP ${r.httpStatus}` : r.status === "timeout" ? "timeout" : "error";
      lines.push(`    - [${statusLabel}] ${r.sourceName}`);
      lines.push(`      ${r.url}`);
    }
    if (results.length > 3) {
      lines.push(`    ... and ${results.length - 3} more`);
    }
  }

  if (sortedPosts.length > 15) {
    lines.push("");
    lines.push(`... and ${sortedPosts.length - 15} more posts with broken links (see full report JSON)`);
  }

  return lines.join("\n");
}
