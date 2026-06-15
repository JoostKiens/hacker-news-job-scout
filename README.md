# HN Job Scout

A scheduled script that reads the Hacker News "Who is Hiring?" thread, scores each posting against a developer profile using Claude, deduplicates against previously seen postings, and sends a plain-text digest email via Resend.

## How it works

1. **Fetch** — pulls the current HN hiring thread from `nchelluri.github.io/hnjobs` (falls back to `hnjobs.emilburzo.com`)
2. **Extract** — strips boilerplate HTML and inlines link URLs so Claude sees real apply links, not hallucinated ones
3. **Score** — sends the text to Claude Sonnet with a hardcoded rubric: base score (React/TS, GIS/mapping, dataviz, WebGL/shaders, AI tooling, remote) plus a mission bonus (climate, science, civic tech). Hard filters exclude non-EU-remote roles and non-frontend/full-stack stacks
4. **Deduplicate** — filters out any job IDs already stored in `seen_ids.json`
5. **Email** — sends a formatted digest (matches with scores + links, close misses) via the Resend API
6. **Persist** — appends new IDs to `seen_ids.json` so future runs don't repeat them

## Setup

```bash
npm install
```

Copy `.env.example` to `.env.local` and set:

```
ANTHROPIC_API_KEY=...
RESEND_API_KEY=...
TO_EMAIL=you@example.com
SEEN_IDS_PATH=./data/seen_ids.json   # optional, defaults to /data/seen_ids.json
```

## Running

```bash
npm run dev        # run directly via tsx (development)
npm run build      # compile TypeScript → dist/
npm start          # run compiled output
```

## Deployment

The repo includes a Dockerfile. Build and run it with the required environment variables and a persistent volume mounted at `/data` so `seen_ids.json` survives restarts:

```bash
docker build -t hn-job-scout .
docker run --rm \
  -e ANTHROPIC_API_KEY=... \
  -e RESEND_API_KEY=... \
  -e TO_EMAIL=you@example.com \
  -v hn-scout-data:/data \
  hn-job-scout
```

Intended to run on a schedule (cron, Railway scheduler, etc.) — every 3 days.

## Customisation

The scoring rubric and developer profile live in the `SYSTEM_PROMPT` constant at the top of [src/index.ts](src/index.ts). Edit the profile skills, score weights, location filter, and stack filter there to match your own criteria.
