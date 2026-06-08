import * as https from "node:https";
import {
  initialize,
  MidiClip,
  MidiTrack,
  AudioTrack,
  DrumRack,
  type ActivationContext,
  type Handle,
  type NoteDescription,
} from "@ableton-extensions/sdk";

import promptUI from "./prompt.html";
import analysisUI from "./analysis.html";

const MODEL = "gpt-5.2";

// ─── Lightweight OpenAI HTTPS client ─────────────────────────────────────────

type Role = "system" | "user" | "assistant";

interface Message {
  role: Role;
  content: string;
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

/** True if the track has a DrumRack device loaded */
function isDrumTrack(track: MidiTrack<"1.0.0">): boolean {
  return track.devices.some((d) => d.className === "DrumRack");
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
function readDrumPadMap(track: MidiTrack<"1.0.0">): string {
  const drumRack = track.devices.find((d) => d.className === "DrumRack");
  if (!(drumRack instanceof DrumRack) || drumRack.chains.length === 0) {
    return GM_DRUM_MAP; // fallback
  }

  const lines: string[] = [
    "Pad map (read directly from YOUR DrumRack — use THESE exact pitches, ignore GM defaults):",
  ];

  // Sort chains by receivingNote so it reads low→high (kick first)
  const sorted = [...drumRack.chains].sort((a, b) => a.receivingNote - b.receivingNote);

  for (const chain of sorted) {
    const note  = chain.receivingNote;
    const name  = pitchToName(note);
    const label = chain.name.trim() || "(unnamed pad)";
    lines.push(`  ${note.toString().padStart(3)} (${name.padEnd(4)}) = ${label}`);
  }

  lines.push("");
  lines.push("When generating hits, always use the pitch numbers from this table above.");

  return lines.join("\n");
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
    const hits      = variation ? variation.hits : result.base_pattern.hits;

    for (const hit of hits) {
      const clampedBeat = Math.max(0, Math.min(3.99, hit.beat));
      notes.push({
        pitch:     Math.round(hit.pitch),
        startTime: bar * 4 + clampedBeat,
        duration:  0.125, // drums are percussive — always short
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
      "You define ONE base bar, and it is mechanically cloned across every bar of the clip. " +
      "This guarantees kick/snare consistency — the code, not you, handles repetition. " +
      "Only override specific bars via variation_bars (fills, crashes, breakdowns).",
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
            "Optional per-bar overrides — e.g. bar index 3 (4th bar) with a snare fill or crash. " +
            "Use 0-based bar index. Leave empty [] if no variations needed.",
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pitchToName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
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

    // Mixer
    const vol = track.mixer.volume.value;
    const pan = track.mixer.panning.value;
    const volDb = vol > 0 ? `${(20 * Math.log10(vol)).toFixed(1)} dB` : "-inf dB";
    const panStr = pan === 0 ? "C" : pan > 0 ? `R${(pan * 100).toFixed(0)}` : `L${(-pan * 100).toFixed(0)}`;

    // Devices
    const deviceNames = track.devices.map((d) => d.name).join(", ") || "none";

    lines.push(`┌─ [${type}] "${track.name}" ${flags ? `(${flags})` : ""}`);
    lines.push(`│  Mixer: vol=${volDb}  pan=${panStr}`);
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

    // Detect if this clip lives on a drum track
    const parentTrack  = song.tracks.find((t) =>
      t instanceof MidiTrack && t.arrangementClips.some((c) => c === clip),
    ) as MidiTrack<"1.0.0"> | undefined;
    const drumMode = parentTrack ? isDrumTrack(parentTrack) : false;

    update("Thinking…", 30);

    // ── Drum mode: bar-repeating pattern tool ──────────────────────────────
    if (drumMode) {
      const currentPitches = [...new Set(currentNotes.map((n) => pitchToName(n.pitch)))].join(" ");

      const response = await chatCompletion({
        messages: [
          {
            role: "system",
            content: [
              "You are a professional drum programmer inside Ableton Live.",
              "You use the set_drum_pattern tool which takes ONE bar definition and repeats it mechanically.",
              "This guarantees consistency — kicks and snares will be in the same position every bar.",
              "Only use variation_bars for fills (typically the last bar of a 4-bar phrase) or crashes.",
              "",
              parentTrack ? readDrumPadMap(parentTrack) : GM_DRUM_MAP,
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              sessionCtx,
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
            console.log(
              `[AI Copilot] set_drum_pattern → ${clip.notes.length} notes across ${totalBars} bars.\n` +
              `  Base hits: ${result.base_pattern.hits.length}  Variation bars: ${result.variation_bars.length}\n` +
              `  Reasoning: ${result.reasoning}`,
            );
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

      const response = await chatCompletion({
        messages: [
          {
            role: "system",
            content: [
              "You are an expert music production assistant embedded inside Ableton Live.",
              "You have full awareness of the session: all tracks, BPM, scale, devices, clips.",
              "When generating or editing a melody clip, you MUST follow the phrasing rules below.",
              "When editing chords or bass, follow normal production rules.",
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
              "Fit this musically into the session above. If it is a melody, strictly follow " +
              "the phrasing rules — write phrase_plan first, then generate sparse, breathing notes.",
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
            const gapped   = enforceGaps(rawNotes, 0.125);
            clip.notes     = gapped;
            console.log(
              `[AI Copilot] set_notes → ${rawNotes.length} notes (${rawNotes.length - gapped.length} gap-trimmed).\n` +
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
    const drumMode   = isDrumTrack(track);

    update("Thinking…", 30);

    // ── Drum track: bar-repeating pattern ─────────────────────────────────
    if (drumMode) {
      const createDrumTool: ToolDef = {
        type: "function",
        function: {
          name: "create_drum_clip",
          description:
            "Create a new drum clip on the track using a bar-repeating pattern. " +
            "Define ONE base bar — the code repeats it across all bars. " +
            "Use variation_bars only for fills or crashes.",
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
                description: "Optional overrides for specific bars (fills, crashes). Leave [] if none.",
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

      const response = await chatCompletion({
        messages: [
          {
            role: "system",
            content: [
              "You are a professional drum programmer inside Ableton Live.",
              "Use create_drum_clip with ONE base bar that repeats perfectly every bar.",
              "This guarantees kick/snare lock — no drift across bars.",
              "Only override via variation_bars for fills on bar 4, 8, etc.",
              "",
              readDrumPadMap(track),
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              sessionCtx,
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
              "Define a tight base bar using the pad pitches above. The code handles repetition. " +
              "Add a fill on the last bar of every 4-bar phrase via variation_bars.",
            ].join("\n"),
          },
        ],
        tools: [createDrumTool],
        tool_choice: "required",
      });

      if (abortSignal.aborted) return;
      update("Creating drum clip…", 80);

      for (const call of response.choices[0]?.message?.tool_calls ?? []) {
        if (call.function.name !== "create_drum_clip") continue;
        const input = JSON.parse(call.function.arguments) as {
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
        const clip  = await track.createMidiClip(input.startTime, input.duration);
        clip.name   = input.clipName;
        clip.notes  = expandDrumPattern(patternResult, input.duration);
        console.log(
          `[AI Copilot] Created drum clip "${input.clipName}" ` +
          `(${clip.notes.length} notes, ${input.duration} beats, ${Math.round(input.duration / 4)} bars).\n` +
          `  Base hits: ${input.base_pattern.hits.length}  Variations: ${input.variation_bars.length}\n` +
          `  Reasoning: ${input.reasoning}`,
        );
      }

    // ── Melody / chord / bass track ───────────────────────────────────────
    } else {
      const scaleConstraint = buildScaleConstraint(song);

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

      const response = await chatCompletion({
        messages: [
          {
            role: "system",
            content: [
              "You are an expert music producer and composer inside Ableton Live.",
              "You can see the full session — all tracks, clips, devices, and mixer state.",
              "Generate MIDI that fits coherently into the existing arrangement.",
              "Match the key, complement existing rhythms, fill gaps in the arrangement.",
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
              "╔══ TARGET TRACK ════════════════════════════════════════",
              `║  Generating a new clip on: "${track.name}"`,
              `║  Existing arrangement clips: ${track.arrangementClips.length}`,
              "╚══════════════════════════════════════════════════════════",
              "",
              `USER REQUEST: "${prompt}"`,
              "",
              "Fill phrase_plan BEFORE placing notes. Sparse phrasing — 3-5 notes/bar with rests. " +
              "Place at startTime=0 unless specified.",
            ].join("\n"),
          },
        ],
        tools: [createClipTool],
        tool_choice: "required",
      });

      if (abortSignal.aborted) return;
      update("Creating clip in Live…", 80);

      for (const call of response.choices[0]?.message?.tool_calls ?? []) {
        if (call.function.name !== "create_clip") continue;
        const input = JSON.parse(call.function.arguments) as {
          startTime: number; duration: number; clipName: string;
          phrase_plan: string; notes: NoteDescription[]; reasoning: string;
        };
        const rawNotes = input.notes;
        const gapped   = enforceGaps(rawNotes, 0.125);
        const clip     = await track.createMidiClip(input.startTime, input.duration);
        clip.name      = input.clipName;
        clip.notes     = gapped;
        console.log(
          `[AI Copilot] Created "${input.clipName}" (${rawNotes.length}→${gapped.length} notes, ${input.duration} beats).\n` +
          `  Phrase plan: ${input.phrase_plan}\n  Reasoning: ${input.reasoning}`,
        );
      }
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

  context.ui.registerContextMenuAction("MidiClip",  "🤖 AI: Edit this clip",       "copilot.editClip");
  context.ui.registerContextMenuAction("MidiTrack", "🤖 AI: Generate clip",        "copilot.generateClip");
  context.ui.registerContextMenuAction("Scene",     "🤖 AI: Analyze full session", "copilot.analyzeSession");

  console.log(`[AI Copilot] Loaded with ${MODEL} — right-click any MIDI clip, MIDI track, or Scene.`);
}
