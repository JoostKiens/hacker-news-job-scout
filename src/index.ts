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
  // Remove script/style noise
  root.querySelectorAll("script, style, nav, header, footer").forEach((el) => el.remove());
  // Get text, collapse whitespace
  return root.structuredText
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 80000); // cap to avoid huge context windows
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
- Location: Netherlands-based, leaving for Thailand Dec/Jan. Remote strongly preferred. Hybrid ok in NL/EU. No relocation.

SCORING (cap base score at 10, then add mission bonus):
Base score:
+3 React + TypeScript both mentioned
+3 GIS/mapping/spatial/Deck.gl/Mapbox/MapLibre mentioned
+2 data visualization/dashboards/D3/charting mentioned
+2 GLSL/WebGL shaders/custom map layers mentioned
+2 AI/LLM/Claude/MCP/agentic tooling mentioned
+2 Three.js/React Three Fiber/3D web mentioned
+3 async-first or async-friendly culture explicitly mentioned
+2 remote explicitly supported
+1 contract/freelance offered
+1 civic tech/open source/public interest mentioned
-2 requires onsite outside Netherlands
-3 no remote option at all

Mission bonus (max +3, stacks on top):
+3 climate/environment/biodiversity/conservation/sustainability
+2 science communication/open data/journalism tools/public health
+2 humanitarian tech/international development/civic infrastructure
+1 B-corp/non-profit/explicit social or environmental mission

RULES:
- Score ONLY based on what is explicitly written. Do not infer or assume.
- A score above 10 (before mission bonus) means you made an error — recheck.
- NEVER invent job postings. Only score what is in the provided text.

Return ONLY valid JSON in this exact shape, no markdown fences, no preamble:
{
  "month": "June 2026",
  "matches": [
    {
      "id": "HN comment ID (digits only) or 'CompanyName|RoleTitle' fallback",
      "company": "Company name",
      "role": "Role title",
      "type": "Full-time|Contract|Both",
      "location": "location string",
      "score": 8,
      "missionBonus": 3,
      "applyLink": "URL or email",
      "hnUrl": "https://news.ycombinator.com/item?id=XXXXXXXX or empty string",
      "whyItMatches": "2-3 sentences naming specific skill overlaps",
      "mission": "One sentence on mission fit, or empty string if purely commercial",
      "originalPosting": "Full verbatim text of the posting"
    }
  ],
  "closeMisses": [
    {
      "company": "Company name",
      "role": "Role title",
      "score": 5,
      "missionBonus": 0,
      "reason": "One sentence on why it didn't make the cut"
    }
  ]
}

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
  originalPosting: string;
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

async function scoreJobs(jobsText: string): Promise<ClaudeResult> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Here are the job postings from the HN hiring thread. Score them against my profile and return JSON.\n\n${jobsText}`,
      },
    ],
  });

  const raw = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  // Strip accidental markdown fences
  const clean = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();

  try {
    return JSON.parse(clean) as ClaudeResult;
  } catch {
    throw new Error(`Claude returned invalid JSON:\n${clean.slice(0, 500)}`);
  }
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
    lines.push("Original posting:");
    lines.push(m.originalPosting);
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
  const missing = ["ANTHROPIC_API_KEY", "RESEND_API_KEY"].filter((k) => !process.env[k]);
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
