# AI Agent Instructions for hacker-news-job-scout

## Repository purpose
This is a small Node.js/TypeScript service that:
- fetches the Hacker News "Who is Hiring?" job thread HTML
- extracts the job posting text
- sends the text to Anthropic Claude for scoring against a senior web developer profile
- formats a digest email and sends it via Resend
- persists seen job IDs to avoid duplicate notifications

## Key files
- `package.json` – build and runtime scripts, dependencies.
- `tsconfig.json` – compile target is `commonjs`, output to `dist`, strict TypeScript.
- `Dockerfile` – container runtime support.
- `src/index.ts` – main application logic, includes fetch, parsing, Claude scoring, email formatting, and persistence.

## Build and run
Use these commands when working in this repo:
- `npm install`
- `npm run build` to compile TypeScript to `dist`
- `npm run dev` to run directly from source with `tsx`
- `npm start` to run the compiled `dist/index.js`

## Runtime environment
The app expects these environment variables:
- `ANTHROPIC_API_KEY`
- `RESEND_API_KEY`
- `TO_EMAIL`
- `SEEN_IDS_PATH` (optional, defaults to `/data/seen_ids.json`)

## Important details
- The repository does not currently include automated tests.
- The application runs in Node.js and depends on built-in `fetch` support.
- Keep changes minimal and focused: this is a single-purpose job scouting script.
- When editing `src/index.ts`, ensure runtime behavior remains compatible with both `npm run dev` and `npm run build && npm start`.

## Guidance for AI agents
- Prefer small, safe changes that preserve the existing end-to-end flow.
- Do not add unrelated architecture or feature scaffolding unless the user explicitly asks.
- If a new documentation file is needed, add only repository-specific guidance, not broad TypeScript or Node.js tutorials.
