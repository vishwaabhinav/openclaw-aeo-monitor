// @ts-ignore - Plugin SDK types resolved at runtime
type ClawdbotPluginApi = any;

import path from "node:path";
import axios from "axios";
import { loadState, saveState } from "./src/state.js";
import { readScores, type ScoreRow } from "./src/csv.js";
import { runMonitor, type Summary } from "./src/monitor.js";
import { runGapQueue, type GapQueueOptions } from "./src/gap-queue.js";
import { runFreshness, formatSlackReport, type FreshnessOptions } from "./src/freshness.js";

type Config = {
  runHourUtc: number;
  runMinuteUtc: number;
  logDir: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  slackBotToken?: string;
  slackChannelId: string;
  postEvenIfNoKeys: boolean;
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function deltaLine(label: string, cur: number, prev?: number) {
  if (prev === undefined) return `${label}: ${cur}%`;
  const d = cur - prev;
  const sign = d > 0 ? "+" : "";
  return `${label}: ${cur}% (${sign}${d.toFixed(0)}pp)`;
}

function formatSlackMessage(args: {
  score: { overall: number; branded: number; category: number; dynamic?: number };
  engines?: Record<string, { score: number; correct: number; mentioned_wrong: number; total: number }>;
  date: string;
  dailyPrev?: ScoreRow;
  weeklyPrev?: ScoreRow;
  csvPath: string;
}): string {
  const { score, engines, date, dailyPrev, weeklyPrev, csvPath } = args;

  const lines: string[] = [];
  lines.push(`AEO scorecard — ${date}`);
  lines.push("");

  if (dailyPrev) {
    lines.push("vs yesterday:");
    lines.push(`  ${deltaLine("Overall", score.overall, dailyPrev.overall)}`);
    lines.push(`  ${deltaLine("Branded", score.branded, dailyPrev.branded)}`);
    lines.push(`  ${deltaLine("Category", score.category, dailyPrev.category)}`);
    if (score.dynamic !== undefined) {
      lines.push(`  ${deltaLine("Dynamic", score.dynamic, dailyPrev.dynamic)}`);
    }
    lines.push("");
  }

  if (weeklyPrev) {
    lines.push("vs 7d ago:");
    lines.push(`  ${deltaLine("Overall", score.overall, weeklyPrev.overall)}`);
    lines.push(`  ${deltaLine("Branded", score.branded, weeklyPrev.branded)}`);
    lines.push(`  ${deltaLine("Category", score.category, weeklyPrev.category)}`);
    if (score.dynamic !== undefined) {
      lines.push(`  ${deltaLine("Dynamic", score.dynamic, weeklyPrev.dynamic)}`);
    }
    lines.push("");
  }

  lines.push("today:");
  lines.push(`  Overall: ${score.overall}% correct`);
  lines.push(`  Branded: ${score.branded}% correct`);
  lines.push(`  Category: ${score.category}% correct`);
  if (score.dynamic !== undefined) lines.push(`  Dynamic: ${score.dynamic}% correct`);

  if (engines) {
    lines.push("");
    lines.push("by engine:");
    for (const [name, s] of Object.entries(engines)) {
      lines.push(`  ${name}: ${s.score}% correct (${s.correct}/${s.total}) [wrong Nomie: ${s.mentioned_wrong}]`);
    }
  }

  lines.push("");
  lines.push("(correct = mynomie.com URL appears in response — distinguishes from old open-source Nomie)");
  lines.push(`(source: ${csvPath})`);
  return lines.join("\n");
}

async function postToSlack(token: string, channel: string, text: string) {
  const r = await axios.post(
    "https://slack.com/api/chat.postMessage",
    { channel, text },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 30_000 }
  );
  if (!r.data?.ok) throw new Error(r.data?.error || "slack_post_failed");
}

function getPrevRows(rows: ScoreRow[]): { prev?: ScoreRow; week?: ScoreRow } {
  if (rows.length === 0) return {};
  const prev = rows.length >= 2 ? rows[rows.length - 2] : undefined;
  const week = rows.length >= 8 ? rows[rows.length - 8] : undefined;
  return { prev, week };
}

const plugin = {
  id: "aeo-monitor",
  name: "AEO Monitor",
  description: "Daily AEO visibility scorecard for Nomie (TypeScript native)",

  register(api: ClawdbotPluginApi) {
    const cfg = api.pluginConfig || {};
    const baseDir = path.dirname(new URL(import.meta.url).pathname);

    const getConfig = (): Config => {
      return {
        runHourUtc: cfg.runHourUtc ?? 11,
        runMinuteUtc: cfg.runMinuteUtc ?? 0,
        logDir: cfg.logDir ?? "/home/clawdbot/clawd/skills/aeo-monitor/logs",
        openaiApiKey: cfg.openaiApiKey ?? process.env.OPENAI_API_KEY,
        geminiApiKey: cfg.geminiApiKey ?? process.env.GEMINI_API_KEY,
        slackBotToken: cfg.slackBotToken ?? process.env.SLACK_BOT_TOKEN,
        slackChannelId: cfg.slackChannelId ?? "C0ABW156NKX",
        postEvenIfNoKeys: cfg.postEvenIfNoKeys ?? false,
      };
    };

    const log = (m: string) => console.log(`[aeo-monitor] ${m}`);

    // Guard against concurrent runs
    let running = false;

    const runAndPost = async (): Promise<{ ok: boolean; summary?: Summary; error?: string }> => {
      const config = getConfig();
      const date = todayUtc();

      try {
        const { summary } = await runMonitor({
          openaiApiKey: config.openaiApiKey,
          geminiApiKey: config.geminiApiKey,
          logDir: config.logDir,
          onProgress: log,
        });

        // NOTE: plugin originally used aeo-scores-v2.csv, but production writes aeo-scores.csv
        // (legacy headerless CSV). Keep pointing at the canonical file.
        const csvPath = path.join(config.logDir, "aeo-scores.csv");
        const rows = readScores(csvPath);
        const { prev, week } = getPrevRows(rows);

        const score = {
          overall: summary.overall_score,
          branded: summary.branded_score,
          category: summary.category_score,
          dynamic: summary.dynamic_score,
        };

        const text = formatSlackMessage({
          score,
          engines: summary.engines,
          date,
          dailyPrev: prev,
          weeklyPrev: week,
          csvPath,
        });

        if (config.slackBotToken) {
          await postToSlack(config.slackBotToken, config.slackChannelId, text);
        }

        return { ok: true, summary };
      } catch (e: any) {
        const err = String(e?.message || e);
        log(`Monitor run failed: ${err}`);
        if (config.slackBotToken) {
          const msg = `AEO scorecard — ${date}\n\nERROR: monitor run failed (${err}).`;
          try {
            await postToSlack(config.slackBotToken, config.slackChannelId, msg);
          } catch (postErr: any) {
            log(`Failed to post error to Slack: ${postErr?.message || postErr}`);
          }
        }
        return { ok: false, error: err };
      }
    };

    const tick = async () => {
      if (running) {
        return; // guard against overlap
      }

      const config = getConfig();
      const state = loadState(baseDir);
      const now = new Date();
      const date = todayUtc();

      const isTime =
        now.getUTCHours() === config.runHourUtc && now.getUTCMinutes() === config.runMinuteUtc;
      const alreadyRan = state.lastRunDateUtc === date;

      if (!isTime || alreadyRan) return;

      // Mark state IMMEDIATELY so a long-running monitor doesn't re-trigger
      state.lastRunDateUtc = date;
      saveState(baseDir, state);

      if (!config.slackBotToken) {
        log("No slackBotToken configured; skipping post.");
        return;
      }

      const hasKey = Boolean(config.openaiApiKey || config.geminiApiKey);
      if (!hasKey && !config.postEvenIfNoKeys) {
        await postToSlack(
          config.slackBotToken,
          config.slackChannelId,
          `AEO scorecard — ${date}\n\nERROR: no OPENAI/GEMINI API keys configured for aeo-monitor plugin.`
        );
        return;
      }

      running = true;
      try {
        log(`Running monitor for ${date}...`);
        await runAndPost();
        log("Posted daily scorecard.");
      } finally {
        running = false;
      }
    };

    api.registerService({
      id: "aeo-monitor-daily",
      name: "aeo-monitor-daily",
      start: async () => {
        log("Starting daily scheduler (runs at HH:MM UTC, polls every 60s)");
        void tick();
        const interval = setInterval(() => void tick(), 60_000);
        (globalThis as any).__AEO_MONITOR_INTERVAL__ = interval;
      },
      stop: async () => {
        log("Stopping daily scheduler");
        const interval = (globalThis as any).__AEO_MONITOR_INTERVAL__;
        if (interval) clearInterval(interval);
      },
    });

    api.registerTool({
      name: "aeo_monitor_run",
      description: "Run AEO monitor now and post scorecard to Slack",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        if (running) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "already running" }, null, 2) }],
          };
        }
        running = true;
        try {
          const res = await runAndPost();
          if (res.ok) {
            const score = {
              overall: res.summary?.overall_score,
              branded: res.summary?.branded_score,
              category: res.summary?.category_score,
              dynamic: res.summary?.dynamic_score,
            };
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: true, score }, null, 2) }],
              details: { ok: true, score },
            };
          } else {
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: false, error: res.error }, null, 2) }],
            };
          }
        } finally {
          running = false;
        }
      },
    });

    // Gap queue tool — feed failing AEO queries into TOMORROW-POSTS.md
    api.registerTool({
      name: "aeo_gap_queue_run",
      description: "Read AEO monitor failures and queue them as blog targets in TOMORROW-POSTS.md",
      parameters: {
        type: "object",
        properties: {
          dryRun: { type: "boolean", description: "If true, do not commit or push" },
          maxToAdd: { type: "number", description: "Max queries to queue (default 3)" },
        },
        required: [],
      },
      async execute(args: { dryRun?: boolean; maxToAdd?: number }) {
        const config = getConfig();
        const dryRun = Boolean(args?.dryRun);
        const maxToAdd = args?.maxToAdd ?? 3;

        const opts: GapQueueOptions = {
          logDir: config.logDir,
          repoPath: "/home/clawdbot/.clawdbot/extensions/aeo-monitor/data/nomie-website",
          tomorrowPostsPath: "/home/clawdbot/.clawdbot/extensions/aeo-monitor/data/nomie-website/TOMORROW-POSTS.md",
          lookbackDays: 7,
          maxToAdd,
          commitAndPush: !dryRun,
          onLog: (m: string) => log(`[gap-queue] ${m}`),
        };

        try {
          const result = await runGapQueue(opts);
          const slackText = [
            `AEO gap queue — ${new Date().toISOString().slice(0, 10)}`,
            "",
            result.message,
            ...(result.picked.length > 0
              ? [
                  "",
                  "Queued:",
                  ...result.picked.map((p) => `  - ${p.query} (${p.tier}, failed ${p.daysFailing}d on ${p.engines.join(" + ")})`),
                  "",
                  "The existing nomie-seo-nightly cron will pick these up.",
                ]
              : []),
          ].join("\n");

          if (!dryRun && config.slackBotToken) {
            await postToSlack(config.slackBotToken, config.slackChannelId, slackText);
          }

          // Explicit summary so a Claude agent running this cron does not
          // double-commit or "fix" the output. The tool already pushed.
          const agentNotice = result.committed
            ? `SUCCESS. The plugin committed ${result.commitSha?.slice(0, 7)} and pushed to origin/main in its dedicated workspace. DO NOT make any additional commits or pushes for this task. The work is complete.`
            : dryRun
              ? "DRY RUN — no commit made. This was intentional. No further action needed."
              : "NOTE: commit/push step reported no action (likely nothing to queue). DO NOT commit anything manually — this tool owns TOMORROW-POSTS.md.";

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: true,
                    agentNotice,
                    committed: result.committed,
                    commitSha: result.commitSha,
                    pushed: result.pushed,
                    branch: result.branch,
                    picked: result.picked,
                    skipped: result.skipped,
                    message: result.message,
                  },
                  null,
                  2
                ),
              },
            ],
            details: { ok: true, picked: result.picked.length, committed: result.committed, sha: result.commitSha },
          };
        } catch (e: any) {
          const err = String(e?.message || e);
          log(`[gap-queue] error: ${err}`);
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: err }, null, 2) }],
          };
        }
      },
    });

    // Freshness tool — scan external source URLs in blog posts for broken links
    api.registerTool({
      name: "aeo_freshness_check",
      description: "Scan blog post authority.sources URLs for broken/dead links and report to Slack",
      parameters: {
        type: "object",
        properties: {
          timeoutMs: { type: "number", description: "Per-request timeout in ms (default 10000)" },
          concurrency: { type: "number", description: "Parallel HEAD checks (default 8)" },
          dryRun: { type: "boolean", description: "If true, do not post to Slack" },
        },
        required: [],
      },
      async execute(args: { timeoutMs?: number; concurrency?: number; dryRun?: boolean }) {
        const config = getConfig();
        const dryRun = Boolean(args?.dryRun);

        const opts: FreshnessOptions = {
          repoPath: "/home/clawdbot/.clawdbot/extensions/aeo-monitor/data/nomie-website",
          logDir: config.logDir,
          timeoutMs: args?.timeoutMs ?? 10_000,
          concurrency: args?.concurrency ?? 8,
          onLog: (m: string) => log(`[freshness] ${m}`),
        };

        try {
          const report = await runFreshness(opts);
          const slackText = formatSlackReport(report);

          if (!dryRun && config.slackBotToken) {
            await postToSlack(config.slackBotToken, config.slackChannelId, slackText);
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: true,
                    scanned: report.scanned,
                    broken: report.broken,
                    errors: report.errors,
                    totalPosts: report.totalPosts,
                  },
                  null,
                  2
                ),
              },
            ],
            details: { ok: true, broken: report.broken, errors: report.errors },
          };
        } catch (e: any) {
          const err = String(e?.message || e);
          log(`[freshness] error: ${err}`);
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: err }, null, 2) }],
          };
        }
      },
    });
  },
};

export default plugin;
