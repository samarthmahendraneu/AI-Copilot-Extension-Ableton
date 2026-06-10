# AI Copilot for Ableton Live

> An Ableton Live 12 Extension that brings GPT-powered MIDI generation, editing, and session analysis directly into your right-click context menu.

Built with the [Ableton Extensions SDK](https://github.com/ableton) (1.0.0-beta.0) · by **Samarth Mahendra**

---

## What it does

| Right-click on… | Action |
|---|---|
| Any **MIDI clip** | `🤖 AI: Edit this clip` — describe a change, AI rewrites the notes |
| Any **MIDI track** | `🤖 AI: Generate clip` — describe what to create, AI builds a new clip |
| Any **Scene** | `🤖 AI: Analyze full session` — full production critique of your session |

**Features:**
- Reads your live session: BPM, all tracks, mixer levels, devices, existing clips
- Reads Live's **Scale Mode** — melodies are auto-constrained to your key
- Reads your **DrumRack pad layout** — uses your actual kick/snare/hat pitches, not GM guesses
- Bar-repeating drum architecture — kicks and snares stay locked across all bars
- Phrase-aware melody generation — silence is built in, not an afterthought

---

## Requirements

- **Ableton Live 12 Suite** (or Suite Beta) — Extensions SDK requires Suite
- **Node.js 18+** — [download here](https://nodejs.org)
- **OpenAI API key** — [get one here](https://platform.openai.com/api-keys)

---

## Setup (4 steps)

### 1. Clone and install

```bash
git clone https://github.com/your-username/live-ai-copilot.git
cd live-ai-copilot
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

You'll see `[AI Copilot] Loaded` in the terminal. Switch to Live — right-click any MIDI clip, MIDI track, or Scene to use the copilot.

---

## Usage tips

**Drum tracks** are detected automatically (looks for a DrumRack device). The AI reads your actual pad layout and uses the correct pitches.

**Scale Mode** — turn on Live's Scale Mode (bottom bar in Live) before generating melodies. The AI will only write notes that are in your key.

**Good prompts to try:**

*Drums:*
- `"Boom bap hip hop pattern, heavy kick on 1 and 3"`
- `"Trap hi-hat rolls with triplets on beat 4"`
- `"Add a snare fill every 4 bars"`

*Melody:*
- `"Melancholic 4-bar melody, lots of space, hip hop feel"`
- `"Add chord extensions — 7ths and 9ths, slow and moody"`
- `"Counter-melody that sits above the existing bass"`

*Session analysis:*
- Right-click any scene → `🤖 AI: Analyze full session`

---

## Project structure

```
live-ai-copilot/
├── src/
│   ├── extension.ts     # All extension logic (commands, AI calls, MIDI processing)
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
3. Reads the full session state (all tracks, clips, devices, mixer, scale)
4. Calls the OpenAI API using Node's built-in `https` module (no SDK — the sandbox blocks browser globals like `fetch`)
5. Parses the AI's tool call response and writes MIDI notes back to Live via `withinTransaction()`

Your API key is only sent to `api.openai.com` — it never leaves your machine otherwise.

---

## Development

```bash
npm run build   # type-check + bundle only (no Live connection)
npm start       # build + connect to Live
```

The bundle is a single CJS file at `dist/extension.js`. HTML files are inlined as strings at build time via esbuild's `loader: { ".html": "text" }`.

---

## License

MIT
