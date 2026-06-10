import * as https from "node:https";
import * as http from "node:http";
import * as fs from "node:fs";
import * as zlib from "node:zlib";
import {
  initialize,
  MidiClip,
  MidiTrack,
  AudioTrack,
  DrumRack,
  ClipSlot,
  Device,
  Simpler,
  RackDevice,
  DrumChain,
  type ActivationContext,
  type Handle,
  type NoteDescription,
} from "@ableton-extensions/sdk";

import promptUI from "./prompt.html";
import analysisUI from "./analysis.html";

// ─── Skill knowledge packs (bundled as text via esbuild .md loader) ──────────
import skillCore        from "./skills/_core.md";
import skillDrums       from "./skills/drums.md";
import skillHipHop      from "./skills/hiphop.md";
import skillHouse       from "./skills/house.md";
import skillReggaeton   from "./skills/reggaeton.md";
import skillMelody      from "./skills/melody.md";
import skillBass        from "./skills/bass.md";
import skillSoundDesign from "./skills/sound-design.md";

const MODEL = "gpt-5.5";

// ─── Skill registry & selector ────────────────────────────────────────────────
// Skills are externalized musical knowledge. The selector picks which skills to
// inject based on (a) the track's role and (b) keywords in the user's prompt.
// _core is ALWAYS loaded. This keeps each prompt focused instead of dumping
// every rule into one giant system message.

interface Skill {
  id:       string;
  content:  string;
  keywords: RegExp; // matched against the user prompt to auto-include
}

const SKILLS: Skill[] = [
  { id: "drums",       content: skillDrums,       keywords: /drum|beat|kick|snare|hat|hi-?hat|percussion|groove|fill|808|clap/i },
  { id: "hiphop",      content: skillHipHop,      keywords: /hip.?hop|boom.?bap|trap|lo.?fi|lofi|rap|drill|j.?dilla|mpc/i },
  { id: "house",       content: skillHouse,       keywords: /house|techno|four.?on.?the.?floor|deep house|tech house|edm|dance|club|rave/i },
  { id: "reggaeton",   content: skillReggaeton,   keywords: /reggaeton|dembow|perreo|urbano|latin.?urban|rkt|bad.?bunny|j.?balvin|maluma|latin.?trap|latino/i },
  { id: "melody",      content: skillMelody,      keywords: /melod|lead|hook|topline|riff|chord|harmon|progression|counter|arp/i },
  { id: "bass",        content: skillBass,        keywords: /bass|808|sub|low.?end|bassline/i },
  { id: "sound-design", content: skillSoundDesign, keywords: /warm|bright|dark|dusty|gritty|punch|airy|pad|pluck|smooth|glassy|metallic|bell|sub|lead|synth|sound.?design|wavetable|operator|simpler|filter|cutoff|reverb|delay|attack|decay|sustain|release|envelope|lfo|resonan|saturat|compress/i },
];

type TrackRole = "drums" | "bass" | "chords" | "melody" | "unknown";

/** Infer a track's musical role from its name (for skill selection). */
function inferTrackRole(trackName: string, isDrum: boolean): TrackRole {
  if (isDrum) return "drums";
  const n = trackName.toLowerCase();
  if (/bass|808|sub/.test(n))                              return "bass";
  if (/chord|pad|keys|piano|organ|rhodes|stab/.test(n))    return "chords";
  if (/lead|melody|hook|top|arp|riff|pluck|synth/.test(n)) return "melody";
  return "unknown";
}

/**
 * Select and concatenate the relevant skill packs for this generation.
 * _core is always included. Role-based + keyword-based skills are added.
 */
function selectSkills(opts: { role: TrackRole; prompt: string }): string {
  const chosen = new Set<string>();

  // Role always pulls its matching skill
  if (opts.role === "drums")  chosen.add("drums");
  if (opts.role === "bass")   chosen.add("bass");
  if (opts.role === "melody") chosen.add("melody");
  if (opts.role === "chords") chosen.add("melody"); // chords use the melody/harmony skill

  // Keyword matches from the prompt (e.g. "trap beat" → hiphop + drums)
  for (const skill of SKILLS) {
    if (skill.keywords.test(opts.prompt)) chosen.add(skill.id);
  }

  // Assemble: _core first, then the selected packs in a stable order
  const order = ["drums", "bass", "melody", "hiphop", "house", "reggaeton", "sound-design"];
  const parts = [skillCore];
  for (const id of order) {
    if (chosen.has(id)) {
      const s = SKILLS.find((x) => x.id === id);
      if (s) parts.push(s.content);
    }
  }

  return parts.join("\n\n───────────────────────────────────────────\n\n");
}

// ─── Lightweight OpenAI HTTPS client ─────────────────────────────────────────

type Role = "system" | "user" | "assistant" | "tool";

interface Message {
  role: Role;
  content: string | null;
  // assistant messages may carry tool calls; tool messages carry their id
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    strict?: boolean;
    parameters: Record<string, unknown>;
  };
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
}

function chatCompletion(opts: {
  messages: Message[];
  tools?: ToolDef[];
  tool_choice?: "auto" | "required" | "none";
}): Promise<ChatResponse> {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return reject(new Error("OPENAI_API_KEY is not set in .env"));

    const body = JSON.stringify({
      model: MODEL,
      messages: opts.messages,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}),
    });

    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(raw) as ChatResponse & { error?: { message: string } };
            if (parsed.error) return reject(new Error(`AI Copilot API error: ${parsed.error.message}`));
            if ((res.statusCode ?? 200) >= 400)
              return reject(new Error(`AI Copilot HTTP ${res.statusCode}: ${raw}`));
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse OpenAI response: ${raw}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Web access: fetch a URL and return readable text ─────────────────────────
// Uses node:http / node:https directly (the Extension Host sandbox has no fetch).
// Follows redirects, caps size, strips HTML to plain text so the model gets
// readable content instead of markup.

const MAX_FETCH_BYTES = 200_000; // ~200KB cap so we don't blow the context window

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function httpGetText(url: string, redirectsLeft = 4): Promise<string> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error(`Invalid URL: ${url}`));
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return reject(new Error(`Only http/https URLs are allowed (got ${parsed.protocol})`));
    }

    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   "GET",
        headers: {
          "User-Agent": "AI-Copilot-Ableton/1.0 (+https://github.com)",
          "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
        },
        timeout: 15_000,
      },
      (res) => {
        const status = res.statusCode ?? 0;

        // Follow redirects
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain
          if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
          const next = new URL(res.headers.location, url).toString();
          return resolve(httpGetText(next, redirectsLeft - 1));
        }
        if (status >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${status} fetching ${url}`));
        }

        const contentType = String(res.headers["content-type"] ?? "");
        let raw = "";
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= MAX_FETCH_BYTES) raw += chunk.toString("utf8");
          else res.destroy(); // stop reading once we hit the cap
        });
        res.on("end", () => {
          const isHtml = /text\/html|application\/xhtml/i.test(contentType);
          const text = isHtml ? stripHtmlToText(raw) : raw;
          const capped = text.length > MAX_FETCH_BYTES ? text.slice(0, MAX_FETCH_BYTES) : text;
          resolve(capped || "(empty response)");
        });
        res.on("close", () => {
          if (bytes > MAX_FETCH_BYTES && raw) {
            const isHtml = /text\/html|application\/xhtml/i.test(contentType);
            resolve((isHtml ? stripHtmlToText(raw) : raw).slice(0, MAX_FETCH_BYTES));
          }
        });
      },
    );

    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on("error", reject);
    req.end();
  });
}

// The tool the model calls to read a web page during generation.
const FETCH_URL_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "fetch_url",
    description:
      "Fetch a web page or API endpoint and return its readable text content. " +
      "Use this to research drum patterns, chord progressions, scales, genre conventions, " +
      "or any musical reference the user points you to. HTML is stripped to plain text. " +
      "Call this BEFORE generating notes if a URL or online reference is relevant, then apply what you learned.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["url", "reason"],
      properties: {
        url:    { type: "string", description: "Full http(s) URL to fetch." },
        reason: { type: "string", description: "Why you are fetching this (what you hope to learn)." },
      },
    },
  },
};

/**
 * Agentic chat loop. Adds fetch_url to the toolset and resolves any fetch_url
 * calls locally, feeding results back to the model, until the model either:
 *   - calls one of the "terminal" generation tools (set_notes, set_drum_pattern…), or
 *   - returns with no tool call.
 * Returns the final assistant message (with its terminal tool_calls).
 *
 * `onProgress` lets the caller surface "Reading <url>…" in the progress dialog.
 */
async function runGeneration(opts: {
  messages: Message[];
  tools: ToolDef[];               // the terminal generation tools
  tool_choice?: "auto" | "required" | "none";
  allowWeb?: boolean;             // include fetch_url in the toolset
  maxWebFetches?: number;         // safety cap on number of fetches
  onProgress?: (label: string) => void;
}): Promise<ChatResponse> {
  const terminalNames = new Set(opts.tools.map((t) => t.function.name));
  const tools = opts.allowWeb ? [...opts.tools, FETCH_URL_TOOL] : opts.tools;
  const messages: Message[] = [...opts.messages];

  const maxFetches = opts.maxWebFetches ?? 6;
  let fetches = 0;

  // Up to (maxFetches + 2) round-trips so the model can browse then generate.
  for (let iter = 0; iter < maxFetches + 2; iter++) {
    // While the model is still browsing we must allow it to NOT call a terminal
    // tool, so only force tool_choice once web is disabled or fetches exhausted.
    const choice =
      opts.allowWeb && fetches < maxFetches ? "auto" : (opts.tool_choice ?? "required");

    const response = await chatCompletion({ messages, tools, tool_choice: choice });
    const msg = response.choices[0]?.message;
    const calls = msg?.tool_calls ?? [];

    const fetchCalls    = calls.filter((c) => c.function.name === "fetch_url");
    const terminalCalls = calls.filter((c) => terminalNames.has(c.function.name));

    // If the model produced a terminal generation call, we're done.
    if (terminalCalls.length > 0) return response;

    // If it asked to fetch URLs, resolve them and loop.
    if (fetchCalls.length > 0 && fetches < maxFetches) {
      // Record the assistant message that requested the tools
      messages.push({ role: "assistant", content: msg?.content ?? null, tool_calls: calls });

      for (const call of fetchCalls) {
        if (fetches >= maxFetches) break;
        fetches++;
        let url = "";
        try {
          const args = JSON.parse(call.function.arguments) as { url: string; reason?: string };
          url = args.url;
          opts.onProgress?.(`Reading ${new URL(url).hostname}…`);
          const text = await httpGetText(url);
          const trimmed = text.length > 12_000 ? text.slice(0, 12_000) + "\n…(truncated)" : text;
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: "fetch_url",
            content: `Fetched ${url}:\n\n${trimmed}`,
          });
          console.log(`[AI Copilot] fetch_url → ${url} (${text.length} chars)`);
        } catch (e) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: "fetch_url",
            content: `Failed to fetch ${url}: ${(e as Error).message}`,
          });
          console.warn(`[AI Copilot] fetch_url failed: ${url} — ${(e as Error).message}`);
        }
      }
      continue; // ask the model again now that it has the page content
    }

    // No terminal call and no fetch — model chose not to call any tool (only possible on "auto" choice).
    // Add its reasoning to context and continue — once fetches are exhausted, choice becomes "required"
    // and the model is forced to call a terminal tool rather than silently returning nothing.
    if (msg?.content) {
      messages.push({ role: "assistant", content: msg.content });
    }
    continue;
  }

  // Exhausted iterations: force one final generation pass with web disabled.
  return chatCompletion({ messages, tools: opts.tools, tool_choice: opts.tool_choice ?? "required" });
}

// ─── Generic agentic loop ─────────────────────────────────────────────────────
// Unlike runGeneration (which stops at the first "terminal" tool call), runAgent
// executes EVERY tool call through a handler, feeds the result back, and loops
// until the model stops calling tools — i.e. until it decides the user's whole
// request is fulfilled. This is what lets one prompt chain multiple actions:
// "generate hip hop drums and add glue and saturation" → create_drum_clip →
// insert_devices → set_device_params → final text summary.

interface AgentTool {
  def: ToolDef;
  /** Execute the call and return the string fed back to the model as the tool result. */
  handler: (args: Record<string, unknown>) => Promise<string>;
}

async function runAgent(opts: {
  messages: Message[];
  tools: AgentTool[];
  maxIterations?: number;
  onProgress?: (label: string) => void;
  abortSignal?: { aborted: boolean };
}): Promise<string | null> {
  const messages = [...opts.messages];
  const defs     = opts.tools.map((t) => t.def);
  const max      = opts.maxIterations ?? 10;

  for (let iter = 0; iter < max; iter++) {
    if (opts.abortSignal?.aborted) return null;

    // First round must act; afterwards the model may stop (text = goal reached).
    const tool_choice = iter === 0 ? "required" : "auto";
    const response = await chatCompletion({ messages, tools: defs, tool_choice });
    const msg   = response.choices[0]?.message;
    const calls = msg?.tool_calls ?? [];

    if (calls.length === 0) {
      console.log(`[AI Copilot] agent finished after ${iter} step(s): ${msg?.content ?? "(no summary)"}`);
      return msg?.content ?? null;
    }

    messages.push({ role: "assistant", content: msg?.content ?? null, tool_calls: calls });

    for (const call of calls) {
      if (opts.abortSignal?.aborted) return null;
      const tool = opts.tools.find((t) => t.def.function.name === call.function.name);
      let content: string;
      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        content = tool
          ? await tool.handler(args)
          : `Unknown tool "${call.function.name}" — available: ${defs.map((d) => d.function.name).join(", ")}`;
      } catch (e) {
        content = `Tool "${call.function.name}" failed: ${(e as Error).message}`;
        console.warn(`[AI Copilot] agent tool ${call.function.name} error: ${(e as Error).message}`);
      }
      console.log(`[AI Copilot] agent step ${iter + 1}: ${call.function.name} → ${content.split("\n")[0]}`);
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content });
    }
  }

  console.warn(`[AI Copilot] agent hit the ${max}-iteration cap — stopping.`);
  return null;
}

// ─── Drum helpers ─────────────────────────────────────────────────────────────

const GM_DRUM_MAP = `
Standard MIDI drum pitches (General MIDI + common Ableton defaults):
  36 = Kick (Bass Drum)       38 = Snare           39 = Clap
  40 = Snare (rim/tight)      42 = Hi-Hat Closed   44 = Hi-Hat Pedal
  46 = Hi-Hat Open            49 = Crash Cymbal     51 = Ride Cymbal
  41 = Low Floor Tom          43 = High Floor Tom   45 = Low Tom
  47 = Low-Mid Tom            48 = Hi-Mid Tom       50 = High Tom
  37 = Side Stick / Rimshot
Use these unless you can see different pitches in the existing clip notes.
`;

// Injected into every drum system prompt. Without this, the model has been
// observed snapping drum pitches to the song's scale ("kick C, snare D, clap E…"),
// which lands hits on arbitrary pads instead of the right sounds.
const DRUM_PITCH_RULE = [
  "CRITICAL — DRUM PITCHES ARE PAD ADDRESSES, NOT MUSICAL NOTES:",
  "On a drum track, the MIDI pitch number only selects WHICH PAD (sound) plays.",
  "It has zero harmonic meaning. Key, scale, and Scale Mode NEVER apply to drums.",
  "Ignore the Key/Scale line in the session overview when writing drum patterns.",
  "Choose pads by their NAME in the pad map (kick, snare, hat…) — never by pitch class.",
  "Snapping drum pitches to a scale puts hits on wrong or empty pads and ruins the beat.",
].join("\n");

interface DrumHit {
  pitch:    number; // MIDI pitch
  beat:     number; // position within the bar in beats (0.0–3.99)
  velocity: number;
}

interface DrumPatternResult {
  base_pattern:    { hits: DrumHit[] };
  variation_bars:  Array<{ bar_index: number; hits: DrumHit[] }>;
  reasoning:       string;
}

/**
 * Find the DrumRack on a track, looking INSIDE Instrument/audio-effect Racks.
 * Ableton pack kits (e.g. "1-Sticks Kit") are frequently an Instrument Rack
 * wrapping a DrumRack — a top-level-only check misses them, which silently
 * routes drum tracks down the melody path (scale snap + density clamp then
 * destroy the pattern).
 */
function findDrumRack(
  devices: Device<"1.0.0">[],
  depth = 0,
): DrumRack<"1.0.0"> | null {
  if (depth > 4) return null; // racks can nest; don't recurse forever
  for (const device of devices) {
    if (device instanceof DrumRack) return device;
    if (device instanceof RackDevice) {
      for (const chain of device.chains) {
        const found = findDrumRack(chain.devices, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/** True if the track has a DrumRack device loaded (including nested in Racks) */
function isDrumTrack(track: MidiTrack<"1.0.0">): boolean {
  return findDrumRack(track.devices) !== null;
}

/**
 * Log how a track was classified (drum vs melodic) and why — device class
 * names included. This is the breadcrumb for diagnosing routing mistakes
 * like a drum clip being generated through the melody pipeline.
 */
function logTrackRouting(tag: string, track: MidiTrack<"1.0.0"> | undefined): void {
  if (!track) {
    console.warn(
      `[AI Copilot] ⚠️ ${tag}: parent track NOT FOUND — falling back to the melody pipeline. ` +
      `If this clip is on a drum track, the pattern will be scale-snapped and density-clamped (bad).`,
    );
    return;
  }
  const deviceNames = track.devices.map((d) => d.constructor?.name ?? "Device").join(", ") || "(no devices)";
  const drum = isDrumTrack(track);
  console.log(
    `[AI Copilot] ${tag}: track "${track.name}" routed as ${drum ? "DRUMS" : "MELODIC"} ` +
    `(top-level devices: ${deviceNames})`,
  );
}

/**
 * Read the actual pad-to-pitch mapping from the DrumRack on this track.
 * Returns a formatted string like:
 *   Pad map (from your DrumRack — use THESE pitches, not GM defaults):
 *     36 (C1)  = Kick
 *     38 (D1)  = Snare
 *     42 (F#1) = Hi-Hat Closed
 *   ...
 * Falls back to the generic GM map if no DrumRack is found.
 */
/**
 * Find the sample loaded in a pad by walking its devices for a Simpler
 * (descending into nested racks). Returns the sample file's base name,
 * e.g. "Kick-808-SubLong", or null if no sample is found.
 */
function findPadSampleName(devices: Device<"1.0.0">[], depth = 0): string | null {
  if (depth > 3) return null;
  for (const device of devices) {
    if (device instanceof Simpler && device.sample) {
      const file = device.sample.filePath.split(/[\\/]/).pop() ?? "";
      const base = file.replace(/\.[^.]+$/, "").trim();
      if (base) return base;
    }
    if (device instanceof RackDevice) {
      for (const chain of device.chains) {
        const found = findPadSampleName(chain.devices, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Human-readable label for a drum pad. SDK chains have NO name property —
 * the label must come from the devices inside the pad: the loaded sample's
 * file name first, then the instrument device's name, else "(empty pad)".
 */
function describeDrumPad(chain: DrumChain<"1.0.0">): string {
  const sampleName = findPadSampleName(chain.devices);
  if (sampleName) return sampleName;
  const deviceName = (chain.devices[0]?.name ?? "").trim();
  if (deviceName) return deviceName;
  return "(empty pad)";
}

// Tracks the last pad map logged per track so the console shows the pad info
// once per kit (and again whenever the kit changes), not on every prompt build.
const lastLoggedPadMaps = new Map<string, string>();

function readDrumPadMap(track: MidiTrack<"1.0.0">): string {
  const drumRack = findDrumRack(track.devices);
  if (!drumRack || drumRack.chains.length === 0) {
    if (lastLoggedPadMaps.get(track.name) !== "GM_FALLBACK") {
      lastLoggedPadMaps.set(track.name, "GM_FALLBACK");
      console.warn(
        `[AI Copilot] ⚠️ pad info → LLM for "${track.name}": no DrumRack found (or it has no pads) — ` +
        `sending the GENERIC GM drum map. If this track has a kit, the LLM is guessing pitches blind.`,
      );
    }
    return GM_DRUM_MAP; // fallback
  }

  const lines: string[] = [
    "Pad map (read directly from YOUR DrumRack — use THESE exact pitches, ignore GM defaults):",
  ];

  // Sort chains by receivingNote so it reads low→high (kick first)
  const sorted = [...drumRack.chains].sort((a, b) => a.receivingNote - b.receivingNote);

  for (const chain of sorted) {
    if (chain.devices.length === 0) continue; // empty pad — no sound, don't offer it to the model
    const note  = chain.receivingNote;
    const name  = pitchToName(note);
    lines.push(`  ${note.toString().padStart(3)} (${name.padEnd(4)}) = ${describeDrumPad(chain)}`);
  }

  lines.push("");
  lines.push("When generating hits, always use the pitch numbers from this table above.");

  const result = lines.join("\n");

  // Log exactly what the LLM will see, deduped per track until the kit changes.
  if (lastLoggedPadMaps.get(track.name) !== result) {
    lastLoggedPadMaps.set(track.name, result);
    console.log(
      `[AI Copilot] pad info → LLM for "${track.name}" (${sorted.length} pads):\n${result}`,
    );
  }

  return result;
}

/**
 * Diagnostic logging for every drum generation. Logs the model's reasoning,
 * which pads each pitch actually lands on, and — most importantly — warns
 * loudly when a generated pitch has NO pad in the DrumRack (the hit will be
 * silent or land on an unintended sound). This is how we catch failures like
 * the model snapping drum pitches to the song's scale.
 */
function logDrumPadUsage(
  tag: string,
  pitches: number[],
  track?: MidiTrack<"1.0.0">,
  extraLines: string[] = [],
): void {
  // Build pitch → pad-name map from the track's DrumRack (if present)
  const padNames = new Map<number, string>();
  const drumRack = track ? findDrumRack(track.devices) : null;
  if (drumRack) {
    for (const chain of drumRack.chains) {
      if (chain.devices.length === 0) continue; // empty pads aren't valid targets
      padNames.set(chain.receivingNote, describeDrumPad(chain));
    }
  }

  const counts = new Map<number, number>();
  for (const pitch of pitches) {
    const p = Math.round(pitch);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }

  const lines: string[] = [`[AI Copilot] ${tag} — drum generation diagnostics:`];
  lines.push(...extraLines);
  lines.push("  Pad usage:");

  const unknownPitches: number[] = [];
  for (const [pitch, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (padNames.size > 0) {
      const pad = padNames.get(pitch);
      if (pad) {
        lines.push(`    ${pitch} (${pitchToName(pitch)}) → "${pad}" ×${count}`);
      } else {
        lines.push(`    ${pitch} (${pitchToName(pitch)}) → ⚠️ NO PAD AT THIS PITCH ×${count}`);
        unknownPitches.push(pitch);
      }
    } else {
      lines.push(`    ${pitch} (${pitchToName(pitch)}) ×${count} (no DrumRack to verify against)`);
    }
  }
  console.log(lines.join("\n"));

  if (unknownPitches.length > 0) {
    console.warn(
      `[AI Copilot] ⚠️ ${tag}: ${unknownPitches.length} pitch(es) [${unknownPitches.join(", ")}] ` +
      `have NO pad in the DrumRack — those hits are silent or wrong. ` +
      `This usually means the model ignored the pad map (e.g. snapped drum pitches to the song scale).`,
    );
  }
}

function logDrumGeneration(
  tag: string,
  result: DrumPatternResult,
  track?: MidiTrack<"1.0.0">,
): void {
  const allHits = [
    ...result.base_pattern.hits,
    ...result.variation_bars.flatMap((v) => v.hits),
  ];
  const extra: string[] = [];
  if (result.reasoning) extra.push(`  Model reasoning: ${result.reasoning}`);
  extra.push(`  Base hits: ${result.base_pattern.hits.length}, variation bars: ${result.variation_bars.length}`);
  logDrumPadUsage(tag, allHits.map((h) => h.pitch), track, extra);
}

/**
 * Expand a bar-based drum pattern into flat NoteDescription[].
 * Bar 1 (index 0) repeats every 4 beats; variation_bars override specific bars.
 */
function expandDrumPattern(
  result: DrumPatternResult,
  totalBeats: number,
): NoteDescription[] {
  const totalBars = Math.round(totalBeats / 4);
  const notes: NoteDescription[] = [];

  for (let bar = 0; bar < totalBars; bar++) {
    const variation = result.variation_bars.find((v) => v.bar_index === bar);

    // ── ADDITIVE: base_pattern always plays. variation_bars ADD extra hits on top.
    // This guarantees kick and snare never drift — they always come from base_pattern.
    // variation_bars are only for fills, crashes, and accents — never replacements.
    const hits = variation
      ? [...result.base_pattern.hits, ...variation.hits]
      : result.base_pattern.hits;

    // Deduplicate: if variation adds a hit at the same pitch+beat as base, keep
    // the variation's velocity (it's intentional) and drop the base duplicate.
    const seen = new Map<string, DrumHit>();
    for (const hit of hits) {
      const key = `${Math.round(hit.pitch)}_${hit.beat.toFixed(3)}`;
      if (!seen.has(key) || seen.get(key)!.velocity < hit.velocity) {
        seen.set(key, hit);
      }
    }

    // Safety net: deduplicate snare-family stacking at the same beat.
    // GM snare family: 37 (Side Stick), 38 (Acoustic Snare), 39 (Clap), 40 (Electric Snare).
    // If two pitches from this family land at the same beat (within 0.005 beats), the lower-
    // velocity one is dropped — two snare-type sounds at the same position create phasing/doubling.
    const SNARE_FAMILY = new Set([37, 38, 39, 40]);
    const snareFamilyByBeat = new Map<string, DrumHit>(); // beatKey → winning hit
    for (const [key, hit] of seen) {
      const roundedPitch = Math.round(hit.pitch);
      if (!SNARE_FAMILY.has(roundedPitch)) continue;
      const beatKey = hit.beat.toFixed(3);
      const existing = snareFamilyByBeat.get(beatKey);
      if (!existing) {
        snareFamilyByBeat.set(beatKey, hit);
      } else if (hit.velocity > existing.velocity) {
        // Current hit wins — remove the previous lower-velocity entry
        seen.delete(`${Math.round(existing.pitch)}_${existing.beat.toFixed(3)}`);
        snareFamilyByBeat.set(beatKey, hit);
      } else {
        // Existing hit wins — drop the current one
        seen.delete(key);
      }
    }

    for (const hit of seen.values()) {
      const clampedBeat = Math.max(0, Math.min(3.99, hit.beat));
      notes.push({
        pitch:     Math.round(hit.pitch),
        startTime: bar * 4 + clampedBeat,
        duration:  0.125, // drums are always percussive — short duration
        velocity:  Math.max(1, Math.min(127, Math.round(hit.velocity))),
        muted:     false,
      });
    }
  }

  return notes;
}

const SET_DRUM_PATTERN_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "set_drum_pattern",
    description:
      "Set a drum pattern using a bar-repeating structure. " +
      "You define ONE base bar (base_pattern) — it plays on EVERY bar, no exceptions. " +
      "variation_bars are ADDITIVE: they ADD extra hits on top of the base pattern for specific bars. " +
      "The base kick and snare always play — variation_bars only add fills, crashes, or accents. " +
      "NEVER put kick/snare in variation_bars thinking they will replace the base — they won't, they stack.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["base_pattern", "variation_bars", "reasoning"],
      properties: {
        base_pattern: {
          type: "object",
          description: "The 1-bar pattern that repeats throughout the whole clip.",
          additionalProperties: false,
          required: ["hits"],
          properties: {
            hits: {
              type: "array",
              description: "All drum hits within one bar (4 beats). beat=0 is beat 1, beat=1 is beat 2, etc.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["pitch", "beat", "velocity"],
                properties: {
                  pitch:    { type: "number", description: "MIDI drum pitch — see GM drum map" },
                  beat:     { type: "number", description: "Position within bar in beats: 0.0=beat1 | 1.0=beat2 | 2.0=beat3 | 3.0=beat4 | 0.5=&1 | 0.25=e1 | 0.75=a1" },
                  velocity: { type: "number", description: "Velocity 60-127. Accent downbeats (kick/snare) higher than hi-hats." },
                },
              },
            },
          },
        },
        variation_bars: {
          type: "array",
          description:
            "ADDITIVE extra hits for specific bars — stacked ON TOP of base_pattern, not replacing it. " +
            "Use for: crash on bar 1, snare rolls on bar 4, extra kick on breakdown bar. " +
            "The base kick and snare always play from base_pattern — do NOT re-add them here. " +
            "0-based bar index. Leave empty [] if no fills needed.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["bar_index", "hits"],
            properties: {
              bar_index: { type: "number", description: "0-based bar to override (0=bar1, 1=bar2 …)" },
              hits: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["pitch", "beat", "velocity"],
                  properties: {
                    pitch:    { type: "number" },
                    beat:     { type: "number" },
                    velocity: { type: "number" },
                  },
                },
              },
            },
          },
        },
        reasoning: {
          type: "string",
          description: "Describe the groove, what pitches you used for kick/snare/hat, and any variations.",
        },
      },
    },
  },
};

// ─── Phrasing rules injected into every melody prompt ────────────────────────
// These are the core rules that prevent dense, note-packed output.

const MELODY_RULES = `
CRITICAL MELODY PHRASING RULES — follow these exactly:

1. SILENCE IS MUSIC. A good hip-hop melody is 30-50% notes, 50-70% silence.
   Rests are NOT written — they are the ABSENCE of notes. Create silence by
   leaving gaps between notes. Gap = next.startTime - (prev.startTime + prev.duration).
   Every gap > 0 is a rest. Never let the next note start exactly where the previous ends.

2. PHRASE STRUCTURE. Think in phrases of 1-2 bars. After each phrase, leave
   at least 1 full beat of silence (gap ≥ 1.0) before the next phrase starts.
   A 4-bar section should have 2-4 phrases, not 16 bars of continuous notes.

3. NOTE DENSITY. Target 3-7 notes per bar maximum for a melody.
   Never exceed 10 notes per bar. Most bars in hip-hop melody have 2-5 notes.

4. NOTE DURATION. Mix short notes (0.25-0.5 beats) with longer ones (1-2 beats).
   End phrases on notes held for 0.5 beats or longer. Never use duration < 0.125.

5. VELOCITY HUMANIZATION. Never use the same velocity twice in a row.
   Range: 60-110. Downbeats: 90-110. Weak beats: 60-85. Vary every note.

6. BEFORE WRITING NOTES: plan your phrase_plan first — list each phrase's
   bar range and the gap after it. Then generate notes that fit that plan.
`;

// ─── Tool definitions ─────────────────────────────────────────────────────────

const SET_NOTES_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "set_notes",
    description:
      "Replace all MIDI notes in the clip. " +
      "Pitch = MIDI number (60=C4, 61=C#4 … 72=C5). Timing in beats (4 beats = 1 bar). " +
      "IMPORTANT: Silence/rests = gaps between notes. If note A ends at beat 2.5 and " +
      "note B starts at beat 4.0, beats 2.5-4.0 are a rest. Never butt notes directly " +
      "against each other unless intentional (legato). For melodies, always leave gaps.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["phrase_plan", "notes", "reasoning"],
      properties: {
        phrase_plan: {
          type: "string",
          description:
            "PLAN YOUR PHRASES FIRST before placing notes. Write out each phrase: " +
            "e.g. 'Phrase 1: bars 1-2 (beats 0-8), gap of 1 beat. Phrase 2: bars 3-4 (beats 9-16), gap of 2 beats.' " +
            "This forces intentional spacing and prevents continuous note walls.",
        },
        notes: {
          type: "array",
          description:
            "MIDI notes. Each note must have a gap after it unless explicitly legato. " +
            "For a melody: 3-7 notes per bar, velocities varied (60-110), " +
            "mix short (0.25) and long (1-2 beat) durations.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["pitch", "startTime", "duration", "velocity", "muted"],
            properties: {
              pitch:     { type: "number", description: "MIDI pitch 0-127" },
              startTime: { type: "number", description: "Start in beats from clip start" },
              duration:  { type: "number", description: "Duration in beats — keep shorter than the gap to the next note" },
              velocity:  { type: "number", description: "Velocity 60-110, vary every note" },
              muted:     { type: "boolean", description: "Is note muted?" },
            },
          },
        },
        reasoning: { type: "string", description: "Brief musical explanation of your choices." },
      },
    },
  },
};

const RENAME_CLIP_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "rename_clip",
    description: "Rename the clip.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", description: "New clip name (< 32 chars)" },
      },
    },
  },
};

// ─── Post-process: enforce minimum gap between consecutive notes ──────────────
// Guarantees silence exists even if the model ignores phrasing rules.
// Operates per-voice (same pitch) for polyphonic clips but also trims
// duration so notes never bleed into the next note's start.

function enforceGaps(
  notes: NoteDescription[],
  minGapBeats = 0.125, // minimum silence between any two consecutive notes
): NoteDescription[] {
  if (notes.length === 0) return notes;

  // Sort by startTime
  const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);

  // For each note, shorten the PREVIOUS note if it would overlap or leave < minGap
  const result: NoteDescription[] = [{ ...sorted[0]! }];

  for (let i = 1; i < sorted.length; i++) {
    const prev    = result[result.length - 1]!;
    const current = { ...sorted[i]! };
    const prevEnd = prev.startTime + prev.duration;
    const gap     = current.startTime - prevEnd;

    if (gap < minGapBeats) {
      // Shorten the previous note to create at least minGap of silence
      const maxAllowed = current.startTime - minGapBeats - prev.startTime;
      prev.duration = Math.max(0.125, maxAllowed);
    }

    result.push(current);
  }

  return result;
}

// ─── LAYER 3: Deterministic validators ────────────────────────────────────────
// These run AFTER the AI returns notes. They GUARANTEE musical rules in code,
// so reliability never depends on the model "remembering" to obey a prompt.

/** Return the set of in-key pitch classes (0–11), or null if Scale Mode is off. */
function getScalePitchClasses(
  song: ReturnType<typeof initialize>["application"]["song"] & object,
): Set<number> | null {
  if (!song.scaleMode || !song.scaleName) return null;
  const root      = song.rootNote ?? 0;
  const intervals = song.scaleIntervals ?? [0, 2, 4, 5, 7, 9, 11];
  return new Set(intervals.map((i) => (root + i) % 12));
}

/**
 * Snap every out-of-key note to the nearest in-key pitch.
 * No-op if Scale Mode is off. Preserves octave register where possible.
 */
function snapToScale(notes: NoteDescription[], allowed: Set<number> | null): NoteDescription[] {
  if (!allowed || allowed.size === 0) return notes;

  return notes.map((n) => {
    const pc = ((n.pitch % 12) + 12) % 12;
    if (allowed.has(pc)) return n;

    // Search outward for the nearest allowed pitch class (±6 semitones max).
    // Clamp the result to valid MIDI range [0, 127] — going below 0 or above 127 would be invalid.
    for (let dist = 1; dist <= 6; dist++) {
      if (allowed.has((pc + dist) % 12))      return { ...n, pitch: Math.min(127, n.pitch + dist) };
      if (allowed.has((pc - dist + 12) % 12)) return { ...n, pitch: Math.max(0,   n.pitch - dist) };
    }
    return n; // unreachable for any real scale
  });
}

/**
 * Guarantee no two time-adjacent notes share an identical velocity, and clamp
 * to a musical range. Robotic flat-velocity output is the #1 "AI smell".
 */
function humanizeVelocities(
  notes: NoteDescription[],
  range: [number, number] = [55, 115],
): NoteDescription[] {
  const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);
  let prevVel = -1;

  return sorted.map((n) => {
    let vel = Math.max(range[0], Math.min(range[1], n.velocity ?? 90));
    if (vel === prevVel) {
      // Nudge by a small pseudo-random amount, staying in range
      const nudge = ((Math.round(n.startTime * 1000) % 7) - 3); // -3..+3, deterministic
      vel = Math.max(range[0], Math.min(range[1], vel + (nudge === 0 ? 4 : nudge)));
    }
    prevVel = vel;
    return { ...n, velocity: vel };
  });
}

/**
 * Cap notes-per-bar for melodic parts. If a bar exceeds maxPerBar, keep the
 * loudest / structurally important notes and drop the weakest. Prevents the
 * "wall of notes" failure mode.
 */
function clampMelodyDensity(notes: NoteDescription[], maxPerBar = 8): NoteDescription[] {
  const byBar = new Map<number, NoteDescription[]>();
  for (const n of notes) {
    const bar = Math.floor(n.startTime / 4);
    (byBar.get(bar) ?? byBar.set(bar, []).get(bar)!).push(n);
  }

  const kept: NoteDescription[] = [];
  for (const barNotes of byBar.values()) {
    if (barNotes.length <= maxPerBar) {
      kept.push(...barNotes);
      continue;
    }
    // Keep the most prominent: prioritise downbeat notes and high velocity
    const ranked = [...barNotes].sort((a, b) => {
      const aDown = (a.startTime % 1) === 0 ? 1000 : 0;
      const bDown = (b.startTime % 1) === 0 ? 1000 : 0;
      return (bDown + (b.velocity ?? 0)) - (aDown + (a.velocity ?? 0));
    });
    kept.push(...ranked.slice(0, maxPerBar));
  }
  return kept.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Full melody/bass validation pipeline. Order matters:
 *   1. density clamp  2. scale snap  3. gap enforce  4. velocity humanize
 * Returns the cleaned notes plus a report of what was changed (for logging).
 */
function runMelodyValidators(
  rawNotes: NoteDescription[],
  song: ReturnType<typeof initialize>["application"]["song"] & object,
  opts: { maxPerBar?: number; velRange?: [number, number]; minGap?: number } = {},
): { notes: NoteDescription[]; report: string } {
  const allowed = getScalePitchClasses(song);
  const before  = rawNotes.length;

  let notes = clampMelodyDensity(rawNotes, opts.maxPerBar ?? 8);
  const afterDensity = notes.length;

  let outOfKey = 0;
  if (allowed) {
    outOfKey = notes.filter((n) => !allowed.has(((n.pitch % 12) + 12) % 12)).length;
    notes = snapToScale(notes, allowed);
  }

  notes = enforceGaps(notes, opts.minGap ?? 0.125);
  notes = humanizeVelocities(notes, opts.velRange ?? [55, 115]);

  const report =
    `validators: ${before} notes → ${notes.length} ` +
    `(density-dropped ${before - afterDensity}, scale-snapped ${outOfKey}, ` +
    `humanized velocities, gaps enforced)`;

  return { notes, report };
}

// ─── Clip color coding ────────────────────────────────────────────────────────
// Returns an RGB integer (0xRRGGBB) based on track role.
// Ableton stores clip colors as packed RGB: (R << 16) | (G << 8) | B.

const CLIP_COLORS = {
  drums:   0xFF8C00, // orange   — kick, snare, hi-hats
  bass:    0x0F6FFF, // blue     — bass, 808, sub
  chords:  0xAA44FF, // purple   — chords, pads, keys
  melody:  0x00C264, // green    — lead, melody, hook
  default: 0xFF8C00, // orange   — fallback
} as const;

function clipColorForTrack(trackName: string, isDrum: boolean): number {
  if (isDrum) return CLIP_COLORS.drums;

  const n = trackName.toLowerCase();

  if (/bass|808|sub/.test(n))                          return CLIP_COLORS.bass;
  if (/chord|pad|keys|piano|organ|rhodes|synth/.test(n)) return CLIP_COLORS.chords;
  if (/lead|melody|hook|top|arp|riff/.test(n))         return CLIP_COLORS.melody;

  return CLIP_COLORS.default;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pitchToName(midi: number): string {
  // Ableton Live convention: middle C = C3 = MIDI 60 (octave = floor(midi/12) - 2).
  // This MUST match Live's note display, otherwise the drum pad map shows the AI
  // the wrong octave (e.g. labeling kick MIDI 36 as "C2" when Live shows "C1").
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 2}`;
}

function notesToSummary(notes: NoteDescription[], maxNotes = 64): string {
  const shown = notes.slice(0, maxNotes);
  const lines = shown.map(
    (n) =>
      `  ${pitchToName(n.pitch).padEnd(4)} t=${n.startTime.toFixed(2).padStart(5)} ` +
      `dur=${n.duration.toFixed(2).padStart(5)} vel=${(n.velocity ?? 100).toString().padStart(3)}` +
      (n.muted ? " [muted]" : ""),
  );
  const truncated = notes.length > maxNotes ? `\n  … +${notes.length - maxNotes} more notes` : "";
  return lines.join("\n") + truncated;
}

function beatsToBar(beats: number, bpm: number): string {
  const bar  = Math.floor(beats / 4) + 1;
  const beat = (beats % 4) + 1;
  return `bar ${bar} beat ${beat.toFixed(1)}`;
}

// ─── Scale constraint builder (Phase 1) ──────────────────────────────────────
// If Live's Scale Mode is ON, returns a hard constraint block telling the LLM
// exactly which pitch classes are in key. Injected into every melody prompt.

function buildScaleConstraint(
  song: ReturnType<typeof initialize>["application"]["song"] & object,
): string {
  if (!song.scaleMode || !song.scaleName) return ""; // scale mode off — no constraint

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const rootNote   = song.rootNote ?? 0;        // 0 = C … 11 = B
  const intervals  = song.scaleIntervals ?? [0, 2, 4, 5, 7, 9, 11]; // fallback: major

  const scaleNotes = intervals
    .map((i) => NOTE_NAMES[(rootNote + i) % 12])
    .join(", ");

  return [
    "",
    "╔══ KEY / SCALE CONSTRAINT (Live Scale Mode is ON) ════════",
    `║  Active scale : ${NOTE_NAMES[rootNote]} ${song.scaleName}`,
    `║  In-key notes : ${scaleNotes}`,
    `║  ⚠️  Use ONLY these pitch classes (any octave).`,
    `║     All other pitches are OUT OF KEY — do not use them.`,
    `║  ⚠️  MELODIC CONTENT ONLY: this constraint applies to melody,`,
    `║     bass, and chords. It NEVER applies to drum tracks — drum`,
    `║     pitches are pad addresses with no harmonic meaning.`,
    "╚══════════════════════════════════════════════════════════",
    "",
  ].join("\n");
}

// ─── Rich session context builder ─────────────────────────────────────────────
// Reads the full song state and formats it into a detailed string for the LLM.

function buildSessionContext(
  song: ReturnType<typeof initialize>["application"]["song"] & object,
): string {
  const bpm    = song.tempo;
  const key    = song.scaleName ? `${pitchToName(song.rootNote ?? 60)} ${song.scaleName}` : "No scale set";
  const scaleOn = song.scaleMode ? "on" : "off";

  const lines: string[] = [
    "╔══ SESSION OVERVIEW ══════════════════════════════════════",
    `║  Tempo:       ${bpm} BPM`,
    `║  Key / Scale: ${key} (scale mode ${scaleOn})`,
    `║  Scenes:      ${song.scenes.length}`,
    `║  Tracks:      ${song.tracks.length}`,
    "╚══════════════════════════════════════════════════════════",
    "",
  ];

  for (const track of song.tracks) {
    const isMidi  = track instanceof MidiTrack;
    const isAudio = track instanceof AudioTrack;
    const type    = isMidi ? "MIDI" : isAudio ? "Audio" : "Track";
    const flags   = [
      track.mute   ? "muted" : null,
      track.solo   ? "soloed" : null,
      track.arm    ? "armed" : null,
    ].filter(Boolean).join(", ");

    // Devices (mixer volume/panning require async getValue() — shown via sound design command)
    const deviceNames = track.devices.map((d) => d.name).join(", ") || "none";
    const sendCount   = track.mixer.sends.length;

    lines.push(`┌─ [${type}] "${track.name}" ${flags ? `(${flags})` : ""}`);
    lines.push(`│  Mixer: ${sendCount} send(s)`);
    lines.push(`│  Devices: ${deviceNames}`);

    // Arrangement clips
    const clips = track.arrangementClips;
    if (clips.length === 0) {
      lines.push("│  Arrangement: (no clips)");
    } else {
      lines.push(`│  Arrangement clips (${clips.length}):`);
      for (const clip of clips) {
        const start = beatsToBar(clip.startTime, bpm);
        const dur   = `${clip.duration.toFixed(1)} beats (${(clip.duration / 4).toFixed(1)} bars)`;
        const loopMark = clip.looping ? " [looped]" : "";
        const muteMark = clip.muted   ? " [muted]"  : "";
        lines.push(`│    • "${clip.name}"  @ ${start}  len=${dur}${loopMark}${muteMark}`);

        // For MIDI clips, show a compact note summary
        if (clip instanceof MidiClip && clip.notes.length > 0) {
          const notes   = clip.notes;
          const pitches = [...new Set(notes.map((n) => pitchToName(n.pitch)))].slice(0, 12).join(" ");
          const density = (notes.length / (clip.duration / 4)).toFixed(1);
          lines.push(`│       Notes: ${notes.length} total  pitches=[${pitches}]  density=${density}/bar`);
        }
      }
    }

    // Session clips (clip slots that have clips)
    const sessionClips = track.clipSlots.filter((cs) => cs.clip !== null);
    if (sessionClips.length > 0) {
      lines.push(`│  Session clips (${sessionClips.length} slots with clips):`);
      for (const cs of sessionClips) {
        const c = cs.clip!;
        lines.push(`│    • "${c.name}"  len=${c.duration.toFixed(1)} beats`);
        if (c instanceof MidiClip && c.notes.length > 0) {
          const pitches = [...new Set(c.notes.map((n) => pitchToName(n.pitch)))].slice(0, 12).join(" ");
          lines.push(`│       Notes: ${c.notes.length}  pitches=[${pitches}]`);
        }
      }
    }

    lines.push("│");
  }

  return lines.join("\n");
}

// ─── Sibling context builder ──────────────────────────────────────────────────
// Shows content of ALL OTHER tracks (MIDI + Audio) in the same arrangement
// region so the AI can lock to / complement what's already playing.
// targetTrackName is excluded so the AI doesn't echo the target back.

function buildSiblingContext(
  song: ReturnType<typeof initialize>["application"]["song"] & object,
  targetTrackName: string,
  regionStart: number, // beats
  regionEnd:   number, // beats
): string {
  const regionBars = Math.round((regionEnd - regionStart) / 4);
  const lines: string[] = [
    "╔══ EXISTING CONTENT ON OTHER TRACKS (arrangement + session) ══",
    `║  Arrangement region scanned: beat ${regionStart}–${regionEnd}  (${regionBars} bars)`,
    `║  Session View clips on other tracks are also shown below.`,
    `║  Your output MUST lock to / complement these parts.`,
    "╠══════════════════════════════════════════════════════════",
  ];

  let hasAny = false;

  for (const track of song.tracks) {
    if (track.name === targetTrackName) continue;

    // Find clips that overlap this region
    const overlapping = track.arrangementClips.filter(
      (c) => c.startTime < regionEnd && (c.startTime + c.duration) > regionStart,
    );
    if (overlapping.length === 0) continue;

    // ── Audio track ────────────────────────────────────────────────────────
    if (track instanceof AudioTrack) {
      lines.push(`║`);
      lines.push(`║  [Audio] "${track.name}"`);
      hasAny = true;

      for (const clip of overlapping) {
        // Extract just the filename from the full path for readability
        const fileName = clip instanceof MidiClip
          ? clip.name
          : (() => {
              const fp = (clip as { filePath?: string }).filePath ?? "";
              return (fp.split("/").pop() ?? fp.split("\\").pop() ?? fp) || clip.name;
            })();

        const clipStartInRegion = clip.startTime - regionStart;
        const clipBar  = Math.floor(clip.startTime / 4) + 1;
        const clipBars = Math.round(clip.duration / 4);

        lines.push(`║    Clip: "${clip.name}"`);
        lines.push(`║      File:     ${fileName}`);
        lines.push(`║      Position: bar ${clipBar}  (beat ${clip.startTime.toFixed(1)} in arrangement)`);
        lines.push(`║      Length:   ${clip.duration.toFixed(1)} beats  (${clipBars} bars)`);
        lines.push(`║      Looping:  ${clip.looping ? "yes" : "no"}${clip.muted ? "  [MUTED]" : ""}`);
        lines.push(`║      → This audio occupies beats ${clipStartInRegion.toFixed(1)}–${(clipStartInRegion + clip.duration).toFixed(1)} of this region.`);
        lines.push(`║        Infer its rhythmic and harmonic role from the track name + filename.`);
      }
      continue;
    }

    // ── MIDI track ─────────────────────────────────────────────────────────
    if (!(track instanceof MidiTrack)) continue;

    const isDrum = isDrumTrack(track);

    // Render a single MIDI clip's notes. `offsetBeats` shifts note times so they
    // read relative to the region; for session clips it's 0 (their own beat 0).
    const renderMidiClip = (clip: MidiClip<"1.0.0">, offsetBeats: number, sourceLabel: string) => {
      const regionNotes = clip.notes
        .map((n) => ({ ...n, startTime: n.startTime + offsetBeats }))
        .filter((n) => n.startTime >= 0 && n.startTime < Math.max(regionEnd - regionStart, clip.duration))
        .sort((a, b) => a.startTime - b.startTime);
      if (regionNotes.length === 0) return;

      hasAny = true;
      lines.push(`║`);
      lines.push(`║  [${isDrum ? "Drums" : "MIDI"}] "${track.name}"  (${sourceLabel})`);
      lines.push(`║    Clip: "${clip.name}"  (${regionNotes.length} notes)`);

      const spanBars = Math.max(1, Math.round(clip.duration / 4));

      if (isDrum) {
        for (let bar = 0; bar < Math.min(spanBars, 4); bar++) {
          const barNotes = regionNotes.filter(
            (n) => n.startTime >= bar * 4 && n.startTime < (bar + 1) * 4,
          );
          const grid = Array(16).fill("·");
          for (const n of barNotes) {
            const slot = Math.round(((n.startTime % 4) / 4) * 16);
            const label = pitchToName(n.pitch)[0] ?? "X";
            if (slot >= 0 && slot < 16) grid[slot] = label.toUpperCase();
          }
          lines.push(
            `║      Bar ${bar + 1}: [${grid.join("")}]  ← ` +
            barNotes.map((n) => `${pitchToName(n.pitch)}@${n.startTime.toFixed(2)}`).slice(0, 8).join(" "),
          );
        }
      } else {
        const shown = regionNotes.slice(0, 32);
        lines.push(
          `║      Notes: ` +
          shown.map((n) => `${pitchToName(n.pitch)}@${n.startTime.toFixed(2)}(${n.duration.toFixed(2)})`).join("  "),
        );
        if (regionNotes.length > 32) lines.push(`║      … +${regionNotes.length - 32} more`);

        const busyBeats = new Set(shown.map((n) => Math.floor(n.startTime)));
        const beatGrid = Array.from({ length: Math.min(spanBars * 4, 16) }, (_, i) =>
          busyBeats.has(i) ? "█" : "·",
        );
        lines.push(`║      Beat activity: [${beatGrid.join("")}]  (█=notes ·=empty)`);
      }
    };

    // 1) Arrangement clips overlapping the region
    for (const clip of overlapping) {
      if (clip instanceof MidiClip && clip.notes.length > 0) {
        renderMidiClip(clip, clip.startTime - regionStart, "arrangement");
      }
    }
  }

  // ── Second pass: Session View clips (clip slots) ──────────────────────────
  // The arrangement loop above misses clips that live only in Session View.
  // We scan every other MIDI track's clip slots so a bass/chord clip loaded in
  // Session View is still visible to the generator.
  for (const track of song.tracks) {
    if (track.name === targetTrackName) continue;
    if (!(track instanceof MidiTrack)) continue;

    const isDrum = isDrumTrack(track);
    const sessionClips = track.clipSlots
      .map((cs) => cs.clip)
      .filter((c): c is MidiClip<"1.0.0"> => c instanceof MidiClip && c.notes.length > 0);

    for (const clip of sessionClips) {
      const sorted = [...clip.notes].sort((a, b) => a.startTime - b.startTime);
      hasAny = true;
      lines.push(`║`);
      lines.push(`║  [${isDrum ? "Drums" : "MIDI"}] "${track.name}"  (session view)`);
      lines.push(`║    Clip: "${clip.name}"  (${sorted.length} notes, ${(clip.duration / 4).toFixed(1)} bars)`);

      if (isDrum) {
        const spanBars = Math.max(1, Math.round(clip.duration / 4));
        for (let bar = 0; bar < Math.min(spanBars, 4); bar++) {
          const barNotes = sorted.filter((n) => n.startTime >= bar * 4 && n.startTime < (bar + 1) * 4);
          const grid = Array(16).fill("·");
          for (const n of barNotes) {
            const slot = Math.round(((n.startTime % 4) / 4) * 16);
            grid[slot] = (pitchToName(n.pitch)[0] ?? "X").toUpperCase();
          }
          lines.push(`║      Bar ${bar + 1}: [${grid.join("")}]`);
        }
      } else {
        const shown = sorted.slice(0, 32);
        lines.push(
          `║      Notes: ` +
          shown.map((n) => `${pitchToName(n.pitch)}@${n.startTime.toFixed(2)}(${n.duration.toFixed(2)})`).join("  "),
        );
        if (sorted.length > 32) lines.push(`║      … +${sorted.length - 32} more`);
      }
    }
  }

  if (!hasAny) {
    lines.push("║  (No existing content found in arrangement OR session view — starting fresh)");
  }

  lines.push("╚══════════════════════════════════════════════════════════");
  return lines.join("\n");
}

// ─── Sound design: read device parameters ─────────────────────────────────────
// DeviceParameter.getValue() is async. We read all params concurrently so the
// AI gets the full snapshot in one shot without sequential round-trips.

interface ParamState {
  name:         string;
  min:          number;
  max:          number;
  currentValue: number;
  defaultValue: number;
  isQuantized:  boolean;
  valueItems:   string[]; // enum option labels for quantized knobs (e.g. Filter Type)
}

interface DeviceState {
  name:   string;
  params: ParamState[];
}

/** Read every parameter of a single device, concurrently. Unreadable params are skipped. */
async function readDeviceParams(device: Device<"1.0.0">): Promise<ParamState[]> {
  const results = await Promise.all(
    device.parameters.map(async (param) => {
      try {
        const currentValue = await param.getValue();
        return {
          name:         param.name,
          min:          param.min,
          max:          param.max,
          currentValue,
          defaultValue: param.defaultValue,
          isQuantized:  param.isQuantized,
          valueItems:   param.valueItems.map((v) => v.name),
        } satisfies ParamState;
      } catch {
        return null; // param is not readable (e.g. internal/hidden)
      }
    }),
  );
  return results.filter((r): r is ParamState => r !== null);
}

/** Read all devices on a list concurrently — returns one DeviceState per device. */
async function readAllDeviceStates(devices: Device<"1.0.0">[]): Promise<DeviceState[]> {
  return Promise.all(
    devices.map(async (d) => ({
      name:   d.name,
      params: await readDeviceParams(d),
    })),
  );
}

/** Format DeviceState[] into a readable prompt block for the AI. */
function formatDeviceStates(deviceStates: DeviceState[]): string {
  if (deviceStates.length === 0) return "  (no devices with readable parameters)";

  return deviceStates
    .map(({ name, params }) => {
      if (params.length === 0) return `  Device: "${name}" (no readable parameters)`;

      const paramLines = params.map((p) => {
        const range    = `[${p.min.toFixed(2)}–${p.max.toFixed(2)}]`;
        const atDef    = Math.abs(p.currentValue - p.defaultValue) < 0.001 ? " (default)" : "";
        const opts     = p.isQuantized && p.valueItems.length > 0
          ? ` options=[${p.valueItems.join("|")}]`
          : "";
        const current  = p.isQuantized && p.valueItems.length > 0
          ? `${p.currentValue.toFixed(0)} = "${p.valueItems[Math.round(p.currentValue)] ?? p.currentValue.toFixed(0)}"`
          : p.currentValue.toFixed(3);

        return `    "${p.name}" = ${current}  range=${range}${opts}${atDef}`;
      });

      return [`  Device: "${name}" (${params.length} params)`, ...paramLines].join("\n");
    })
    .join("\n\n");
}

// ─── Sound design tool ────────────────────────────────────────────────────────
// The AI calls this to apply a set of parameter changes. We do case-insensitive
// matching and clamp values to [min, max] as a safety guard.

const SET_DEVICE_PARAMS_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "set_device_params",
    description:
      "Sculpt the sound by changing device parameters. " +
      "Only include parameters that need to change — omit unchanged ones. " +
      "Values MUST be within each parameter's reported [min, max] range. " +
      "For quantized (enum) params the value is the integer index into the options list. " +
      "Reference exact device_name and param_name strings from the context — no guessing.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["changes", "reasoning"],
      properties: {
        changes: {
          type: "array",
          description: "Parameter changes to apply. Empty [] = no changes needed.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["device_name", "param_name", "value"],
            properties: {
              device_name: {
                type: "string",
                description: "Exact device name from the context (case-insensitive match).",
              },
              param_name: {
                type: "string",
                description: "Exact parameter name from the context (case-insensitive match).",
              },
              value: {
                type: "number",
                description:
                  "New value within [min, max]. For quantized params use the integer option index.",
              },
            },
          },
        },
        reasoning: {
          type: "string",
          description:
            "Explain each change: what you adjusted and how it achieves the described sound.",
        },
      },
    },
  },
};

const INSERT_DEVICES_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "insert_devices",
    description:
      "Insert built-in Ableton Live devices into the track's device chain. " +
      "Use this when the requested sound needs a device that is NOT in the chain yet " +
      "(e.g. 'add a low cut' → insert EQ Eight; 'glue it together' → insert Glue Compressor). " +
      "Only Live's native devices work, always with their DEFAULT preset. " +
      "FX names include: EQ Eight, EQ Three, Compressor, Glue Compressor, Saturator, Reverb, " +
      "Delay, Echo, Auto Filter, Auto Pan, Utility, Chorus-Ensemble, Phaser-Flanger, Redux, " +
      "Drum Buss, Limiter, Multiband Dynamics, Gate. " +
      "INSTRUMENT names (use index 0, for tracks with no sound source): Wavetable, Operator, " +
      "Drift, Analog, Electric, Collision, Meld, Simpler, Sampler, Drum Rack. Instruments load " +
      "in init state — sound-design them with set_device_params to fit the request. " +
      "After inserting, you receive the new devices' full parameter lists — " +
      "THEN call set_device_params to configure them. Insert first, configure second.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["devices", "reasoning"],
      properties: {
        devices: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["device_name", "index"],
            properties: {
              device_name: {
                type: "string",
                description: 'Exact built-in Live device name, e.g. "EQ Eight".',
              },
              index: {
                type: "number",
                description:
                  "0-based position in the device chain. Use -1 to append at the end " +
                  "(correct for most FX — after the instrument).",
              },
            },
          },
        },
        reasoning: { type: "string", description: "Why these devices are needed for the requested sound." },
      },
    },
  },
};

/**
 * Apply a set_device_params result against a list of available devices.
 * Does case-insensitive matching on both device name and param name.
 * Clamps values to [min, max] as a safety net.
 * Returns how many params were successfully changed.
 */
async function applyDeviceParamChanges(
  changes: Array<{ device_name: string; param_name: string; value: number }>,
  devices: Device<"1.0.0">[],
): Promise<number> {
  let changedCount = 0;

  for (const change of changes) {
    const device = devices.find(
      (d) => d.name.toLowerCase() === change.device_name.toLowerCase(),
    );
    if (!device) {
      console.warn(`[AI Copilot] soundDesign: device "${change.device_name}" not found — skipping.`);
      continue;
    }

    const param = device.parameters.find(
      (p) => p.name.toLowerCase() === change.param_name.toLowerCase(),
    );
    if (!param) {
      console.warn(
        `[AI Copilot] soundDesign: param "${change.param_name}" not found on "${device.name}" — skipping.`,
      );
      continue;
    }

    const clamped = Math.max(param.min, Math.min(param.max, change.value));
    try {
      await param.setValue(clamped);
      changedCount++;
      console.log(
        `[AI Copilot] soundDesign: "${device.name}" → "${param.name}" = ${clamped.toFixed(3)} ` +
        `(range [${param.min}, ${param.max}])`,
      );
    } catch (e) {
      console.warn(`[AI Copilot] soundDesign: could not set "${param.name}" — ${(e as Error).message}`);
    }
  }

  return changedCount;
}

// ─── Agent tool factories ─────────────────────────────────────────────────────
// Bundles of AgentTools (def + handler) bound to a specific track, for use with
// runAgent. Lets generation commands chain MIDI work with device/FX work.

const READ_DEVICE_PARAMS_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "read_device_params",
    description:
      "Read the current state of every device on the track: device names and all " +
      "parameters with [min, max] ranges and current values. Call this BEFORE " +
      "set_device_params if you have not yet seen the chain's parameters.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
};

/** Device tools (read / insert / configure) bound to one track. */
function makeDeviceAgentTools(
  track: MidiTrack<"1.0.0">,
  update: (label: string, pct?: number) => void,
): AgentTool[] {
  return [
    {
      def: READ_DEVICE_PARAMS_TOOL,
      handler: async () => {
        update("Reading device parameters…");
        const states = await readAllDeviceStates(track.devices);
        return [
          `Device chain on "${track.name}": ${track.devices.map((d) => `"${d.name}"`).join(" → ") || "(empty)"}`,
          "",
          formatDeviceStates(states),
        ].join("\n");
      },
    },
    {
      def: INSERT_DEVICES_TOOL,
      handler: async (args) => {
        const input = args as unknown as {
          devices: Array<{ device_name: string; index: number }>;
          reasoning: string;
        };
        const lines: string[] = [];
        let anyInserted = false;
        for (const d of input.devices) {
          const idx = d.index < 0 || d.index > track.devices.length
            ? track.devices.length
            : Math.round(d.index);
          update(`Inserting ${d.device_name}…`);
          try {
            await track.insertDevice(d.device_name, idx);
            anyInserted = true;
            lines.push(`Inserted "${d.device_name}" at chain position ${idx}.`);
            console.log(`[AI Copilot] agent: inserted "${d.device_name}" at index ${idx} on "${track.name}". Reason: ${input.reasoning}`);
          } catch (e) {
            lines.push(
              `FAILED to insert "${d.device_name}": ${(e as Error).message}. ` +
              "Check it is an exact built-in Live device name.",
            );
            console.warn(`[AI Copilot] agent: insert "${d.device_name}" failed — ${(e as Error).message}`);
          }
        }
        if (anyInserted) {
          const states = await readAllDeviceStates(track.devices);
          lines.push("", "Updated device chain with full parameters:", "", formatDeviceStates(states));
          lines.push("", "Now call set_device_params to configure the new devices.");
        }
        return lines.join("\n");
      },
    },
    {
      def: SET_DEVICE_PARAMS_TOOL,
      handler: async (args) => {
        const input = args as unknown as {
          changes:   Array<{ device_name: string; param_name: string; value: number }>;
          reasoning: string;
        };
        update("Applying device parameters…");
        const n = await applyDeviceParamChanges(input.changes, track.devices);
        console.log(`[AI Copilot] agent: ${n} param(s) changed on "${track.name}". Reasoning: ${input.reasoning}`);
        return `Applied ${n} of ${input.changes.length} parameter change(s).`;
      },
    },
  ];
}

/** Web access as an AgentTool, for use with runAgent. */
function makeFetchUrlAgentTool(update: (label: string, pct?: number) => void): AgentTool {
  return {
    def: FETCH_URL_TOOL,
    handler: async (args) => {
      const { url } = args as { url: string };
      update(`Reading ${new URL(url).hostname}…`);
      const text = await httpGetText(url);
      const trimmed = text.length > 12_000 ? text.slice(0, 12_000) + "\n…(truncated)" : text;
      return `Fetched ${url}:\n\n${trimmed}`;
    },
  };
}

// ─── Drum kit builder tools ──────────────────────────────────────────────────
// Live's Core Library ships ~2,300 categorized one-shot drum samples. These
// tools let the agent browse them and build a Drum Rack from scratch on an
// empty track: insert rack → insert chain per pad → Simpler → load sample.

/** Locate Live's Core Library folder (via the Extension Host path or common installs). */
function getCoreLibraryDir(): string | null {
  const candidates: string[] = [];
  // Derive the .app bundle from the Extension Host path the user already configured.
  const hostPath = process.env.EXTENSION_HOST_PATH ?? "";
  const appMatch = hostPath.match(/^(.*\.app)\//);
  if (appMatch) candidates.push(`${appMatch[1]}/Contents/App-Resources/Core Library`);
  for (const app of ["Ableton Live 12 Suite", "Ableton Live 12 Beta", "Ableton Live 12 Standard"]) {
    candidates.push(`/Applications/${app}.app/Contents/App-Resources/Core Library`);
  }
  for (const dir of candidates) {
    try { if (fs.existsSync(dir)) return dir; } catch { /* fs may be restricted */ }
  }
  return null;
}

/** Locate the Core Library one-shot drum samples folder. */
function getCoreDrumSamplesDir(): string | null {
  if (process.env.DRUM_SAMPLES_DIR) {
    try { if (fs.existsSync(process.env.DRUM_SAMPLES_DIR)) return process.env.DRUM_SAMPLES_DIR; } catch { /* ignore */ }
  }
  const core = getCoreLibraryDir();
  if (!core) return null;
  const dir = `${core}/Samples/One Shots/Drums`;
  try { return fs.existsSync(dir) ? dir : null; } catch { return null; }
}

/** Locate the Core Library Drum Rack kit presets folder. */
function getDrumKitsDir(): string | null {
  const core = getCoreLibraryDir();
  if (!core) return null;
  const dir = `${core}/Racks/Drum Racks`;
  try { return fs.existsSync(dir) ? dir : null; } catch { return null; }
}

const decodeXmlEntities = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"')
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">");

interface KitPad { note: number; samplePath: string; label: string }

/**
 * Parse a Drum Rack preset (.adg = gzipped XML) into pad → sample mappings.
 * Live stores each pad's ReceivingNote INVERTED (128 - midiNote). Sample paths
 * reference Ableton's build machine — remapped onto the local Core Library.
 * Synth-based pads (DS devices, Instrument Selectors) have no sample and are skipped.
 */
function parseDrumKitAdg(kitPath: string, coreLibDir: string): KitPad[] {
  const xml = zlib.gunzipSync(fs.readFileSync(kitPath)).toString("utf8");
  const pads: KitPad[] = [];
  const seen = new Set<number>();

  for (const block of xml.split("<DrumBranchPreset").slice(1)) {
    const noteMatch = block.match(/<ReceivingNote Value="(\d+)"/);
    const pathMatch = block.match(/Core Library\/(Samples\/[^"]*\.(?:wav|aif|aiff|flac))"/i);
    if (!noteMatch || !pathMatch) continue;

    const note = 128 - parseInt(noteMatch[1], 10);
    if (note < 0 || note > 127 || seen.has(note)) continue;

    const rel   = decodeXmlEntities(pathMatch[1]);
    const local = `${coreLibDir}/${rel}`;
    try { if (!fs.existsSync(local)) continue; } catch { continue; }

    seen.add(note);
    pads.push({ note, samplePath: local, label: rel.split("/").pop()!.replace(/\.[^.]+$/, "") });
  }

  return pads.sort((a, b) => a.note - b.note);
}

/**
 * Load pads into the track's Drum Rack (inserting the rack first if missing):
 * chain → receiving note → Simpler → sample. Returns per-pad result lines.
 */
async function buildPadsIntoRack(
  track: MidiTrack<"1.0.0">,
  pads: KitPad[],
  update: (label: string, pct?: number) => void,
): Promise<string[]> {
  let drumRack = findDrumRack(track.devices);
  if (!drumRack) {
    update("Inserting Drum Rack…");
    await track.insertDevice("Drum Rack", 0);
    drumRack = findDrumRack(track.devices);
    if (!drumRack) return ["FAILED: could not insert a Drum Rack on this track."];
  }

  const lines: string[] = [];
  for (const pad of pads) {
    try {
      update(`Loading "${pad.label}" onto pad ${pad.note}…`);
      const chain = await drumRack.insertChain(drumRack.chains.length) as DrumChain<"1.0.0">;
      chain.receivingNote = Math.max(0, Math.min(127, Math.round(pad.note)));
      const device = await chain.insertDevice("Simpler", 0);
      if (device instanceof Simpler) {
        await device.replaceSample(pad.samplePath);
        lines.push(`Pad ${pad.note}: "${pad.label}"`);
        console.log(`[AI Copilot] agent: pad ${pad.note} ← "${pad.label}" on "${track.name}"`);
      } else {
        lines.push(`FAILED pad ${pad.note}: inserted device is not a Simpler`);
      }
    } catch (e) {
      lines.push(`FAILED pad ${pad.note}: ${(e as Error).message}`);
      console.warn(`[AI Copilot] agent: kit pad ${pad.note} failed — ${(e as Error).message}`);
    }
  }
  return lines;
}

const LIST_DRUM_KITS_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "list_drum_kits",
    description:
      "List Live's ready-made Drum Rack kit presets by category (Acoustic, Sampled, " +
      "Electronic, Drum Machines…). Prefer loading one of these with load_drum_kit over " +
      "building a kit sample-by-sample — they are professionally curated and genre-tagged " +
      "by name. Sample-based kits (Acoustic, Sampled, Drum Machines) load most reliably.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
};

const LOAD_DRUM_KIT_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "load_drum_kit",
    description:
      "Load an existing Drum Rack kit preset onto the track by name (from list_drum_kits). " +
      "Recreates the kit's pads with their original samples and returns the resulting pad map — " +
      "use those exact pitches in create_drum_clip. If a kit loads very few pads (synth-based " +
      "kits cannot be recreated), try a different kit or build one with create_drum_kit.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kit_name", "reasoning"],
      properties: {
        kit_name:  { type: "string", description: "Kit name from list_drum_kits, e.g. \"Crystal Clear Kit\"" },
        reasoning: { type: "string", description: "Why this kit fits the requested style" },
      },
    },
  },
};

const LIST_DRUM_SAMPLES_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "list_drum_samples",
    description:
      "Browse Live's Core Library one-shot drum samples. Categories: Kick, Snare, Clap, " +
      "Rim, Hihat, Cymbal, Ride, Tom, Shaker, Tambourine, Bongo, Conga, Timbales, Bell, " +
      "Wood, Electronic Percussion, Misc Percussion, FX Hit. " +
      "Returns sample file names to use with create_drum_kit. " +
      "Use filter to narrow by name (e.g. '808', 'Soft', 'Vinyl'); pass \"\" for all.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["category", "filter"],
      properties: {
        category: { type: "string", description: "One category, e.g. \"Kick\"" },
        filter:   { type: "string", description: "Case-insensitive name substring, or \"\" for all" },
      },
    },
  },
};

const CREATE_DRUM_KIT_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "create_drum_kit",
    description:
      "Build a Drum Rack on the track from Core Library samples (inserts the rack if missing). " +
      "Each pad needs: receiving_note (the MIDI pitch that triggers it), the sample's category, " +
      "and its exact file name from list_drum_samples. " +
      "Use GM pitches so patterns map cleanly: 36=Kick, 37=Rim, 38=Snare, 39=Clap, " +
      "42=Closed Hihat, 46=Open Hihat, 49=Crash Cymbal, 51=Ride, 41/45/47/48=Toms, " +
      "54=Tambourine, 70=Shaker. Typical kit: kick, snare, clap, closed hat, open hat + 1-3 extras. " +
      "Returns the new pad map — use those pitches in create_drum_clip afterwards.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pads", "reasoning"],
      properties: {
        pads: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["receiving_note", "category", "sample_file"],
            properties: {
              receiving_note: { type: "number", description: "MIDI pitch that triggers this pad (e.g. 36 for kick)" },
              category:       { type: "string", description: "Sample category, e.g. \"Kick\"" },
              sample_file:    { type: "string", description: "Exact file name from list_drum_samples" },
            },
          },
        },
        reasoning: { type: "string", description: "Why these samples fit the requested style" },
      },
    },
  },
};

/** Kit-building tools (browse samples / build Drum Rack) bound to one track. */
function makeDrumKitAgentTools(
  track: MidiTrack<"1.0.0">,
  update: (label: string, pct?: number) => void,
): AgentTool[] {
  return [
    {
      def: LIST_DRUM_SAMPLES_TOOL,
      handler: async (args) => {
        const { category, filter } = args as { category: string; filter: string };
        const root = getCoreDrumSamplesDir();
        if (!root) return "FAILED: Core Library drum samples not found on this machine. Skip kit building.";
        const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
        const dir  = dirs.find((d) => d.name.toLowerCase() === category.trim().toLowerCase());
        if (!dir) return `Unknown category "${category}". Available: ${dirs.map((d) => d.name).join(", ")}`;
        const all = fs.readdirSync(`${root}/${dir.name}`)
          .filter((f) => /\.(wav|aif|aiff|flac)$/i.test(f))
          .filter((f) => !filter || f.toLowerCase().includes(filter.toLowerCase()));
        const shown = all.slice(0, 80);
        return [
          `${all.length} sample(s) in "${dir.name}"${filter ? ` matching "${filter}"` : ""}:`,
          ...shown.map((f) => `  ${f}`),
          all.length > shown.length ? `  …and ${all.length - shown.length} more — narrow with filter.` : "",
        ].join("\n");
      },
    },
    {
      def: LIST_DRUM_KITS_TOOL,
      handler: async () => {
        const root = getDrumKitsDir();
        if (!root) return "FAILED: Core Library drum kits not found on this machine. Build a kit with create_drum_kit instead.";
        const lines: string[] = [];
        const cats = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
        for (const cat of cats) {
          const kits = fs.readdirSync(`${root}/${cat.name}`).filter((f) => f.endsWith(".adg"));
          if (kits.length === 0) continue;
          lines.push(`${cat.name}:`);
          for (const kit of kits) lines.push(`  ${kit.replace(/\.adg$/, "")}`);
        }
        return lines.length > 0 ? lines.join("\n") : "No kit presets found.";
      },
    },
    {
      def: LOAD_DRUM_KIT_TOOL,
      handler: async (args) => {
        const { kit_name, reasoning } = args as { kit_name: string; reasoning: string };
        const root    = getDrumKitsDir();
        const coreLib = getCoreLibraryDir();
        if (!root || !coreLib) return "FAILED: Core Library not found on this machine.";

        // Find the .adg by name (case-insensitive, any category subfolder)
        const wanted = kit_name.trim().toLowerCase().replace(/\.adg$/, "");
        let kitPath: string | null = null;
        for (const cat of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
          const hit = fs.readdirSync(`${root}/${cat.name}`)
            .find((f) => f.endsWith(".adg") && f.replace(/\.adg$/, "").toLowerCase() === wanted);
          if (hit) { kitPath = `${root}/${cat.name}/${hit}`; break; }
        }
        if (!kitPath) return `Kit "${kit_name}" not found — call list_drum_kits for exact names.`;

        update(`Parsing "${kit_name}"…`);
        const pads = parseDrumKitAdg(kitPath, coreLib);
        if (pads.length === 0) {
          return `Kit "${kit_name}" contains no loadable sample pads (likely a synth-based kit). ` +
                 "Try a kit from the Acoustic or Sampled category, or build one with create_drum_kit.";
        }

        const lines = await buildPadsIntoRack(track, pads, update);
        const ok    = lines.filter((l) => !l.startsWith("FAILED")).length;
        console.log(`[AI Copilot] agent: loaded kit "${kit_name}" on "${track.name}" (${ok}/${pads.length} pads). Reason: ${reasoning}`);
        return [
          `Loaded kit "${kit_name}" (${ok}/${pads.length} pads):`,
          ...lines,
          "",
          readDrumPadMap(track),
          "Use these exact pitches in create_drum_clip.",
        ].join("\n");
      },
    },
    {
      def: CREATE_DRUM_KIT_TOOL,
      handler: async (args) => {
        const input = args as unknown as {
          pads: Array<{ receiving_note: number; category: string; sample_file: string }>;
          reasoning: string;
        };
        const root = getCoreDrumSamplesDir();
        if (!root) return "FAILED: Core Library drum samples not found on this machine.";

        // Resolve category + file name → absolute sample paths
        const resolved: KitPad[] = [];
        const lines: string[] = [];
        for (const pad of input.pads) {
          const dirs   = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
          const catDir = dirs.find((d) => d.name.toLowerCase() === pad.category.trim().toLowerCase());
          if (!catDir) { lines.push(`FAILED pad ${pad.receiving_note}: unknown category "${pad.category}"`); continue; }
          const files = fs.readdirSync(`${root}/${catDir.name}`);
          const file  = files.find((f) => f.toLowerCase() === pad.sample_file.trim().toLowerCase())
                     ?? files.find((f) => f.toLowerCase().includes(pad.sample_file.trim().toLowerCase()) && !f.endsWith(".asd"));
          if (!file) { lines.push(`FAILED pad ${pad.receiving_note}: sample "${pad.sample_file}" not found in ${catDir.name}`); continue; }
          resolved.push({
            note:       pad.receiving_note,
            samplePath: `${root}/${catDir.name}/${file}`,
            label:      file.replace(/\.[^.]+$/, ""),
          });
        }

        lines.push(...await buildPadsIntoRack(track, resolved, update));
        const ok = lines.filter((l) => !l.startsWith("FAILED")).length;
        console.log(`[AI Copilot] agent: built drum kit on "${track.name}" (${ok}/${input.pads.length} pads). Reason: ${input.reasoning}`);
        return [
          `Drum kit built (${ok}/${input.pads.length} pads loaded):`,
          ...lines,
          "",
          readDrumPadMap(track),
          "Use these exact pitches in create_drum_clip.",
        ].join("\n");
      },
    },
  ];
}

// ─── Command: Sound design on a single device (Simpler / DrumRack scope) ──────

async function soundDesignCommand(
  context: ReturnType<typeof initialize>,
  arg: unknown,
): Promise<void> {
  const song = context.application.song!;

  // Resolve the device handle — could be Simpler or DrumRack
  let targetDevice: Device<"1.0.0"> | null = null;
  let sampleInfo = "";

  try {
    const simpler = context.getObjectFromHandle(arg as Handle, Simpler);
    targetDevice = simpler;
    const sample = simpler.sample;
    if (sample) {
      const fp   = sample.filePath;
      const name = (fp.split("/").pop() ?? fp.split("\\").pop() ?? fp) || "unknown";
      sampleInfo = `Loaded sample: "${name}"`;
    }
  } catch {
    try {
      targetDevice = context.getObjectFromHandle(arg as Handle, DrumRack);
    } catch {
      console.warn("[AI Copilot] soundDesign: handle is neither Simpler nor DrumRack.");
      return;
    }
  }

  if (!targetDevice) return;

  const deviceName  = targetDevice.name;
  const parentTrack = song.tracks.find((t) => t.devices.some((d) => d === targetDevice));
  const trackName   = parentTrack?.name ?? "Unknown Track";

  const rawResult = await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(promptUI)}`,
    440, 300,
  );
  const { prompt } = JSON.parse(rawResult) as { prompt: string | null };
  if (!prompt) return;

  await context.ui.withinProgressDialog(
    `AI Copilot — Sound Design: ${deviceName}…`,
    {},
    async (update, abortSignal) => {
      update("Reading device parameters…", 15);

      const sessionCtx  = buildSessionContext(song);
      const paramStates = await readDeviceParams(targetDevice!);
      const deviceText  = formatDeviceStates([{ name: deviceName, params: paramStates }]);
      const soundSkill  = selectSkills({ role: "unknown", prompt });

      update("Thinking…", 35);

      const response = await runGeneration({
        allowWeb: true,
        onProgress: (l) => update(l, 55),
        messages: [
          {
            role: "system",
            content: [
              "You are an expert sound designer inside Ableton Live.",
              "You can read and write every parameter of a synthesizer or sampler device.",
              "Your job: sculpt the sound to match the user's description.",
              "",
              "CRITICAL RULES:",
              "1. Only adjust parameters that are relevant to the request. Leave others alone.",
              "2. Values MUST be within the reported [min, max] range — the host will clamp but avoid it.",
              "3. For quantized (enum) parameters, the value is the INTEGER INDEX into the options list.",
              "4. Use exact device_name and param_name strings from the context below.",
              "5. Think holistically — envelope + filter + modulation together shape the tone.",
              "6. You MAY fetch a URL to research synthesis techniques before deciding.",
              "",
              "═══ SOUND DESIGN KNOWLEDGE ═══",
              soundSkill,
              "══════════════════════════════",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              sessionCtx,
              "",
              "╔══ TARGET DEVICE ════════════════════════════════════════",
              `║  Track:  "${trackName}"`,
              `║  Device: "${deviceName}"`,
              ...(sampleInfo ? [`║  ${sampleInfo}`] : []),
              "╠══ CURRENT PARAMETER STATE ══════════════════════════════",
              deviceText,
              "╚══════════════════════════════════════════════════════════",
              "",
              `USER REQUEST: "${prompt}"`,
              "",
              "Read the parameter list, plan your changes, then call set_device_params. " +
              "Explain each choice in reasoning.",
            ].join("\n"),
          },
        ],
        tools: [SET_DEVICE_PARAMS_TOOL],
        tool_choice: "required",
      });

      if (abortSignal.aborted) return;
      update("Applying changes…", 80);

      for (const call of response.choices[0]?.message?.tool_calls ?? []) {
        if (call.function.name !== "set_device_params") continue;
        const result = JSON.parse(call.function.arguments) as {
          changes:   Array<{ device_name: string; param_name: string; value: number }>;
          reasoning: string;
        };
        const n = await applyDeviceParamChanges(result.changes, [targetDevice!]);
        console.log(
          `[AI Copilot] soundDesign: ${n} param(s) changed on "${deviceName}".\n` +
          `  Reasoning: ${result.reasoning}`,
        );
      }

      update("Done!", 100);
    },
  );
}

// ─── Command: Sound design on ALL devices on a MIDI track ─────────────────────
// Triggered from MidiTrack scope. Reads every device in the chain so the AI
// can shape the instrument + every FX together (e.g. synth + reverb + saturator).

async function soundDesignTrackCommand(
  context: ReturnType<typeof initialize>,
  arg: unknown,
): Promise<void> {
  const song  = context.application.song!;
  const track = context.getObjectFromHandle(arg as Handle, MidiTrack);

  // An empty chain is fine — the model can insert the devices it needs.
  if (track.devices.length === 0) {
    console.log("[AI Copilot] soundDesignTrack: empty device chain — the AI will insert devices as needed.");
  }

  const rawResult = await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(promptUI)}`,
    440, 300,
  );
  const { prompt } = JSON.parse(rawResult) as { prompt: string | null };
  if (!prompt) return;

  await context.ui.withinProgressDialog(
    `AI Copilot — Sound Design: "${track.name}" (${track.devices.length} devices)…`,
    {},
    async (update, abortSignal) => {
      update("Reading all device parameters…", 15);

      const sessionCtx   = buildSessionContext(song);
      const deviceStates = await readAllDeviceStates(track.devices);
      const devicesText  = formatDeviceStates(deviceStates);
      const soundSkill   = selectSkills({ role: "unknown", prompt });

      update("Thinking…", 35);

      const messages: Message[] = [
        {
          role: "system",
          content: [
            "You are an expert sound designer and mix engineer inside Ableton Live.",
            "You have full access to every parameter in a track's complete device chain.",
            "Your job: sculpt the combined sound (instrument + FX) to match the user's description.",
            "",
            "You have TWO tools:",
            "• insert_devices — add built-in Live devices the chain is missing (EQ Eight,",
            "  Compressor, Reverb…). After inserting you receive the new parameters.",
            "• set_device_params — change parameter values on devices in the chain.",
            "If the request needs a device that isn't in the chain (e.g. 'add a low cut'",
            "but there is no EQ), insert it FIRST, then configure it in the next step.",
            "",
            "CRITICAL RULES:",
            "1. You see ALL devices — instrument, effects, utilities. Shape them as a whole.",
            "2. Values MUST be within [min, max]. For quantized params, value = integer index.",
            "3. Use exact device_name and param_name strings from the context.",
            "4. Only change what is relevant. Leave everything else untouched.",
            "5. Never call set_device_params for a device you have not yet seen the parameters of.",
            "",
            "═══ SOUND DESIGN KNOWLEDGE ═══",
            soundSkill,
            "══════════════════════════════",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            sessionCtx,
            "",
            "╔══ TARGET TRACK DEVICE CHAIN ═══════════════════════════",
            `║  Track: "${track.name}"`,
            `║  Chain: ${track.devices.map((d) => `"${d.name}"`).join(" → ")}`,
            "╠══ CURRENT PARAMETER STATE ══════════════════════════════",
            devicesText,
            "╚══════════════════════════════════════════════════════════",
            "",
            `USER REQUEST: "${prompt}"`,
            "",
            "Read all devices above. If the chain is missing a device the request needs, " +
            "insert it first. Then adjust instrument + FX together to achieve the described " +
            "sound with one set_device_params call. Explain each choice in reasoning.",
          ].join("\n"),
        },
      ];

      // Insert→configure loop: the model may insert devices (receiving their fresh
      // parameter lists back) before committing parameter changes. Capped rounds;
      // the final round withholds insert_devices to force configuration.
      const MAX_ROUNDS = 4;
      let configured = false;

      for (let round = 0; round < MAX_ROUNDS && !configured; round++) {
        if (abortSignal.aborted) return;

        const tools = round < MAX_ROUNDS - 1
          ? [INSERT_DEVICES_TOOL, SET_DEVICE_PARAMS_TOOL]
          : [SET_DEVICE_PARAMS_TOOL];
        const response = await chatCompletion({ messages, tools, tool_choice: "required" });
        const msg   = response.choices[0]?.message;
        const calls = msg?.tool_calls ?? [];
        if (calls.length === 0) break;

        messages.push({ role: "assistant", content: msg?.content ?? null, tool_calls: calls });

        for (const call of calls) {
          if (call.function.name === "insert_devices") {
            const args = JSON.parse(call.function.arguments) as {
              devices:   Array<{ device_name: string; index: number }>;
              reasoning: string;
            };
            const resultLines: string[] = [];
            let anyInserted = false;

            for (const d of args.devices) {
              const idx = d.index < 0 || d.index > track.devices.length
                ? track.devices.length
                : Math.round(d.index);
              update(`Inserting ${d.device_name}…`, 55);
              try {
                await track.insertDevice(d.device_name, idx);
                anyInserted = true;
                resultLines.push(`Inserted "${d.device_name}" at chain position ${idx}.`);
                console.log(`[AI Copilot] soundDesignTrack: inserted "${d.device_name}" at index ${idx} on "${track.name}". Reason: ${args.reasoning}`);
              } catch (e) {
                resultLines.push(
                  `FAILED to insert "${d.device_name}": ${(e as Error).message}. ` +
                  "Check it is an exact built-in Live device name.",
                );
                console.warn(`[AI Copilot] soundDesignTrack: insert "${d.device_name}" failed — ${(e as Error).message}`);
              }
            }

            if (anyInserted) {
              update("Reading new device parameters…", 65);
              const newStates = await readAllDeviceStates(track.devices);
              resultLines.push("", "Updated device chain with full parameters:", "", formatDeviceStates(newStates));
              resultLines.push("", "Now call set_device_params to configure the chain.");
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: "insert_devices",
              content: resultLines.join("\n"),
            });
          }

          if (call.function.name === "set_device_params") {
            update("Applying changes…", 80);
            const result = JSON.parse(call.function.arguments) as {
              changes:   Array<{ device_name: string; param_name: string; value: number }>;
              reasoning: string;
            };
            const n = await applyDeviceParamChanges(result.changes, track.devices);
            configured = true;
            console.log(
              `[AI Copilot] soundDesignTrack: ${n} param(s) changed on "${track.name}".\n` +
              `  Reasoning: ${result.reasoning}`,
            );
          }
        }
      }

      update("Done!", 100);
    },
  );
}

// ─── Command: Edit existing MIDI clip ─────────────────────────────────────────

async function editClipCommand(
  context: ReturnType<typeof initialize>,
  arg: unknown,
): Promise<void> {
  const clip = context.getObjectFromHandle(arg as Handle, MidiClip);
  const song = context.application.song!;

  const rawResult = await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(promptUI)}`,
    440, 300,
  );
  const { prompt } = JSON.parse(rawResult) as { prompt: string | null };
  if (!prompt) return;

  await context.ui.withinProgressDialog("AI Copilot — Editing clip…", {}, async (update, abortSignal) => {
    update("Reading session…", 10);

    const sessionCtx   = buildSessionContext(song);
    const currentNotes = clip.notes;
    const clipStart    = beatsToBar(clip.startTime, song.tempo);
    const totalBars    = Math.round(clip.duration / 4);

    // Detect if this clip lives on a drum track.
    // Must check BOTH arrangementClips AND clipSlots — the user may right-click a session-view clip.
    const parentTrack  = song.tracks.find((t) =>
      t instanceof MidiTrack && (
        t.arrangementClips.some((c) => c === clip) ||
        t.clipSlots.some((cs) => cs.clip === clip)
      )
    ) as MidiTrack<"1.0.0"> | undefined;
    const drumMode = parentTrack ? isDrumTrack(parentTrack) : false;
    logTrackRouting("editClip", parentTrack);

    // Build sibling context: what other tracks are playing in this same region
    const siblingCtx = buildSiblingContext(
      song,
      parentTrack?.name ?? "",
      clip.startTime,
      clip.startTime + clip.duration,
    );

    update("Thinking…", 30);

    // ── Drum mode: bar-repeating pattern tool ──────────────────────────────
    if (drumMode) {
      const currentPitches = [...new Set(currentNotes.map((n) => pitchToName(n.pitch)))].join(" ");
      const skills = selectSkills({ role: "drums", prompt });

      const response = await runGeneration({
        allowWeb: true,
        onProgress: (l) => update(l, 45),
        messages: [
          {
            role: "system",
            content: [
              "You are a professional drum programmer inside Ableton Live.",
              "You use the set_drum_pattern tool which takes ONE bar definition and repeats it mechanically.",
              "This guarantees consistency — kicks and snares will be in the same position every bar.",
              "Only use variation_bars for fills (typically the last bar of a 4-bar phrase) or crashes.",
              "",
              DRUM_PITCH_RULE,
              "",
              "CRITICAL: Read the existing arrangement content below BEFORE writing any pattern.",
              "If a bass line exists, lock the kick drum to its root note hits.",
              "If a melody exists, leave breathing room — don't clutter every 16th note.",
              "Your drums must GROOVE WITH what's already there, not ignore it.",
              "",
              "LAYERING RULE — never stack two snare-family hits at the exact same beat:",
              "Snare family = any pad named snare, clap, rim, rimshot, snap, stick, ghost.",
              "Placing snare (38) AND clap (39) both at beat 2.000 creates a doubled/phased",
              "hit — two samples play simultaneously and stack unintentionally. Instead:",
              "  (a) Use ONE snare-family hit per beat position (snare OR clap, not both), OR",
              "  (b) Offset the secondary hit by exactly 0.01 beats for a tight slam effect",
              "      (e.g. snare=2.000, clap=2.010). This gives layering without true stacking.",
              "",
              "═══ PRODUCTION KNOWLEDGE (read and apply these skills) ═══",
              skills,
              "═════════════════════════════════════════════════════════",
              "",
              parentTrack ? readDrumPadMap(parentTrack) : GM_DRUM_MAP,
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              sessionCtx,
              "",
              siblingCtx,
              "",
              "╔══ TARGET DRUM CLIP ══════════════════════════════════════",
              `║  Name:        "${clip.name}"`,
              `║  Position:    ${clipStart}`,
              `║  Duration:    ${clip.duration.toFixed(1)} beats (${totalBars} bars)`,
              `║  Looping:     ${clip.looping ? "yes" : "no"}`,
              `║  Current pitches used: ${currentPitches || "none"}`,
              `║  Current notes (${currentNotes.length} total):`,
              currentNotes.length > 0 ? notesToSummary(currentNotes, 64) : "  (empty — generate from scratch)",
              "╚══════════════════════════════════════════════════════════",
              "",
              parentTrack ? readDrumPadMap(parentTrack) : "",
              "",
              `USER REQUEST: "${prompt}"`,
              "",
              `Define one tight base bar, then the code repeats it across all ${totalBars} bars. ` +
              "Add variation_bars only for fills or crashes. Keep kick and snare rock solid.",
            ].join("\n"),
          },
        ],
        tools: [SET_DRUM_PATTERN_TOOL, RENAME_CLIP_TOOL],
        tool_choice: "required",
      });

      if (abortSignal.aborted) return;
      update("Applying drum pattern…", 80);

      const toolCalls = response.choices[0]?.message?.tool_calls ?? [];
      context.withinTransaction(() => {
        for (const call of toolCalls) {
          const args = JSON.parse(call.function.arguments);
          if (call.function.name === "set_drum_pattern") {
            const result   = args as DrumPatternResult;
            clip.notes     = expandDrumPattern(result, clip.duration);
            clip.color     = CLIP_COLORS.drums;
            logDrumGeneration(`editClip (${clip.notes.length} notes, ${totalBars} bars)`, result, parentTrack);
          }
          if (call.function.name === "rename_clip") {
            clip.name = args.name as string;
          }
        }
        return [];
      });

    // ── Melody / chord / bass mode: standard notes tool ───────────────────
    } else {
      const scaleConstraint = buildScaleConstraint(song);
      const role   = inferTrackRole(parentTrack?.name ?? "", false);
      const skills = selectSkills({ role, prompt });

      const response = await runGeneration({
        allowWeb: true,
        onProgress: (l) => update(l, 45),
        messages: [
          {
            role: "system",
            content: [
              "You are an expert music production assistant embedded inside Ableton Live.",
              "You have full awareness of the session: all tracks, BPM, scale, devices, clips.",
              "When generating or editing a melody clip, you MUST follow the phrasing rules below.",
              "When editing chords or bass, follow normal production rules.",
              "",
              "CRITICAL: Read the existing arrangement content shown below BEFORE writing notes.",
              "If drums exist: fit your rhythm AROUND the kick and snare — don't clash on every beat.",
              "If a bassline exists: your melody must complement its harmonic movement, not copy it.",
              "If a melody exists and you are writing bass: lock your bass root notes to the kick hits.",
              "Study the beat grid / note positions carefully and write something that LOCKS IN.",
              "",
              "═══ PRODUCTION KNOWLEDGE (read and apply these skills) ═══",
              skills,
              "═════════════════════════════════════════════════════════",
              "",
              MELODY_RULES,
              scaleConstraint,
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              sessionCtx,
              "",
              siblingCtx,
              scaleConstraint,
              "",
              "╔══ TARGET CLIP (the one to edit) ═════════════════════════",
              `║  Name:     "${clip.name}"`,
              `║  Position: ${clipStart}`,
              `║  Duration: ${clip.duration.toFixed(1)} beats (${totalBars} bars)`,
              `║  Looping:  ${clip.looping ? "yes" : "no"}`,
              `║  Notes (${currentNotes.length} total):`,
              currentNotes.length > 0
                ? notesToSummary(currentNotes, 128)
                : "  (empty clip — generate from scratch)",
              "╚══════════════════════════════════════════════════════════",
              "",
              `USER REQUEST: "${prompt}"`,
              "",
              "Study the existing content above first, then fit your output to it. " +
              "Write phrase_plan first, then generate sparse notes that groove with what's already there.",
            ].join("\n"),
          },
        ],
        tools: [SET_NOTES_TOOL, RENAME_CLIP_TOOL],
        tool_choice: "required",
      });

      if (abortSignal.aborted) return;
      update("Applying changes…", 80);

      const toolCalls = response.choices[0]?.message?.tool_calls ?? [];
      context.withinTransaction(() => {
        for (const call of toolCalls) {
          const args = JSON.parse(call.function.arguments);
          if (call.function.name === "set_notes") {
            const rawNotes = args.notes as NoteDescription[];
            const { notes, report } = runMelodyValidators(rawNotes, song, {
              maxPerBar: role === "chords" ? 16 : role === "bass" ? 10 : 8,
            });
            clip.notes = notes;
            clip.color = clipColorForTrack(parentTrack?.name ?? "", false);
            console.log(
              `[AI Copilot] set_notes → ${report}\n` +
              `  Phrase plan: ${String(args.phrase_plan)}\n  Reasoning: ${String(args.reasoning)}`,
            );
          }
          if (call.function.name === "rename_clip") {
            clip.name = args.name as string;
            console.log(`[AI Copilot] rename_clip → "${args.name}"`);
          }
        }
        return [];
      });
    }

    update("Done!", 100);
  });
}

// ─── Command: Generate a new MIDI clip ───────────────────────────────────────

async function generateClipCommand(
  context: ReturnType<typeof initialize>,
  arg: unknown,
): Promise<void> {
  const track = context.getObjectFromHandle(arg as Handle, MidiTrack);
  const song  = context.application.song!;

  const rawResult = await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(promptUI)}`,
    440, 300,
  );
  const { prompt } = JSON.parse(rawResult) as { prompt: string | null };
  if (!prompt) return;

  await context.ui.withinProgressDialog("AI Copilot — Generating clip…", {}, async (update, abortSignal) => {
    update("Reading session…", 15);

    const sessionCtx = buildSessionContext(song);
    // Empty track + drum-flavoured prompt → drum branch, where the agent can
    // build a kit from Core Library samples before writing the pattern.
    const drumIntent = /\bdrum|beat\b|kick|snare|hi.?hat|\bhat\b|percussion|groove|\b808\b|drum.?kit/i.test(prompt);
    const drumMode   = isDrumTrack(track) || (track.devices.length === 0 && drumIntent);
    logTrackRouting("generateClip", track);
    if (drumMode && track.devices.length === 0) {
      console.log(`[AI Copilot] generateClip: empty track + drum-intent prompt → drum branch (agent may build a kit).`);
    }

    // For a new clip we default to placing at beat 0 for 16 beats (4 bars) —
    // the AI may override startTime in its tool call. Use that range for sibling context.
    const existingEnd = track.arrangementClips.reduce(
      (max, c) => Math.max(max, c.startTime + c.duration), 0,
    );
    const guessStart = 0;
    const guessEnd   = Math.max(existingEnd, 16);
    const siblingCtx = buildSiblingContext(song, track.name, guessStart, guessEnd);

    update("Thinking…", 30);

    // ── Drum track: bar-repeating pattern ─────────────────────────────────
    if (drumMode) {
      const createDrumTool: ToolDef = {
        type: "function",
        function: {
          name: "create_drum_clip",
          description:
            "Create a new drum clip using a bar-repeating pattern. " +
            "base_pattern defines ONE bar that plays on EVERY bar without exception. " +
            "variation_bars are ADDITIVE — they stack extra hits on top of the base for specific bars. " +
            "Kick and snare always come from base_pattern. variation_bars are only for fills/crashes/accents.",
          strict: true,
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["startTime", "duration", "clipName", "base_pattern", "variation_bars", "reasoning"],
            properties: {
              startTime:  { type: "number", description: "Arrangement position in beats (0 = beginning)" },
              duration:   { type: "number", description: "Clip length in beats (4=1 bar, 16=4 bars, 32=8 bars)" },
              clipName:   { type: "string", description: "Descriptive name" },
              base_pattern: {
                type: "object",
                additionalProperties: false,
                required: ["hits"],
                properties: {
                  hits: {
                    type: "array",
                    description: "Drum hits for ONE bar (repeated mechanically).",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["pitch", "beat", "velocity"],
                      properties: {
                        pitch:    { type: "number", description: "MIDI drum pitch (36=kick, 38=snare, 42=hat…)" },
                        beat:     { type: "number", description: "Position in bar 0.0–3.99 (0=beat1, 1=beat2, 2=beat3, 3=beat4, 0.5=&1…)" },
                        velocity: { type: "number", description: "Velocity 60-127" },
                      },
                    },
                  },
                },
              },
              variation_bars: {
                type: "array",
                description: "ADDITIVE extra hits stacked ON TOP of base_pattern for specific bars. Use for fills/crashes only. Leave [] if none.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["bar_index", "hits"],
                  properties: {
                    bar_index: { type: "number", description: "0-based bar index to override" },
                    hits: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["pitch", "beat", "velocity"],
                        properties: {
                          pitch:    { type: "number" },
                          beat:     { type: "number" },
                          velocity: { type: "number" },
                        },
                      },
                    },
                  },
                },
              },
              reasoning: { type: "string", description: "Describe the groove and any variations" },
            },
          },
        },
      };

      const createDrumClipAgentTool: AgentTool = {
        def: createDrumTool,
        handler: async (args) => {
          const input = args as unknown as {
            startTime: number; duration: number; clipName: string;
            base_pattern: { hits: DrumHit[] };
            variation_bars: Array<{ bar_index: number; hits: DrumHit[] }>;
            reasoning: string;
          };
          const patternResult: DrumPatternResult = {
            base_pattern:   input.base_pattern,
            variation_bars: input.variation_bars,
            reasoning:      input.reasoning,
          };
          update(`Creating "${input.clipName}"…`, 60);
          const clip  = await track.createMidiClip(input.startTime, input.duration);
          clip.name   = input.clipName;
          clip.notes  = expandDrumPattern(patternResult, input.duration);
          clip.color  = CLIP_COLORS.drums;
          logDrumGeneration(
            `generateClip "${input.clipName}" (${clip.notes.length} notes, ${Math.round(input.duration / 4)} bars)`,
            patternResult,
            track,
          );
          return `Created drum clip "${input.clipName}" — ${clip.notes.length} notes across ${Math.round(input.duration / 4)} bars at beat ${input.startTime}.`;
        },
      };

      await runAgent({
        abortSignal,
        onProgress: (l) => update(l, 45),
        tools: [
          createDrumClipAgentTool,
          ...makeDrumKitAgentTools(track, update),
          ...makeDeviceAgentTools(track, update),
          makeFetchUrlAgentTool(update),
        ],
        messages: [
          {
            role: "system",
            content: [
              "You are a professional drum programmer and mix engineer agent inside Ableton Live.",
              "Fulfill the user's ENTIRE request step by step using your tools:",
              "• list_drum_kits / load_drum_kit — load one of Live's ready-made kits",
              "• list_drum_samples / create_drum_kit — or build a custom kit sample-by-sample",
              "  (a kit step is REQUIRED FIRST if the track has no Drum Rack — check the pad map",
              "   below: if it is the generic GM fallback, get a kit that fits the requested genre.",
              "   Prefer load_drum_kit; build a custom kit when the user asks for specific sounds",
              "   or no preset fits. Then use the returned pad pitches for the pattern.)",
              "• create_drum_clip — write the MIDI pattern",
              "• read_device_params / insert_devices / set_device_params — device & FX work",
              "  (e.g. 'add glue and saturation' → insert Glue Compressor + Saturator, then configure)",
              "• fetch_url — research references the user points you to",
              "Work in order: kit (if needed) → MIDI → devices. When EVERYTHING the user asked for",
              "is done, reply with a one-paragraph text summary and NO further tool calls.",
              "If the request is only about MIDI, do not touch devices.",
              "",
              "Use create_drum_clip with ONE base bar that repeats perfectly every bar.",
              "This guarantees kick/snare lock — no drift across bars.",
              "Only override via variation_bars for fills on bar 4, 8, etc.",
              "",
              DRUM_PITCH_RULE,
              "",
              "CRITICAL: Read the existing arrangement content carefully BEFORE writing any pattern.",
              "If a bassline exists: lock the kick drum to its root note hit positions.",
              "If a melody exists: leave space — don't put hi-hats on every note the melody plays.",
              "Your groove must feel INTENTIONALLY written for this specific session, not generic.",
              "",
              "LAYERING RULE — never stack two snare-family hits at the exact same beat:",
              "Snare family = any pad named snare, clap, rim, rimshot, snap, stick, ghost.",
              "Placing snare (38) AND clap (39) both at beat 2.000 creates a doubled/phased",
              "hit — two samples play simultaneously and stack unintentionally. Instead:",
              "  (a) Use ONE snare-family hit per beat position (snare OR clap, not both), OR",
              "  (b) Offset the secondary hit by exactly 0.01 beats for a tight slam effect",
              "      (e.g. snare=2.000, clap=2.010). This gives layering without true stacking.",
              "",
              "═══ PRODUCTION KNOWLEDGE (read and apply these skills) ═══",
              selectSkills({ role: "drums", prompt }),
              "═════════════════════════════════════════════════════════",
              "",
              readDrumPadMap(track),
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              sessionCtx,
              "",
              siblingCtx,
              "",
              "╔══ TARGET DRUM TRACK ═══════════════════════════════════",
              `║  Track: "${track.name}"`,
              `║  Existing clips: ${track.arrangementClips.length}`,
              "╚══════════════════════════════════════════════════════════",
              "",
              readDrumPadMap(track),
              "",
              `USER REQUEST: "${prompt}"`,
              "",
              "Study the beat grids / note positions of the existing tracks above first. " +
              "Then define a base bar where the kick locks to the bass, and hi-hats leave room for the melody. " +
              "The code handles repetition — just define one tight bar. " +
              "After the clip is written, handle any device/FX part of the request before finishing.",
            ].join("\n"),
          },
        ],
      });

    // ── Melody / chord / bass track ───────────────────────────────────────
    } else {
      const scaleConstraint = buildScaleConstraint(song);
      const role   = inferTrackRole(track.name, false);
      const skills = selectSkills({ role, prompt });

      const createClipTool: ToolDef = {
        type: "function",
        function: {
          name: "create_clip",
          description:
            "Create a new MIDI clip. For melodies: plan phrases in phrase_plan first, then place sparse notes with gaps. " +
            "Silence = absence of notes. Never end one note exactly where the next begins.",
          strict: true,
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["startTime", "duration", "clipName", "phrase_plan", "notes", "reasoning"],
            properties: {
              startTime:   { type: "number", description: "Arrangement position in beats" },
              duration:    { type: "number", description: "Clip length in beats (4=1 bar, 16=4 bars)" },
              clipName:    { type: "string", description: "Descriptive name" },
              phrase_plan: {
                type: "string",
                description: "Plan phrases BEFORE notes. e.g. 'Phrase 1: beats 0-6 (3 notes), 2 beat rest. Phrase 2: beats 8-14…'",
              },
              notes: {
                type: "array",
                description: "MIDI notes. For melodies: 3-7/bar, varied velocity (60-110), mix short+long durations.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["pitch", "startTime", "duration", "velocity"],
                  properties: {
                    pitch:     { type: "number", description: "MIDI pitch 0-127 (60=C4)" },
                    startTime: { type: "number", description: "Offset from clip start in beats" },
                    duration:  { type: "number", description: "Duration in beats — shorter than gap to next note" },
                    velocity:  { type: "number", description: "Velocity 60-110 — vary every note" },
                  },
                },
              },
              reasoning: { type: "string", description: "What you generated and why it fits" },
            },
          },
        },
      };

      const createClipAgentTool: AgentTool = {
        def: createClipTool,
        handler: async (args) => {
          const input = args as unknown as {
            startTime: number; duration: number; clipName: string;
            phrase_plan: string; notes: NoteDescription[]; reasoning: string;
          };
          const { notes, report } = runMelodyValidators(input.notes, song, {
            maxPerBar: role === "chords" ? 16 : role === "bass" ? 10 : 8,
          });
          update(`Creating "${input.clipName}"…`, 60);
          const clip = await track.createMidiClip(input.startTime, input.duration);
          clip.name  = input.clipName;
          clip.notes = notes;
          clip.color = clipColorForTrack(track.name, false);
          console.log(
            `[AI Copilot] Created "${input.clipName}" (${input.duration} beats) — ${report}.\n` +
            `  Phrase plan: ${input.phrase_plan}\n  Reasoning: ${input.reasoning}`,
          );
          return `Created clip "${input.clipName}" — ${notes.length} notes, ${input.duration} beats at beat ${input.startTime} (validators: ${report}).`;
        },
      };

      await runAgent({
        abortSignal,
        onProgress: (l) => update(l, 45),
        tools: [
          createClipAgentTool,
          ...makeDeviceAgentTools(track, update),
          makeFetchUrlAgentTool(update),
        ],
        messages: [
          {
            role: "system",
            content: [
              "You are an expert music producer, composer, and mix engineer agent inside Ableton Live.",
              "You can see the full session — all tracks, clips, devices, and mixer state.",
              "Fulfill the user's ENTIRE request step by step using your tools:",
              "• create_clip — write the MIDI (usually the first step)",
              "• read_device_params / insert_devices / set_device_params — device & FX work",
              "  (e.g. 'add reverb and a low cut' → insert Reverb + EQ Eight, then configure)",
              "• fetch_url — research references the user points you to",
              "If the track has NO instrument (empty device chain), the clip will be silent —",
              "insert one first (Drift or Wavetable for synths/pads, Electric for keys, Operator",
              "for FM/bells) and sound-design it with set_device_params to fit the request.",
              "Work in order: instrument (if needed) → MIDI → FX. When EVERYTHING the user asked",
              "for is done, reply with a one-paragraph text summary and NO further tool calls.",
              "If the request is only about MIDI, do not touch devices.",
              "",
              "CRITICAL: Read the existing arrangement content shown below BEFORE writing any notes.",
              "If drums exist: look at the kick/snare positions and fit your rhythm around them.",
              "If bass exists and you are writing melody: complement its harmonic motion, don't copy it.",
              "If melody exists and you are writing bass: root notes should lock to kick drum hits.",
              "Your part must sound like it was written FOR this session, not dropped in from elsewhere.",
              "",
              "═══ PRODUCTION KNOWLEDGE (read and apply these skills) ═══",
              skills,
              "═════════════════════════════════════════════════════════",
              "",
              MELODY_RULES,
              scaleConstraint,
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              sessionCtx,
              "",
              siblingCtx,
              scaleConstraint,
              "",
              "╔══ TARGET TRACK ════════════════════════════════════════",
              `║  Generating a new clip on: "${track.name}"`,
              `║  Existing arrangement clips: ${track.arrangementClips.length}`,
              "╚══════════════════════════════════════════════════════════",
              "",
              `USER REQUEST: "${prompt}"`,
              "",
              "Study the existing content in this region first — beat grids, note positions, pitches. " +
              "Then fill phrase_plan and write notes that lock in with what's already there. " +
              "Sparse phrasing — rests are as important as notes. " +
              "After the clip is written, handle any device/FX part of the request before finishing.",
            ].join("\n"),
          },
        ],
      });
    }

    update("Done!", 100);
  });
}

// ─── Command: Analyze full session ────────────────────────────────────────────

async function analyzeSessionCommand(
  context: ReturnType<typeof initialize>,
): Promise<void> {
  const song = context.application.song!;

  await context.ui.withinProgressDialog("AI Copilot — Analyzing session…", {}, async (update) => {
    update("Reading session…", 20);
    const sessionCtx = buildSessionContext(song);

    update("Thinking…", 40);

    const response = await chatCompletion({
      messages: [
        {
          role: "user",
          content: [
            sessionCtx,
            "",
            "Analyze this Ableton Live session and give a concise, actionable critique.",
            "Reply in exactly 3 sections:",
            "1. ✅ What's working (be specific about tracks/clips)",
            "2. ⚠️  What's missing or unbalanced (reference specific tracks)",
            "3. 🎯 Top 3 next actions (concrete, not generic)",
            "",
            "Be direct and musical. Reference track names and specific musical details.",
          ].join("\n"),
        },
      ],
    });

    const analysis = response.choices[0]?.message?.content ?? "No analysis returned.";
    update("Displaying analysis…", 90);

    const html = analysisUI.replace(
      "{{ANALYSIS}}",
      analysis.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>"),
    );
    await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 520, 460);

    update("Done!", 100);
  });
}

// ─── Command: Fill arrangement selection across multiple tracks ───────────────
// Triggered via MidiTrack.ArrangementSelection — user selects a time range on
// one or more MIDI tracks in the arrangement view, then right-clicks.
// ArrangementSelection = { selected_lanes: Handle[], time_selection_start: number, time_selection_end: number }

async function fillArrangementSelectionCommand(
  context: ReturnType<typeof initialize>,
  arg: unknown,
): Promise<void> {
  const selection = arg as {
    selected_lanes: Handle[];
    time_selection_start: number;
    time_selection_end: number;
  };

  const song        = context.application.song!;
  const startBeat   = selection.time_selection_start;
  const endBeat     = selection.time_selection_end;
  const duration    = endBeat - startBeat;
  const totalBars   = Math.round(duration / 4);

  if (duration <= 0 || selection.selected_lanes.length === 0) {
    console.warn("[AI Copilot] fillArrangementSelection: empty selection, nothing to do.");
    return;
  }

  // Resolve handles → MidiTrack objects
  const tracks = selection.selected_lanes
    .map((h) => {
      try { return context.getObjectFromHandle(h, MidiTrack); }
      catch { return null; }
    })
    .filter((t): t is MidiTrack<"1.0.0"> => t !== null);

  if (tracks.length === 0) return;

  const rawResult = await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(promptUI)}`,
    440, 300,
  );
  const { prompt } = JSON.parse(rawResult) as { prompt: string | null };
  if (!prompt) return;

  await context.ui.withinProgressDialog(
    `AI Copilot — Filling ${tracks.length} track(s) × ${totalBars} bar(s)…`,
    {},
    async (update, abortSignal) => {
      update("Reading session…", 10);
      const sessionCtx = buildSessionContext(song);
      const scaleConstraint = buildScaleConstraint(song);

      const trackSummary = tracks
        .map((t) => `  • "${t.name}" (${isDrumTrack(t) ? "drums" : "MIDI"})`)
        .join("\n");

      // Build one tool that generates clips for ALL selected tracks at once
      const fillSelectionTool: ToolDef = {
        type: "function",
        function: {
          name: "fill_tracks",
          description:
            "Generate MIDI clips for multiple tracks simultaneously within a specific arrangement region. " +
            "Return one entry per track. Match the musical role of each track name.",
          strict: true,
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["tracks", "reasoning"],
            properties: {
              tracks: {
                type: "array",
                description: "One entry per selected track.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["track_name", "clip_name", "phrase_plan", "notes"],
                  properties: {
                    track_name: { type: "string", description: "Must match one of the selected track names exactly." },
                    clip_name:  { type: "string", description: "Descriptive name for this clip." },
                    phrase_plan: {
                      type: "string",
                      description: "Plan your phrases before writing notes. e.g. 'Phrase 1: beats 0–6, rest 2 beats. Phrase 2: beats 8–14…'",
                    },
                    notes: {
                      type: "array",
                      description: "MIDI notes. Silence = gaps between notes. For melody: 3-7 notes/bar, varied velocities.",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["pitch", "startTime", "duration", "velocity"],
                        properties: {
                          pitch:     { type: "number", description: "MIDI pitch 0-127" },
                          startTime: { type: "number", description: "Offset from clip start in beats (NOT arrangement position)" },
                          duration:  { type: "number", description: "Duration in beats" },
                          velocity:  { type: "number", description: "Velocity 60-110, vary every note" },
                        },
                      },
                    },
                  },
                },
              },
              reasoning: { type: "string", description: "How these parts work together musically." },
            },
          },
        },
      };

      update("Thinking…", 30);

      const response = await chatCompletion({
        messages: [
          {
            role: "system",
            content: [
              "You are an expert music producer inside Ableton Live.",
              "You are filling multiple tracks simultaneously in a specific arrangement region.",
              "Each track gets its own clip. Parts must be complementary — do not double every track.",
              "Match each track's musical role (bass stays low, melody stays sparse, etc.).",
              "",
              DRUM_PITCH_RULE,
              "",
              MELODY_RULES,
              scaleConstraint,
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              sessionCtx,
              scaleConstraint,
              "",
              "╔══ ARRANGEMENT SELECTION ═══════════════════════════════════",
              `║  Region:  beat ${startBeat.toFixed(1)} → beat ${endBeat.toFixed(1)}  (${totalBars} bars)`,
              `║  Tracks to fill (${tracks.length}):`,
              trackSummary,
              "╚══════════════════════════════════════════════════════════",
              "",
              // Pad maps for every drum track in the selection — without these the
              // model has no idea which pitches map to which sounds.
              ...tracks.filter(isDrumTrack).map(
                (t) => `Drum track "${t.name}" pad map:\n${readDrumPadMap(t)}\n`,
              ),
              `USER REQUEST: "${prompt}"`,
              "",
              "Generate one cohesive part per track. All parts must work together.",
              "For each track, plan phrases first in phrase_plan, then write sparse notes.",
              "Note startTime is relative to the clip start (beat 0), not the arrangement position.",
            ].join("\n"),
          },
        ],
        tools: [fillSelectionTool],
        tool_choice: "required",
      });

      if (abortSignal.aborted) return;
      update("Writing to arrangement…", 80);

      const toolCalls = response.choices[0]?.message?.tool_calls ?? [];
      for (const call of toolCalls) {
        if (call.function.name !== "fill_tracks") continue;
        const result = JSON.parse(call.function.arguments) as {
          tracks: Array<{
            track_name: string;
            clip_name: string;
            phrase_plan: string;
            notes: NoteDescription[];
          }>;
          reasoning: string;
        };

        for (const entry of result.tracks) {
          const track = tracks.find(
            (t) => t.name.toLowerCase() === entry.track_name.toLowerCase(),
          );
          if (!track) {
            console.warn(`[AI Copilot] fillArrangement: no track found for "${entry.track_name}", skipping.`);
            continue;
          }

          const rawNotes   = entry.notes as NoteDescription[];
          const drumTrack  = isDrumTrack(track);
          // Apply full validator pipeline for melody/bass tracks (scale snap, density, gaps, velocity).
          // Drum tracks get their notes via the melody tool here so just enforce gaps (drum pitches
          // are not in-key notes and shouldn't be scale-snapped).
          const { notes: validatedNotes, report } = drumTrack
            ? { notes: enforceGaps(rawNotes, 0.125), report: "drums: gaps only" }
            : runMelodyValidators(rawNotes, song);
          const clip     = await track.createMidiClip(startBeat, duration);
          clip.name      = entry.clip_name;
          clip.notes     = validatedNotes;
          clip.color     = clipColorForTrack(track.name, drumTrack);
          console.log(
            `[AI Copilot] fillArrangement → "${track.name}": clip "${entry.clip_name}" ` +
            `(${validatedNotes.length} notes, ${totalBars} bars)  [${report}]\n  ${entry.phrase_plan}`,
          );
          if (drumTrack) {
            logDrumPadUsage(
              `fillArrangement "${entry.clip_name}" on "${track.name}"`,
              validatedNotes.map((n) => n.pitch),
              track,
              [`  Phrase plan: ${entry.phrase_plan}`],
            );
          }
        }

        console.log(`[AI Copilot] fillArrangement reasoning: ${result.reasoning}`);
      }

      update("Done!", 100);
    },
  );
}

// ─── Command: Fill multiple selected Session View clip slots ──────────────────
// Triggered via ClipSlotSelection — user selects multiple slots in Session View
// and right-clicks. ClipSlotSelection = { selected_clip_slots: Handle[] }

async function fillClipSlotSelectionCommand(
  context: ReturnType<typeof initialize>,
  arg: unknown,
): Promise<void> {
  const selection = arg as { selected_clip_slots: Handle[] };
  const song      = context.application.song!;

  if (selection.selected_clip_slots.length === 0) return;

  // Resolve handles → ClipSlots, then find their parent tracks
  const slots = selection.selected_clip_slots
    .map((h) => {
      try { return context.getObjectFromHandle(h, ClipSlot); }
      catch { return null; }
    })
    .filter((s): s is ClipSlot<"1.0.0"> => s !== null);

  if (slots.length === 0) return;

  const rawResult = await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(promptUI)}`,
    440, 300,
  );
  const { prompt } = JSON.parse(rawResult) as { prompt: string | null };
  if (!prompt) return;

  await context.ui.withinProgressDialog(
    `AI Copilot — Filling ${slots.length} slot(s)…`,
    {},
    async (update, abortSignal) => {
      update("Reading session…", 10);
      const sessionCtx      = buildSessionContext(song);
      const scaleConstraint = buildScaleConstraint(song);

      update("Thinking…", 30);

      // Process each slot sequentially
      let done = 0;
      for (const slot of slots) {
        if (abortSignal.aborted) break;

        // Find the parent track for this slot
        const parentTrack = song.tracks.find(
          (t) => t instanceof MidiTrack &&
                 t.clipSlots.some((cs) => cs === slot),
        ) as MidiTrack<"1.0.0"> | undefined;

        const trackName  = parentTrack?.name ?? "Unknown Track";
        const drumMode   = parentTrack ? isDrumTrack(parentTrack) : false;
        logTrackRouting("fillClipSlot", parentTrack);

        update(`Generating for "${trackName}"… (${done + 1}/${slots.length})`, 30 + (done / slots.length) * 50);

        if (drumMode && parentTrack) {
          // Drum slot — use bar-repeating pattern
          const response = await runGeneration({
            allowWeb: true,
            onProgress: (l) => update(l, 45),
            messages: [
              {
                role: "system",
                content: [
                  "You are a professional drum programmer inside Ableton Live.",
                  "Define ONE base bar that repeats. Use variation_bars only for fills.",
                  "",
                  DRUM_PITCH_RULE,
                  "",
                  "LAYERING RULE — never stack two snare-family hits at the exact same beat:",
                  "Snare family = any pad named snare, clap, rim, rimshot, snap, stick, ghost.",
                  "Two snare-family sounds at the same beat (e.g. snare=2.000 AND clap=2.000)",
                  "create a doubled/phased hit. Use ONE per beat, OR offset by 0.01 beats.",
                  "",
                  readDrumPadMap(parentTrack),
                ].join("\n"),
              },
              {
                role: "user",
                content: [
                  sessionCtx,
                  "",
                  `Filling a Session View slot on drum track: "${trackName}"`,
                  readDrumPadMap(parentTrack),
                  "",
                  `USER REQUEST: "${prompt}"`,
                ].join("\n"),
              },
            ],
            tools: [SET_DRUM_PATTERN_TOOL],
            tool_choice: "required",
          });

          for (const call of response.choices[0]?.message?.tool_calls ?? []) {
            if (call.function.name !== "set_drum_pattern") continue;
            const result     = JSON.parse(call.function.arguments) as DrumPatternResult;
            const clipLength = 16; // 4 bars default for session clips
            const clip       = await slot.createMidiClip(clipLength);
            clip.notes       = expandDrumPattern(result, clipLength);
            clip.color       = CLIP_COLORS.drums;
            logDrumGeneration(`fillClipSlot on "${trackName}" (${clip.notes.length} notes)`, result, parentTrack);
          }

        } else {
          // Melody / chord / bass slot
          const response = await runGeneration({
            allowWeb: true,
            onProgress: (l) => update(l, 45),
            messages: [
              {
                role: "system",
                content: [
                  "You are an expert music producer inside Ableton Live.",
                  "Generate a Session View clip for one track.",
                  MELODY_RULES,
                  scaleConstraint,
                ].join("\n"),
              },
              {
                role: "user",
                content: [
                  sessionCtx,
                  scaleConstraint,
                  "",
                  `Filling a Session View slot on track: "${trackName}"`,
                  `USER REQUEST: "${prompt}"`,
                  "Clip length: 16 beats (4 bars). Plan phrases first, then write sparse notes.",
                ].join("\n"),
              },
            ],
            tools: [SET_NOTES_TOOL],
            tool_choice: "required",
          });

          for (const call of response.choices[0]?.message?.tool_calls ?? []) {
            if (call.function.name !== "set_notes") continue;
            const args     = JSON.parse(call.function.arguments);
            const rawNotes = args.notes as NoteDescription[];
            // Full validator pipeline: scale snap + density clamp + gap enforce + velocity humanize.
            const { notes: validatedNotes, report } = runMelodyValidators(rawNotes, song);
            const clip     = await slot.createMidiClip(16);
            clip.notes     = validatedNotes;
            clip.color     = clipColorForTrack(trackName, false);
            console.log(`[AI Copilot] fillClipSlot "${trackName}": ${report}`);
          }
        }

        done++;
      }

      update("Done!", 100);
    },
  );
}

// ─── Clip snapshot helper ─────────────────────────────────────────────────────
// Since clip.startTime is read-only, "moving" a clip requires:
//   1. Snapshot all data  2. deleteClip()  3. createMidiClip() at new position

interface ClipSnapshot {
  name:     string;
  duration: number;
  color:    number;
  looping:  boolean;
  muted:    boolean;
  notes:    NoteDescription[];
}

function snapshotClip(clip: MidiClip<"1.0.0">): ClipSnapshot {
  return {
    name:    clip.name,
    duration: clip.duration,
    color:   clip.color,
    looping: clip.looping,
    muted:   clip.muted,
    notes:   [...clip.notes],
  };
}

async function restoreClipAt(
  track: MidiTrack<"1.0.0">,
  snap: ClipSnapshot,
  newStart: number,
): Promise<MidiClip<"1.0.0">> {
  const clip   = await track.createMidiClip(newStart, snap.duration);
  clip.name    = snap.name;
  clip.color   = snap.color;
  clip.looping = snap.looping;
  clip.muted   = snap.muted;
  clip.notes   = snap.notes;
  return clip;
}

// ─── Command: Rearrange existing clips in the arrangement ─────────────────────
// Triggered via Scene right-click. Reads every clip across every MIDI track,
// asks AI to propose new positions, then moves clips using snapshot-delete-recreate.

async function rearrangeArrangementCommand(
  context: ReturnType<typeof initialize>,
): Promise<void> {
  const song = context.application.song!;

  const midiTracks = song.tracks.filter(
    (t): t is MidiTrack<"1.0.0"> => t instanceof MidiTrack && t.arrangementClips.length > 0,
  );

  if (midiTracks.length === 0) {
    console.warn("[AI Copilot] rearrange: no MIDI tracks with arrangement clips found.");
    return;
  }

  const rawResult = await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(promptUI)}`,
    440, 300,
  );
  const { prompt } = JSON.parse(rawResult) as { prompt: string | null };
  if (!prompt) return;

  await context.ui.withinProgressDialog("AI Copilot — Rearranging…", {}, async (update, abortSignal) => {
    update("Reading arrangement…", 10);

    // Build a map of all clips per track
    type TrackClipEntry = { track: MidiTrack<"1.0.0">; clip: MidiClip<"1.0.0">; startBeat: number; duration: number };
    const allClips: TrackClipEntry[] = [];

    for (const track of midiTracks) {
      for (const clip of track.arrangementClips) {
        if (clip instanceof MidiClip) {
          allClips.push({ track, clip, startBeat: clip.startTime, duration: clip.duration });
        }
      }
    }

    // Format current layout for GPT
    const currentLayout = allClips
      .sort((a, b) => a.startBeat - b.startBeat)
      .map(
        (e) =>
          `  track="${e.track.name}"  clip="${e.clip.name}"  ` +
          `start=${e.startBeat.toFixed(1)} beats (bar ${Math.floor(e.startBeat / 4) + 1})  ` +
          `duration=${e.duration.toFixed(1)} beats (${Math.round(e.duration / 4)} bars)`,
      )
      .join("\n");

    const REARRANGE_TOOL: ToolDef = {
      type: "function",
      function: {
        name: "rearrange_clips",
        description:
          "Propose new arrangement positions for existing clips. " +
          "Only output clips that need to MOVE — omit clips that stay in place. " +
          "Do not change clip durations. track_name and clip_name must exactly match existing values.",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["moves", "reasoning"],
          properties: {
            moves: {
              type: "array",
              description: "List of clips to move. Empty array = no changes.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["track_name", "clip_name", "new_start_beat"],
                properties: {
                  track_name:     { type: "string", description: "Exact track name (copy from layout above)" },
                  clip_name:      { type: "string", description: "Exact clip name (copy from layout above)" },
                  new_start_beat: { type: "number", description: "New start position in beats (0 = arrangement start)" },
                  new_name:       { type: "string", description: "Optional: rename the clip at its new position" },
                },
              },
            },
            reasoning: {
              type: "string",
              description: "Describe the new song structure — what went where and why.",
            },
          },
        },
      },
    };

    update("Thinking…", 30);

    const response = await chatCompletion({
      messages: [
        {
          role: "system",
          content: [
            "You are an expert music producer and arranger working inside Ableton Live.",
            "You can see all clips in the arrangement and you will propose a better song structure.",
            "Think in terms of song sections: intro, verse, pre-chorus, chorus, bridge, breakdown, outro.",
            "A bar = 4 beats. Typical section lengths: 8 bars (32 beats), 16 bars (64 beats).",
            "Only move clips that need to change position — leave others in place.",
            "Do not change clip durations. track_name and clip_name must match EXACTLY.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            buildSessionContext(song),
            "",
            "╔══ CURRENT ARRANGEMENT LAYOUT ══════════════════════════════",
            currentLayout,
            "╚══════════════════════════════════════════════════════════",
            "",
            `USER REQUEST: "${prompt}"`,
            "",
            "Propose new positions for clips that need to move. ",
            "Return only clips that change position — omit clips that stay where they are.",
          ].join("\n"),
        },
      ],
      tools: [REARRANGE_TOOL],
      tool_choice: "required",
    });

    if (abortSignal.aborted) return;
    update("Moving clips…", 70);

    const toolCalls = response.choices[0]?.message?.tool_calls ?? [];
    for (const call of toolCalls) {
      if (call.function.name !== "rearrange_clips") continue;
      const plan = JSON.parse(call.function.arguments) as {
        moves: Array<{ track_name: string; clip_name: string; new_start_beat: number; new_name?: string }>;
        reasoning: string;
      };

      if (plan.moves.length === 0) {
        console.log("[AI Copilot] rearrange: AI proposed no changes.");
        update("No changes needed.", 100);
        return;
      }

      console.log(`[AI Copilot] rearrange: ${plan.moves.length} moves.\n  ${plan.reasoning}`);

      // Snapshot all clips that need to move BEFORE deleting anything
      type MoveTask = {
        track: MidiTrack<"1.0.0">;
        snap: ClipSnapshot;
        newStart: number;
        newName?: string;
      };
      const tasks: MoveTask[] = [];

      for (const move of plan.moves) {
        const track = midiTracks.find((t) => t.name === move.track_name);
        if (!track) {
          console.warn(`[AI Copilot] rearrange: track "${move.track_name}" not found, skipping.`);
          continue;
        }
        const clip = track.arrangementClips.find(
          (c) => c instanceof MidiClip && c.name === move.clip_name,
        ) as MidiClip<"1.0.0"> | undefined;
        if (!clip) {
          console.warn(`[AI Copilot] rearrange: clip "${move.clip_name}" not found on "${move.track_name}", skipping.`);
          continue;
        }
        tasks.push({ track, snap: snapshotClip(clip), newStart: move.new_start_beat, newName: move.new_name });
      }

      // Delete originals first
      for (const task of tasks) {
        const clip = task.track.arrangementClips.find(
          (c) => c instanceof MidiClip && c.name === task.snap.name,
        ) as MidiClip<"1.0.0"> | undefined;
        if (clip) await task.track.deleteClip(clip);
      }

      // Recreate at new positions
      for (const task of tasks) {
        const newClip = await restoreClipAt(task.track, task.snap, task.newStart);
        if (task.newName) newClip.name = task.newName;
        console.log(
          `[AI Copilot] moved "${task.snap.name}" on "${task.track.name}" → ` +
          `beat ${task.newStart} (bar ${Math.floor(task.newStart / 4) + 1})`,
        );
      }
    }

    update("Done!", 100);
  });
}

// ─── Command: Build a full arrangement from scratch on existing tracks ─────────
// Triggered via Scene right-click. AI designs a complete song structure —
// sections, clip positions, MIDI content — and writes it all into the arrangement.

async function buildArrangementCommand(
  context: ReturnType<typeof initialize>,
): Promise<void> {
  const song = context.application.song!;

  const midiTracks = song.tracks.filter(
    (t): t is MidiTrack<"1.0.0"> => t instanceof MidiTrack,
  );

  if (midiTracks.length === 0) {
    console.warn("[AI Copilot] buildArrangement: no MIDI tracks found.");
    return;
  }

  const rawResult = await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(promptUI)}`,
    440, 320,
  );
  const { prompt } = JSON.parse(rawResult) as { prompt: string | null };
  if (!prompt) return;

  await context.ui.withinProgressDialog("AI Copilot — Building arrangement…", {}, async (update, abortSignal) => {
    update("Reading session…", 5);

    const sessionCtx      = buildSessionContext(song);
    const scaleConstraint = buildScaleConstraint(song);

    const trackList = midiTracks
      .map((t) => `  • "${t.name}" (${isDrumTrack(t) ? "drums" : "MIDI"})`)
      .join("\n");

    const BUILD_ARRANGEMENT_TOOL: ToolDef = {
      type: "function",
      function: {
        name: "build_arrangement",
        description:
          "Design and populate a full arrangement across multiple tracks. " +
          "Each clip gets a name, position, length, and MIDI content. " +
          "For drum tracks use drum_pattern (bar-repeating). For melody/bass tracks use notes + phrase_plan.",
        strict: false, // allow optional fields (drum_pattern vs notes)
        parameters: {
          type: "object",
          required: ["sections", "clips", "reasoning"],
          properties: {
            sections: {
              type: "array",
              description: "High-level song sections for the arrangement.",
              items: {
                type: "object",
                required: ["name", "start_beat", "duration_beats"],
                properties: {
                  name:           { type: "string", description: "e.g. Intro, Verse 1, Chorus, Bridge, Outro" },
                  start_beat:     { type: "number", description: "Section start in beats" },
                  duration_beats: { type: "number", description: "Section length in beats (32=8 bars, 64=16 bars)" },
                },
              },
            },
            clips: {
              type: "array",
              description: "All clips to create. One clip per track per section (or per role).",
              items: {
                type: "object",
                required: ["track_name", "clip_name", "start_beat", "duration_beats"],
                properties: {
                  track_name:     { type: "string", description: "Must match an existing track name exactly." },
                  clip_name:      { type: "string", description: "Descriptive name, e.g. 'Verse Bass', 'Chorus Lead'" },
                  start_beat:     { type: "number", description: "Clip start in beats (0 = arrangement start)" },
                  duration_beats: { type: "number", description: "Clip length in beats" },
                  // Drum tracks
                  drum_pattern: {
                    type: "object",
                    description: "Use this for drum tracks. Define one base bar that repeats.",
                    properties: {
                      base_pattern: {
                        type: "object",
                        properties: {
                          hits: {
                            type: "array",
                            items: {
                              type: "object",
                              required: ["pitch", "beat", "velocity"],
                              properties: {
                                pitch:    { type: "number" },
                                beat:     { type: "number" },
                                velocity: { type: "number" },
                              },
                            },
                          },
                        },
                      },
                      variation_bars: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["bar_index", "hits"],
                          properties: {
                            bar_index: { type: "number" },
                            hits: {
                              type: "array",
                              items: {
                                type: "object",
                                required: ["pitch", "beat", "velocity"],
                                properties: {
                                  pitch:    { type: "number" },
                                  beat:     { type: "number" },
                                  velocity: { type: "number" },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  // Melody / bass / chord tracks
                  phrase_plan: { type: "string", description: "Plan your phrases before notes." },
                  notes: {
                    type: "array",
                    description: "Use for non-drum tracks. 3-7 notes/bar, leave gaps for silence.",
                    items: {
                      type: "object",
                      required: ["pitch", "startTime", "duration", "velocity"],
                      properties: {
                        pitch:     { type: "number" },
                        startTime: { type: "number", description: "Offset from clip start in beats" },
                        duration:  { type: "number" },
                        velocity:  { type: "number" },
                      },
                    },
                  },
                },
              },
            },
            reasoning: {
              type: "string",
              description: "Describe the song structure, how the sections flow, and what each track does.",
            },
          },
        },
      },
    };

    update("Thinking…", 15);

    const response = await chatCompletion({
      messages: [
        {
          role: "system",
          content: [
            "You are an expert music producer and arranger working in Ableton Live.",
            "You will design a complete song arrangement across multiple tracks.",
            "Think in sections: Intro → Verse → Pre-Chorus → Chorus → Breakdown → Outro.",
            "Each section should be 8 or 16 bars (32 or 64 beats).",
            "Drum tracks use drum_pattern (one bar, bar-repeating). Vary the pattern between sections.",
            "Melody/bass tracks use notes + phrase_plan. Keep melodies sparse and sectional.",
            "Clips in different sections on the same track should have different names and vary musically.",
            "",
            DRUM_PITCH_RULE,
            "",
            MELODY_RULES,
            scaleConstraint,
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            sessionCtx,
            scaleConstraint,
            "",
            "╔══ AVAILABLE TRACKS ══════════════════════════════════════",
            trackList,
            "╚══════════════════════════════════════════════════════════",
            "",
            `USER REQUEST: "${prompt}"`,
            "",
            "Design a full arrangement. Use sections (Intro, Verse, Chorus…).",
            "Create clips for EVERY track across ALL sections.",
            "Keep drum patterns section-specific (intro sparse, chorus full).",
            "Melody clips should vary per section — same key, different phrases.",
          ].join("\n"),
        },
      ],
      tools: [BUILD_ARRANGEMENT_TOOL],
      tool_choice: "required",
    });

    if (abortSignal.aborted) return;
    update("Writing arrangement to Live…", 70);

    const toolCalls = response.choices[0]?.message?.tool_calls ?? [];
    for (const call of toolCalls) {
      if (call.function.name !== "build_arrangement") continue;

      const plan = JSON.parse(call.function.arguments) as {
        sections: Array<{ name: string; start_beat: number; duration_beats: number }>;
        clips: Array<{
          track_name: string;
          clip_name: string;
          start_beat: number;
          duration_beats: number;
          drum_pattern?: { base_pattern: { hits: DrumHit[] }; variation_bars: Array<{ bar_index: number; hits: DrumHit[] }> };
          phrase_plan?: string;
          notes?: NoteDescription[];
        }>;
        reasoning: string;
      };

      console.log(
        `[AI Copilot] buildArrangement: ${plan.sections.length} sections, ${plan.clips.length} clips.\n` +
        `  Structure: ${plan.sections.map((s) => s.name).join(" → ")}\n` +
        `  ${plan.reasoning}`,
      );

      let done = 0;
      for (const entry of plan.clips) {
        if (abortSignal.aborted) break;

        const track = midiTracks.find((t) => t.name === entry.track_name);
        if (!track) {
          console.warn(`[AI Copilot] buildArrangement: track "${entry.track_name}" not found, skipping.`);
          continue;
        }

        update(
          `Creating "${entry.clip_name}" on "${entry.track_name}"… (${done + 1}/${plan.clips.length})`,
          70 + (done / plan.clips.length) * 25,
        );

        const clip = await track.createMidiClip(entry.start_beat, entry.duration_beats);
        clip.name  = entry.clip_name;

        if (entry.drum_pattern && isDrumTrack(track)) {
          const patternResult: DrumPatternResult = {
            base_pattern:   entry.drum_pattern.base_pattern,
            variation_bars: entry.drum_pattern.variation_bars ?? [],
            reasoning:      "",
          };
          clip.notes = expandDrumPattern(patternResult, entry.duration_beats);
          clip.color = CLIP_COLORS.drums;
          logDrumGeneration(`buildArrangement "${entry.clip_name}" (${clip.notes.length} notes)`, patternResult, track);
        } else if (entry.notes && entry.notes.length > 0) {
          // Run full validator pipeline — scale snap, density clamp, gaps, velocity humanize.
          const { notes: validated, report } = runMelodyValidators(entry.notes as NoteDescription[], song);
          clip.notes = validated;
          clip.color = clipColorForTrack(track.name, false);
          console.log(`[AI Copilot] buildArrangement validators: "${entry.clip_name}" → ${report}`);
        }

        console.log(
          `[AI Copilot] buildArrangement → "${entry.clip_name}" on "${entry.track_name}" ` +
          `@ beat ${entry.start_beat} (bar ${Math.floor(entry.start_beat / 4) + 1}), ` +
          `${entry.duration_beats} beats, ${clip.notes.length} notes`,
        );
        done++;
      }
    }

    update("Done!", 100);
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function activate(activation: ActivationContext): void {
  const context = initialize(activation, "1.0.0");

  context.commands.registerCommand("copilot.editClip", (arg) =>
    editClipCommand(context, arg).catch((e) => console.error("[AI Copilot] editClip error:", e)),
  );
  context.commands.registerCommand("copilot.generateClip", (arg) =>
    generateClipCommand(context, arg).catch((e) => console.error("[AI Copilot] generateClip error:", e)),
  );
  context.commands.registerCommand("copilot.analyzeSession", () =>
    analyzeSessionCommand(context).catch((e) => console.error("[AI Copilot] analyzeSession error:", e)),
  );
  context.commands.registerCommand("copilot.fillArrangementSelection", (arg) =>
    fillArrangementSelectionCommand(context, arg).catch((e) => console.error("[AI Copilot] fillArrangement error:", e)),
  );
  context.commands.registerCommand("copilot.fillClipSlotSelection", (arg) =>
    fillClipSlotSelectionCommand(context, arg).catch((e) => console.error("[AI Copilot] fillClipSlots error:", e)),
  );
  context.commands.registerCommand("copilot.rearrangeArrangement", () =>
    rearrangeArrangementCommand(context).catch((e) => console.error("[AI Copilot] rearrange error:", e)),
  );
  context.commands.registerCommand("copilot.buildArrangement", () =>
    buildArrangementCommand(context).catch((e) => console.error("[AI Copilot] buildArrangement error:", e)),
  );
  context.commands.registerCommand("copilot.soundDesign", (arg) =>
    soundDesignCommand(context, arg).catch((e) => console.error("[AI Copilot] soundDesign error:", e)),
  );
  context.commands.registerCommand("copilot.soundDesignTrack", (arg) =>
    soundDesignTrackCommand(context, arg).catch((e) => console.error("[AI Copilot] soundDesignTrack error:", e)),
  );

  // Composition — MIDI clips and tracks
  context.ui.registerContextMenuAction("MidiClip",  "🤖 AI: Edit this clip",               "copilot.editClip");
  context.ui.registerContextMenuAction("MidiTrack", "🤖 AI: Generate clip",                "copilot.generateClip");
  context.ui.registerContextMenuAction("MidiTrack", "🎛️ AI: Design sound (full chain)",    "copilot.soundDesignTrack");

  // Sound design — device scopes
  context.ui.registerContextMenuAction("Simpler",  "🎛️ AI: Design sound",  "copilot.soundDesign");
  context.ui.registerContextMenuAction("DrumRack", "🎛️ AI: Design sound",  "copilot.soundDesign");

  // Scene scopes — session analysis + arrangement
  context.ui.registerContextMenuAction("Scene", "🤖 AI: Analyze full session",   "copilot.analyzeSession");
  context.ui.registerContextMenuAction("Scene", "🤖 AI: Rearrange clips",        "copilot.rearrangeArrangement");
  context.ui.registerContextMenuAction("Scene", "🤖 AI: Build arrangement",      "copilot.buildArrangement");

  // Multi-object / arrangement scopes
  context.ui.registerContextMenuAction("MidiTrack.ArrangementSelection", "🤖 AI: Fill selection",      "copilot.fillArrangementSelection");
  context.ui.registerContextMenuAction("ClipSlotSelection",              "🤖 AI: Fill selected slots", "copilot.fillClipSlotSelection");

  console.log(
    `[AI Copilot] v0.3.0 loaded with ${MODEL}\n` +
    `  ── Composition ──────────────────────────────────────────────\n` +
    `  • Right-click MIDI clip              → Edit this clip\n` +
    `  • Right-click MIDI track             → Generate clip\n` +
    `  • Select arrangement region          → Fill selection (multi-track)\n` +
    `  • Select multiple session view slots → Fill selected slots\n` +
    `  ── Sound Design ─────────────────────────────────────────────\n` +
    `  • Right-click Simpler / DrumRack     → Design sound (single device)\n` +
    `  • Right-click MIDI track             → Design sound (full chain)\n` +
    `  ── Arrangement ──────────────────────────────────────────────\n` +
    `  • Right-click Scene                  → Analyze / Rearrange / Build arrangement`,
  );
}
