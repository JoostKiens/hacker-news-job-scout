import Anthropic from "@anthropic-ai/sdk";
import { parse } from "node-html-parser";
import fs from "fs";
import path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const TO_EMAIL = process.env.TO_EMAIL;
const SEEN_IDS_PATH = process.env.SEEN_IDS_PATH ?? "/data/seen_ids.json";

const PRIMARY_URL = "https://nchelluri.github.io/hnjobs/";
const FALLBACK_URL = "https://hnjobs.emilburzo.com";

// ─── Seen IDs persistence ────────────────────────────────────────────────────

function loadSeenIds(): Set<string> {
  try {
    if (fs.existsSync(SEEN_IDS_PATH)) {
      const raw = fs.readFileSync(SEEN_IDS_PATH, "utf-8");
      return new Set(JSON.parse(raw));
    }
  } catch (e) {
    console.warn("Could not load seen_ids, starting fresh:", e);
  }
  return new Set();
}

function saveSeenIds(ids: Set<string>): void {
  const dir = path.dirname(SEEN_IDS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SEEN_IDS_PATH, JSON.stringify([...ids]), "utf-8");
}

// ─── Fetch jobs page ─────────────────────────────────────────────────────────

async function fetchJobsPage(): Promise<string> {
  for (const url of [PRIMARY_URL, FALLBACK_URL]) {
    try {
      console.log(`Fetching ${url}...`);
      const res = await fetch(url, {
        headers: { "User-Agent": "hn-job-scout/1.0" },
      });
      if (!res.ok) {
        console.warn(`${url} returned ${res.status}`);
        continue;
      }
      const html = await res.text();
      // Sanity check: does it contain job-like content?
      if (html.length > 5000 && html.includes("hiring")) {
        console.log(`Got content from ${url} (${html.length} chars)`);
        return html;
      }
      console.warn(`${url} returned HTML but no job content`);
    } catch (e) {
      console.warn(`Failed to fetch ${url}:`, e);
    }
  }
  throw new Error("Both job listing URLs failed");
}

// ─── Extract plain text from HTML ───────────────────────────────────────────

function extractJobsText(html: string): string {
  const root = parse(html);
  root.querySelectorAll("script, style, nav, header, footer").forEach((el) => el.remove());
  // Inline all link URLs so Claude can copy real URLs instead of hallucinating them
  root.querySelectorAll("a[href]").forEach((el) => {
    const href = el.getAttribute("href") ?? "";
    if (href) el.replaceWith(`${el.text} [${href}]`);
  });
  return root.structuredText
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 500000);
}

// ─── Claude scoring ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a job scout assistant for a senior developer.
Analyse the HN "Who is Hiring?" job postings provided and return a JSON response.

PROFILE:
- WebGIS & mapping: Deck.gl, Mapbox GL JS, MapLibre, Google Maps API, ArcGIS Maps SDK, Mapbox Vector Tiles, PMTiles, OpenLayers, Leaflet, PostGIS, Turf.js, GeoJSON, WMS/WFS/OGC, GLSL shaders, Google Earth Engine
- Data visualization: D3.js, Visx, Observable, Vega-Lite, Recharts, dashboards, charting, scientific dataviz, SVG, canvas
- Frontend (must-have): React, TypeScript, Next.js, Three.js, React Three Fiber, PixiJS, WebGL, Tailwind, design systems, Storybook, Radix UI, Framer Motion, GSAP
- AI & tooling: Claude Code, MCP servers, hooks, agentic workflows, LLM integration, streaming AI
- Backend (supporting): Node.js, Fastify, PostGIS, Redis, Supabase, Python
- Seniority: Senior preferred, open to lead/staff
- Type: Full-time OR contract/freelance
- Location: Netherlands-based (CET/CEST = GMT+1/+2), splitting time with Thailand (ICT = GMT+7). Remote required globally. Hybrid ok only in NL/EU. No relocation. No US/Canadian work authorization — cannot accept roles restricted to US/Canada/Americas residency or work auth.

SCORING (cap base score at 10, then add mission bonus):
Base score:
+3 React + TypeScript both mentioned
+3 GIS/mapping/spatial/Deck.gl/Mapbox/MapLibre mentioned
+3 data visualization/dashboards/D3/charting mentioned
+3 GLSL/WebGL shaders/custom map layers mentioned
+2 AI/LLM/Claude/MCP/agentic tooling mentioned
+3 Three.js/React Three Fiber/3D web mentioned
+3 async-first or async-friendly culture explicitly mentioned
+2 remote explicitly and globally supported ("work from anywhere", "worldwide", no geo restriction stated) — rewards genuine flexibility beyond just passing the location filter
+2 Node.js mentioned as a primary backend language
+1 Python mentioned as a backend language
+1 contract/freelance offered
+1 civic tech/open source/public interest mentioned
-2 requires onsite outside Netherlands

Mission bonus (max +3, stacks on top):
+3 climate/environment/biodiversity/conservation/sustainability
+2 science communication/open data/journalism tools/public health
+2 humanitarian tech/international development/civic infrastructure
+1 B-corp/non-profit/explicit social or environmental mission

RULES:
- Score ONLY based on what is explicitly written. Do not infer or assume.
- A score above 10 (before mission bonus) means you made an error — recheck.
- NEVER invent job postings. Only score what is in the provided text.
- URLs (applyLink, hnUrl) must be copied exactly and completely from the source text — never truncate or add "...". The source text contains links in the format "link text [url]"; use the url inside the brackets. For hnUrl, use the URL from the "Original Post [url]" marker. If no URL is found, return an empty string.

LOCATION FILTER — assume geographic restriction unless the posting explicitly says otherwise.
Only pass a posting if it clearly meets one of:
- "Remote" or "Fully remote" with no geographic qualifier (bare "Remote" on HN = assume global)
- Remote with an explicit EU/Europe/worldwide/global qualifier
- Onsite or hybrid with an office in the Netherlands or EU (Paris, Amsterdam, Berlin, Warsaw, etc. are EU; Seattle, SF, NYC, Boston, Toronto are NOT EU)

Everything else is EXCLUDED. "Remote (US)", "Remote (US/Canada)", "SF (Hybrid or Remote)",
"US-Based / Remote", a US/Canadian city with no global-remote clause — all EXCLUDED.
When in doubt, exclude.

STACK FILTER — two hard conditions, both must pass:
1. JavaScript or TypeScript must be explicitly mentioned as a primary language of the role.
   If the posting does not mention JS or TS at all, or only mentions them as a footnote, EXCLUDE it.
   Roles whose core stack is Python, Rust, Go, Java, Kotlin, C++, C#, Swift, Ruby, PHP with no
   JS/TS frontend work described are EXCLUDED.
2. The role must be frontend or full-stack. Roles titled or described as "Backend Engineer",
   "Platform Engineer", "Infrastructure Engineer", "Data Engineer", "DevOps", "ML Engineer",
   "Perception Engineer", "GEO-AI Engineer", "Radar Engineer", etc. with no frontend component
   described are EXCLUDED. "Product Engineer", "Software Engineer", "Full-Stack Engineer",
   "Senior/Staff Engineer" are fine.

FILTER ENFORCEMENT — this is critical:
- Any posting that fails LOCATION FILTER must NOT appear in matches. Period.
- Any posting that fails STACK FILTER must NOT appear in matches. Period.
- If you find yourself writing "this should be excluded but..." in a match — stop. Move it to close misses or omit it.
- Close misses are for postings that passed both filters but scored only 4–5.

Call the report_jobs tool with your results.
Only include matches with score + missionBonus >= 6.
Include 1-2 close misses (score 4-5 before disqualification).
Sort matches by (score + missionBonus) descending.`;

interface JobMatch {
  id: string;
  company: string;
  role: string;
  type: string;
  location: string;
  score: number;
  missionBonus: number;
  applyLink: string;
  hnUrl: string;
  whyItMatches: string;
  mission: string;
}

interface CloseMiss {
  company: string;
  role: string;
  score: number;
  missionBonus: number;
  reason: string;
}

interface ClaudeResult {
  month: string;
  matches: JobMatch[];
  closeMisses: CloseMiss[];
}

const REPORT_JOBS_TOOL: Anthropic.Messages.Tool = {
  name: "report_jobs",
  description: "Submit the scored and filtered job matches",
  input_schema: {
    type: "object",
    properties: {
      month: { type: "string" },
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            company: { type: "string" },
            role: { type: "string" },
            type: { type: "string" },
            location: { type: "string" },
            score: { type: "integer" },
            missionBonus: { type: "integer" },
            applyLink: { type: "string" },
            hnUrl: { type: "string" },
            whyItMatches: { type: "string" },
            mission: { type: "string" },
          },
          required: ["id", "company", "role", "type", "location", "score", "missionBonus", "applyLink", "hnUrl", "whyItMatches", "mission"],
        },
      },
      closeMisses: {
        type: "array",
        items: {
          type: "object",
          properties: {
            company: { type: "string" },
            role: { type: "string" },
            score: { type: "integer" },
            missionBonus: { type: "integer" },
            reason: { type: "string" },
          },
          required: ["company", "role", "score", "missionBonus", "reason"],
        },
      },
    },
    required: ["month", "matches", "closeMisses"],
  },
};

async function scoreJobs(jobsText: string): Promise<ClaudeResult> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools: [REPORT_JOBS_TOOL],
    tool_choice: { type: "tool", name: "report_jobs" },
    messages: [
      {
        role: "user",
        content: `Here are the job postings from the HN hiring thread. Score them against my profile and call report_jobs with the results.\n\n${jobsText}`,
      },
    ],
  });

  const toolUse = message.content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Model did not call the report_jobs tool");
  }
  return toolUse.input as ClaudeResult;
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function filterSeen(result: ClaudeResult, seenIds: Set<string>): ClaudeResult {
  const matches = result.matches.filter((m) => !seenIds.has(m.id));
  return { ...result, matches };
}

function collectNewIds(matches: JobMatch[]): string[] {
  return matches.map((m) => m.id);
}

// ─── Format email ────────────────────────────────────────────────────────────

function formatEmail(result: ClaudeResult, runDate: string): { subject: string; text: string } {
  const count = result.matches.length;
  const subject =
    count > 0
      ? `HN Job Scout — ${result.month} · ${count} new match${count === 1 ? "" : "es"}`
      : `HN Job Scout — ${result.month} · no new matches`;

  const lines: string[] = [];
  lines.push(
    count > 0
      ? `Found ${count} new match${count === 1 ? "" : "es"} in the ${result.month} HN hiring thread.`
      : `No new matches in the ${result.month} HN hiring thread.`
  );
  lines.push("");

  for (const m of result.matches) {
    const total = m.score + m.missionBonus;
    const scoreStr =
      m.missionBonus > 0 ? `${m.score}/10 + ${m.missionBonus} mission = ${total}` : `${m.score}/10`;
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`${m.company} · ${m.role}`);
    lines.push(`Score:    ${scoreStr}`);
    lines.push(`Type:     ${m.type}`);
    lines.push(`Location: ${m.location}`);
    lines.push(`Apply:    ${m.applyLink || "(see original posting)"}`);
    lines.push(`HN:       ${m.hnUrl || "(no direct link)"}`);
    lines.push("");
    lines.push(`Why it matches: ${m.whyItMatches}`);
    if (m.mission) lines.push(`Mission: ${m.mission}`);
    lines.push("");
  }

  if (result.closeMisses?.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push("CLOSE MISSES");
    for (const m of result.closeMisses) {
      lines.push(`• ${m.company} · ${m.role} (${m.score}/10) — ${m.reason}`);
    }
    lines.push("");
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Run date: ${runDate}`);
  lines.push(`Source: https://nchelluri.github.io/hnjobs/`);

  return { subject, text: lines.join("\n") };
}

// ─── Send email via Resend ───────────────────────────────────────────────────

async function sendEmail(subject: string, text: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "onboarding@resend.dev",
      to: [TO_EMAIL],
      subject,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }

  console.log("Email sent successfully");
}

async function sendFailureEmail(error: string, runDate: string): Promise<void> {
  await sendEmail(`HN Job Scout — fetch failed ${runDate}`, `Scout run failed on ${runDate}.\n\nError: ${error}`).catch(
    (e) => console.error("Could not send failure email:", e)
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const runDate = new Date().toISOString().split("T")[0];
  console.log(`\nHN Job Scout — ${runDate}`);

  // Validate env
  const missing = ["ANTHROPIC_API_KEY", "RESEND_API_KEY", "TO_EMAIL"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  // Load seen IDs
  const seenIds = loadSeenIds();
  console.log(`Loaded ${seenIds.size} previously seen job IDs`);

  // Fetch jobs
  let html: string;
  try {
    html = await fetchJobsPage();
  } catch (e) {
    console.error("Fetch failed:", e);
    await sendFailureEmail(String(e), runDate);
    process.exit(1);
  }

  // Extract text
  const jobsText = extractJobsText(html);
  console.log(`Extracted ${jobsText.length} chars of job content`);

  // Score via Claude
  console.log("Scoring jobs via Claude...");
  let result: ClaudeResult;
  try {
    result = await scoreJobs(jobsText);
    console.log(`Claude returned ${result.matches.length} matches, ${result.closeMisses?.length ?? 0} close misses`);
  } catch (e) {
    console.error("Claude scoring failed:", e);
    await sendFailureEmail(String(e), runDate);
    process.exit(1);
  }

  // Deduplicate
  const deduplicated = filterSeen(result, seenIds);
  const newCount = deduplicated.matches.length;
  console.log(`After deduplication: ${newCount} new matches`);

  // Format + send
  const { subject, text } = formatEmail(deduplicated, runDate);
  console.log(`Sending: "${subject}"`);
  try {
    await sendEmail(subject, text);
  } catch (e) {
    console.error("Email send failed:", e);
    process.exit(1);
  }

  // Persist new IDs
  const newIds = collectNewIds(deduplicated.matches);
  newIds.forEach((id) => seenIds.add(id));
  saveSeenIds(seenIds);
  console.log(`Saved ${newIds.length} new IDs (total: ${seenIds.size})`);

  console.log("Done.");
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
