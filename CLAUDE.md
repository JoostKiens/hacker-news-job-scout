# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Node.js/TypeScript script that runs on a schedule, fetches the HN "Who is Hiring?" thread, scores job postings against a hardcoded developer profile via Claude, deduplicates against previously seen jobs, and sends a digest email via Resend.

## Commands

```bash
npm install
npm run build      # tsc → dist/
npm run dev        # run directly via tsx (no compile step)
npm start          # run compiled dist/index.js
```

No test suite exists.

## Required environment variables

| Variable | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | Required |
| `RESEND_API_KEY` | Required |
| `TO_EMAIL` | Recipient address |
| `SEEN_IDS_PATH` | Optional; defaults to `/data/seen_ids.json` |

## Architecture

Everything lives in [src/index.ts](src/index.ts). The pipeline is linear:

1. **Fetch** — tries `https://nchelluri.github.io/hnjobs/` first, falls back to `https://hnjobs.emilburzo.com`. Validates the response contains `"hiring"` and is >5000 chars.
2. **Extract** — strips script/style/nav/header/footer nodes via `node-html-parser`, collapses whitespace, caps at 80,000 chars.
3. **Score** — sends extracted text to `claude-haiku-4-5` with `max_tokens: 8000`. The model returns JSON with `matches` (score + missionBonus ≥ 6) and `closeMisses` (score 4–5). The scoring rubric and developer profile are embedded in `SYSTEM_PROMPT` at the top of the file.
4. **Deduplicate** — filters matches whose `id` (HN comment ID or `"CompanyName|RoleTitle"` fallback) already exists in `seen_ids.json`.
5. **Email** — POSTs to `https://api.resend.com/emails` directly via `fetch` (no Resend SDK). On any failure, sends a failure notification email before exiting.
6. **Persist** — appends new IDs to `seen_ids.json`. In production (Railway), `/data` is a mounted persistent volume.

## Deployment

The Dockerfile builds the TypeScript and runs `dist/index.js`. The `/data` volume must be mounted persistently so `seen_ids.json` survives restarts. The container is intended to be triggered on a schedule (cron or Railway's scheduler).

## Key constraints

- Keep the end-to-end flow intact: any change must work with both `npm run dev` and `npm run build && npm start`.
- The developer profile and scoring weights inside `SYSTEM_PROMPT` are intentional — don't normalize or generalize them unless asked.
- `claude-haiku-4-5` is chosen for cost; only upgrade the model if accuracy is the explicit goal.
