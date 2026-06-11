# AI Copilot for Ableton Live

> An Ableton Live 12 Extension that brings AI-powered MIDI generation, sound design, and session analysis directly into your right-click context menu.

Built with the [Ableton Extensions SDK](https://github.com/ableton) (1.0.0-beta.0) 

---

## What it does

| Right-click on… | Action |
|---|---|
| Any **MIDI clip** | `🤖 AI: Edit this clip` — describe a change, AI rewrites the notes |
| Any **MIDI track** | `🤖 AI: Generate clip` — describe what to create, AI builds a new clip |
| Any **MIDI track** | `🎛️ AI: Design sound (full chain)` — sculpt the whole device chain, insert missing devices |
| A **Simpler / DrumRack** device | `🎛️ AI: Design sound` — AI reads every knob and shapes the sound from your description |
| Any **Scene** | `🤖 AI: Analyze full session` — full production critique of your session |
| Any **Scene** | `🤖 AI: Rearrange clips` / `🤖 AI: Build arrangement` — restructure or compose across the timeline |
| An **arrangement selection** | `🤖 AI: Fill selection` — fill multiple tracks at once, parts written to complement each other |
| **Session slots** | `🤖 AI: Fill selected slots` — generate clips for every selected slot |

**Generation features:**
- Reads your live session: BPM, all tracks, devices, existing clips — parts are written *with* what's already playing
- Reads Live's **Scale Mode** — melodies are auto-constrained to your key (drums correctly exempt)
- Reads your **DrumRack pad layout including loaded sample names** — works with any kit, even nested inside Instrument Racks
- Bar-repeating drum architecture — kicks and snares stay locked across all bars
- Genre skill packs: hip hop / boom bap / trap, house / techno, **reggaeton / dembow**, plus core melody, bass, and drum knowledge
- Phrase-aware melody generation — silence is built in, not an afterthought

**Sound design features:**
- Natural language → parameter changes: *"make this pad warmer and dustier"*, *"punchier attack, shorter tail"*
- **Inserts devices it needs**: *"add a low cut and boost the bass"* on a track with no EQ → AI inserts an EQ Eight and dials it in. Works for Compressor, Glue Compressor, Saturator, Reverb, Delay, and any built-in Live device
- All values clamped to each parameter's valid range — the AI can't push a knob out of bounds

**Diagnostics:**
- Every drum generation logs the routing decision, the exact pad map sent to the model, the model's reasoning, and a pad-usage table — with loud warnings if a hit targets a pad that doesn't exist

---

## Requirements

- **Ableton Live 12 Suite** (or Suite Beta) — Extensions SDK requires Suite
- **Node.js 18+** — [download here](https://nodejs.org)
- **OpenAI API key** — [get one here](https://platform.openai.com/api-keys)

---

## Setup (4 steps)

### 1. Clone and install

```bash
git clone https://github.com/samarthmahendraneu/AI-Copilot-Extension-Ableton.git
cd AI-Copilot-Extension-Ableton
npm install
```

The SDK tarballs are bundled in `vendor/` — no separate download needed.

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` and fill in two values:

**`OPENAI_API_KEY`** — paste your OpenAI key:
```
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxx
```

**`EXTENSION_HOST_PATH`** — path to Live's Extension Host binary.

Find it by running this in Terminal:
```bash
# macOS
find /Applications -name "ExtensionHostNodeModule.node" 2>/dev/null
```

Paste the result into `.env`:
```
EXTENSION_HOST_PATH=/Applications/Ableton Live 12 Suite.app/Contents/Helpers/ExtensionHost/ExtensionHostNodeModule.node
```

> **Windows users:** the path is typically:
> `C:\ProgramData\Ableton\Live 12 Suite\Program\ExtensionHost\ExtensionHostNodeModule.node`

### 3. Open Ableton Live 12 Suite

Make sure Live is running before the next step.

### 4. Run the extension

```bash
npm start
```

You'll see the Extension Host start in the terminal. Switch to Live — right-click any MIDI clip, MIDI track, device, or Scene to use the copilot.

---

## Usage tips

**Drum tracks** are detected automatically — including kits nested inside Instrument Racks (most Ableton pack kits). The AI reads your actual pad layout and the loaded sample names, and uses the correct pitches.

**Scale Mode** — turn on Live's Scale Mode (bottom bar in Live) before generating melodies. The AI will only write notes that are in your key. Drum patterns are unaffected by scale (as they should be).

**Good prompts to try:**

*Drums:*
- `"Boom bap hip hop pattern, heavy kick on 1 and 3"`
- `"Trap hi-hat rolls with triplets on beat 4"`
- `"Classic reggaeton dembow, 92 bpm"`
- `"Add a snare fill every 4 bars"`

*Melody:*
- `"Melancholic 4-bar melody, lots of space, hip hop feel"`
- `"Add chord extensions — 7ths and 9ths, slow and moody"`
- `"Counter-melody that sits above the existing bass"`

*Sound design:*
- `"Make this pad warmer and dustier"`
- `"Add a low cut, boost the bass a bit and the highs a bit"` *(inserts an EQ Eight if needed)*
- `"Glue the drums together and add some saturation"` *(inserts Glue Compressor + Saturator)*

*Session analysis:*
- Right-click any scene → `🤖 AI: Analyze full session`

---

## Project structure

```
live-ai-copilot/
├── src/
│   ├── extension.ts     # All extension logic (commands, AI calls, MIDI processing)
│   ├── skills/          # Musical knowledge packs injected into prompts per genre/role
│   │   ├── _core.md     # Always-loaded production fundamentals
│   │   ├── drums.md     # Drum programming reference
│   │   ├── hiphop.md    # Boom bap / trap / lo-fi conventions
│   │   ├── house.md     # House / techno / four-on-the-floor
│   │   ├── reggaeton.md # Dembow patterns, perreo, trap-reggaeton
│   │   ├── melody.md    # Melody / harmony knowledge
│   │   ├── bass.md      # Bassline knowledge
│   │   └── sound-design.md  # ADSR, filters, FX parameter mappings
│   ├── prompt.html      # Chat UI modal (Ableton dark theme)
│   └── analysis.html    # Session analysis output modal
├── vendor/              # Ableton Extensions SDK tarballs (bundled — no download needed)
├── build.ts             # esbuild bundler config
├── manifest.json        # Extension metadata
├── .env.example         # Environment variable template — copy to .env and fill in
└── tsconfig.json
```

---

## How it works

The extension runs as a sandboxed Node.js process inside Ableton Live's Extension Host. It:

1. Registers right-click context menu actions via the Extensions SDK
2. Opens a WebView modal to collect your prompt
3. Reads the full session state (all tracks, clips, devices, mixer, scale) — drum tracks additionally get their DrumRack pad map with sample names
4. Selects relevant **skill packs** (genre + role knowledge) and injects them into the system prompt
5. Calls the OpenAI API using Node's built-in `https` module (no SDK — the sandbox blocks browser globals like `fetch`); the model can also fetch web references mid-generation
6. Parses the AI's tool call response, runs validators (scale snap, density, velocity humanization for melodic parts; stacking guards for drums), and writes MIDI notes back to Live via `withinTransaction()`
7. For sound design: reads every device parameter concurrently, lets the model insert missing built-in devices, and applies clamped parameter changes

Your API key is only sent to `api.openai.com` — it never leaves your machine otherwise.

---

## Development

```bash
npm run build   # type-check + bundle only (no Live connection)
npm start       # build + connect to Live
```

The bundle is a single CJS file at `dist/extension.js`. HTML and skill `.md` files are inlined as strings at build time via esbuild text loaders.

---

## License

MIT
