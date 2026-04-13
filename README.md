# AEO Monitor Plugin

A Clawdbot plugin that monitors whether AI engines (ChatGPT, Google Gemini) correctly describe the Nomie Wellness app when asked wellness/anxiety-related queries.

## What it does

Every day at a configured UTC time, queries OpenAI's GPT-4o-mini and Google's Gemini 2.5-flash with three tiers of questions:

- **Branded** (13 queries) — "What is Nomie app?", "Nomie vs Calm", etc. Must rank #1.
- **Category** (20 queries) — "Best anxiety journaling app", "Somatic breathing app", etc.
- **Dynamic** (10 queries) — GPT-4o-mini generates fresh queries each run.

For each response, checks whether `mynomie.com` appears in the output. This URL-based detection distinguishes the correct Nomie Wellness app from the deprecated open-source Nomie tracker (a common disambiguation problem in AI answers).

Posts a scorecard to Slack `#nomie-marketing` with day-over-day and week-over-week deltas.

## Architecture

Native TypeScript — no Python subprocess. Uses `axios` to call OpenAI and Gemini APIs directly.

```
index.ts              — plugin entry + scheduler + Slack posting
src/monitor.ts        — core query loop + scoring logic
src/csv.ts            — score history parsing
src/state.ts          — "already ran today" persistence
src/run.ts            — (legacy, unused)
```

## Config

| key | default | description |
|---|---|---|
| `runHourUtc` | 5 | Hour (UTC) to run daily |
| `runMinuteUtc` | 0 | Minute (UTC) |
| `logDir` | `/home/clawdbot/clawd/skills/aeo-monitor/logs` | CSV + JSONL output |
| `openaiApiKey` | — | GPT-4o-mini API key |
| `geminiApiKey` | — | Gemini API key |
| `slackBotToken` | — | Bot token for scorecard posting |
| `slackChannelId` | `C0ABW156NKX` | Target channel |
| `postEvenIfNoKeys` | false | Post error scorecard if no model keys |

## Output

- `logs/aeo-YYYY-MM-DD.jsonl` — one line per query (query, engine, response, correct_nomie, etc.)
- `logs/aeo-scores.csv` — daily summary for trend tracking

## Tools

- `aeo_monitor_run` — trigger an immediate run + Slack post (registered via `api.registerTool`)

## Build

```bash
npm install
npm run build       # tsc → dist/
```

## Why TypeScript?

Previously ran as a Python script called via subprocess. The plugin tried to parse mixed stdout (progress lines + JSON) and kept failing. Rewritten in TypeScript to eliminate the subprocess boundary and JSON parsing issues.
