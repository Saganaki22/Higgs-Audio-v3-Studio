# Higgs Audio v3 Studio Roadmap

This roadmap is for turning the current desktop app from a capable local
generator into a production-ready voice studio. It is intentionally specific to
Higgs Audio v3/TTS 3, the current Tauri/Rust/C++ port, and the actual app shape:
model manager, speaker gallery, multi-speaker workflow, API server, queue,
hardware telemetry, and bundled/downloaded runtime assets.

## Product Direction

Higgs Audio v3 Studio should feel like a local voice production workstation:

- Fast first audio, not just fast completed files.
- Clear model/runtime health, not mysterious DLL/model errors.
- Reusable speakers, scripts, sessions, and recipes.
- One unified queue for UI and API jobs.
- Modern UI discipline through a real design system, not one-off polish.
- Local-first trust: clear API security, local-only defaults, consent notes, and
  diagnosable failures.

## Non-Negotiable Principles

- Optimize perceived latency first. For TTS, time-to-first-audio matters more
  than total wall-clock time once generation is reasonably fast.
- Keep plain TTS simple. Do not force a heavy DAW-style layout onto the basic
  "type text, generate" workflow.
- Use full canvas/inspector/timeline treatment only where it earns its keep:
  Multi Speaker, Voice Clone, Continue Speech, Speaker Gallery, and History.
- Every long-running operation should be visible as a job with status, progress,
  logs, cancel/retry, and output metadata.
- UI and API must be two producers into the same job system, not two separate
  execution worlds.
- All external downloads must be manifest/checksum verified before being shown as
  healthy.
- Secrets must not live in plain localStorage.

## Current Ceiling

The current app already has serious features, but it is now pressing against a
few structural limits:

- `src/main.ts` is too large and owns too many systems at once: model management,
  downloads, speaker gallery, multi-speaker editing, queueing, API, hardware,
  waveforms, settings, and generation orchestration.
- Tauri commands are mostly stringly typed at call sites.
- API jobs are serialized by the Rust mutex but are not first-class visible jobs
  in the UI queue.
- Generation output is generate-then-render; audio does not start while the tail
  is still being generated.
- History is in-memory and small instead of project/session based.
- Downloads pause/resume only inside the active process; there is no durable HTTP
  Range resume after restart.
- No in-app checksum/manifest verification yet.
- API is WAV-only while desktop can save MP3.
- API multi-speaker and transcribe-reference routes are still pending.
- Speaker changes require restarting the API server to refresh IDs.
- Settings have no schema migration.
- API key currently persists in frontend storage.

## Phase 0 - Architecture Foundation

Goal: make future work cheaper and safer before adding another wave of features.

### Split the frontend into modules

Create focused TypeScript modules:

- `core/ipc.ts` - typed wrappers around every Tauri command and event.
- `core/state.ts` - shared app state and persisted settings schema.
- `settings/settingsPanel.ts`
- `models/modelManager.ts`
- `downloads/downloadManager.ts`
- `audio/audioPlayer.ts`
- `audio/waveform.ts`
- `generation/jobQueue.ts`
- `generation/options.ts`
- `speakers/speakerGallery.ts`
- `speakers/speakerStore.ts`
- `multiSpeaker/scriptTimeline.ts`
- `api/apiPanel.ts`
- `hardware/hardwareMonitor.ts`
- `ui/toast.ts`
- `ui/tooltips.ts`
- `ui/commandPalette.ts`

Definition of done:

- `main.ts` becomes bootstrap only.
- No direct raw `invoke("command_name")` scattered through workflow modules.
- Every command has a typed request/response wrapper.
- Shared models are declared once: `GenerationJob`, `SpeakerPersona`,
  `ModelListing`, `DownloadJob`, `ApiLogEntry`, `RuntimeHealth`.

### Settings schema and migrations

Add a versioned settings object:

```ts
type SettingsV1 = {
  schemaVersion: 1;
  theme: "dark" | "light";
  accent: "teal" | "blue" | "green" | "red" | "yellow";
  uiScale: number;
  saveFormat: "wav" | "mp3";
  hardwarePollMs: number;
  minimizeToTray: boolean;
  modelPath?: string;
  whisperModelPath?: string;
};
```

Tasks:

- Migrate old individual `localStorage` keys into one versioned object.
- Keep a migration path for broken/unknown stored values.
- Add "Reset app settings" in Settings.
- Keep speaker library separate from simple settings.

### Move secrets out of localStorage

Tasks:

- Use OS keychain via Rust `keyring` crate for API key storage.
- Frontend should request "get/set/regenerate API key" through typed IPC.
- Redact API keys from logs and copied diagnostics.
- Add Tauri capability/CSP tightening after command surface stabilizes.

### Structured logging

Tasks:

- Use Rust `tracing` for backend logs.
- Feed structured log events to the existing Command Centre.
- Add log levels, module names, job IDs, and timestamps.
- Add rolling file logs under app data.
- Add "Copy diagnostics bundle" button.

## Phase 1 - Higgs-Specific Performance

Goal: make the app feel alive and use Higgs Audio v3 architecture correctly.

### Streamed generation playback

Higgs Audio v3 supports streaming audio chunks. The app should stop treating
generation as "wait for full WAV, then render waveform" for interactive use.

Target behavior:

- User clicks Generate.
- Job enters `Preparing`.
- First PCM/WAV chunk arrives.
- Playback starts immediately while later chunks continue generating.
- Output timeline/waveform grows as chunks arrive.
- When complete, the streamed chunks are finalized into a normal output file.

Native/API design:

- Add streaming C ABI in the engine DLL:
  - `audiocpp_generate_tts_stream`
  - `audiocpp_generate_voice_clone_stream`
  - `audiocpp_generate_finish_sentence_stream`
  - callbacks for PCM chunk, progress phase, completion, error, cancellation.
- Rust wraps these in a `StreamingGeneration` command path.
- Rust emits Tauri events:
  - `generation-started`
  - `generation-progress`
  - `generation-audio-chunk`
  - `generation-complete`
  - `generation-cancelled`
  - `generation-error`
- Frontend `audioPlayer` uses push events, not polling.
- Keep non-streaming path for export-only/batch jobs and fallback.

UI design:

- "Live playback" toggle per generation or global setting.
- A visible "first audio" state: `Preparing -> First audio -> Streaming -> Finalizing`.
- Waveform grows from left to right as chunks arrive.
- Save is disabled until enough output exists, then switches to "Save partial" and
  finally normal "Save".

Performance knobs:

- Expose first vocoder chunk size separately from later stream chunks once the C++
  engine supports it.
- Presets:
  - `Lowest latency`
  - `Balanced`
  - `Highest quality first chunk`
- Tooltips explain that smaller first chunk improves time-to-first-audio but can
  affect initial quality/stability.

Definition of done:

- Plain TTS can play audio before generation finishes.
- Voice Clone can play streamed output after reference preparation.
- Cancel stops future chunks and finalizes/discards partial audio cleanly.
- Streamed and non-streamed output produce identical final save behavior.

### CUDA graph capture where it helps

Do not CUDA-graph-capture the whole pipeline. Higgs uses a talker/code generation
stage and a code-to-wave/vocoder stage. Capture only the talker stage if the C++
port adds/uses CUDA graph execution. Keep the vocoder eager.

Tasks:

- Add engine-level capability flags:
  - `supportsTalkerCudaGraph`
  - `supportsVocoderCudaGraph: false`
  - `cudaGraphMode: off|talker`
- Add Model Doctor diagnostics for current graph mode.
- Add benchmark telemetry: RTF, time-to-first-audio, tokens/sec or frames/sec,
  vocoder ms, decode ms.
- Avoid a UI toggle until the engine path is stable; start as an engine/internal
  optimization with diagnostics.

### Cache saved speaker reference state

Saved speaker identities are the common repeated voice-clone path. Do not
re-tokenize/re-embed the same reference every generation.

Target cache:

- Cache per speaker ID and reference asset hash.
- Cache should include the encoded reference representation the engine can reuse:
  reference audio tokens, transcript tokens, and any supported KV/prefix state.
- Invalidate when:
  - reference audio file changes,
  - transcript changes,
  - normalization setting changes,
  - model changes,
  - engine version changes,
  - cache schema changes.

UI:

- Speaker Gallery badge:
  - `Not prepared`
  - `Preparing`
  - `Cached`
  - `Stale`
  - `Failed`
- Button: `Prepare speaker`.
- Bulk action: `Prepare all selected speakers`.
- Cache size and clear-cache control.

Backend:

- Add commands:
  - `prepare_speaker_reference`
  - `clear_speaker_cache`
  - `speaker_cache_status`
- Store cache metadata in app data, not inside project files unless explicitly
  exported.

Definition of done:

- Reusing the same saved speaker is measurably faster after first preparation.
- Cache invalidation is visible and reliable.
- Ad-hoc reference uploads still work without saving/caching.

### Push progress/events everywhere performance-critical

Keep hardware stats polling; it is fine. Do not poll for generation audio chunks.

Tasks:

- Generation progress, audio chunks, API job status, and download progress should
  be push events.
- Hardware monitor can remain poll-rate based.
- Command Centre should subscribe to job/log events from the same event source.

## Phase 2 - Model Doctor and First-Run Wizard

Goal: get users to a working state without reading docs, and give them a reliable
place to diagnose problems later.

### Model Doctor

A persistent panel or modal, not only first-run.

Checks:

- App version.
- Engine DLL found, path, version, build date if available.
- CUDA available.
- NVIDIA driver version.
- GPU name, VRAM total/free.
- Engine target compatibility: CUDA 13, Windows x64, GPU architecture if exposed.
- Current model folder selected.
- GGUF/safetensors exists.
- Known quant tier: Q4_K_M, Q8_0, BF16, unknown.
- Required Higgs assets:
  - `config.json`
  - `tokenizer.json`
  - `tokenizer_config.json`
  - `chat_template.jinja`
  - `higgs_audio_v2_tokenizer_config.json`
  - `LICENSE`
- Checksums against Hugging Face manifest.
- Whisper model selected and exists.
- Writable app data folders.
- Available disk space for downloads.
- API port available.

Actions:

- Download DLL engine.
- Download recommended Q8_0.
- Download Q4_K_M.
- Download BF16.
- Copy bundled assets into selected model folder.
- Open model folder.
- Open app data folder.
- Copy diagnostics.
- Open troubleshooting docs.

### First-run wizard

Flow:

1. Welcome and local/non-commercial/safety note.
2. Detect GPU/driver/CUDA.
3. Recommend quant tier:
   - 8 GB VRAM -> Q4_K_M
   - 12 GB VRAM -> Q8_0
   - 16 GB+ VRAM -> BF16 optional
4. Engine check/download.
5. Model check/download.
6. Whisper optional setup.
7. Speaker Gallery optional intro.
8. Land user in TTS with engine/model loaded if possible.

Important sequencing note:

- This can be built in parallel with the frontend refactor as an isolated module.
  Do not wait for the entire app to be perfect before adding onboarding.

## Phase 3 - Unified Job Queue

Goal: one job model for UI and API, with real production controls.

Job fields:

```ts
type StudioJob = {
  id: string;
  source: "ui" | "api";
  workflow: "tts" | "voiceClone" | "continueSpeech" | "multiSpeaker" | "transcribe";
  status: "queued" | "preparing" | "streaming" | "generating" | "decoding" |
    "finalizing" | "complete" | "cancelled" | "failed";
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  label: string;
  modelPath: string;
  speakerIds: string[];
  optionsSnapshot: Record<string, unknown>;
  progress: {
    phase: string;
    current?: number;
    total?: number;
    timeToFirstAudioMs?: number;
    rtf?: number;
  };
  output?: {
    wavPath?: string;
    mp3Path?: string;
    durationSec?: number;
    sampleRate?: number;
  };
  error?: {
    code: string;
    message: string;
    fixHint?: string;
  };
};
```

UI:

- Queue Manager becomes a bottom dock or expandable left panel.
- Active job row is always visible.
- Jobs support:
  - cancel active,
  - remove queued,
  - edit queued,
  - duplicate,
  - retry failed,
  - reveal output,
  - copy request/settings,
  - export job report.
- API jobs appear with source badge `API`.
- UI jobs appear with source badge `UI`.

Backend:

- Replace API-only mutex behavior with a real job runner.
- API routes submit jobs and either:
  - wait synchronously for completion for compatibility, or
  - return async job ID if requested.
- UI subscribes to job events.

Definition of done:

- UI and API jobs cannot compete for the engine.
- API jobs are visible in the app queue.
- Cancelling from UI can cancel API jobs.
- Cancelling from API can cancel UI jobs if authorized and targeting the active job.

## Phase 4 - Design System and Modern UI

Goal: make the app feel consistent, deliberate, and production-grade.

### Tokens

Create named tokens for:

- Type scale:
  - `caption`
  - `body-sm`
  - `body`
  - `label`
  - `title-sm`
  - `title`
- Spacing grid: 4/8/12/16/24/32/48.
- Radius:
  - fields/buttons 4px,
  - cards 6-8px,
  - modals 8px.
- Elevation:
  - level 0: flat panels,
  - level 1: popovers,
  - level 2: modals,
  - level 3: command palette.
- Motion:
  - `snappy`: quick micro-interactions,
  - `settle`: panel transitions,
  - `emphasize`: job completion/queue movement.
- Colors:
  - semantic success/warn/error/info,
  - graph VRAM/GPU/RAM/power,
  - waveform played/unplayed/selection,
  - speaker colors.

All canvas rendering must consume CSS/custom-property tokens:

- hardware graph,
- output waveform,
- reference waveform,
- future spectrogram.

### Component states

Every interactive element needs:

- default,
- hover,
- focus-visible,
- disabled,
- loading/busy.

Examples:

- `Load Model` shows spinner/busy immediately.
- `Generate` shows busy state before progress events arrive.
- `Download` shows connecting/downloading/paused/verifying.
- `Auto-transcribe` shows transcribing state.

### Layout direction

Use collapsible, remembered panels like VS Code:

- Command bar at top.
- Left setup/runtime rail.
- Main workflow canvas.
- Optional right inspector.
- Bottom dock for queue/logs/history.

Do not force every workflow into the full layout:

- Plain TTS: simple text-first layout, inspector collapsed by default.
- Voice Clone: waveform/reference canvas + inspector.
- Continue Speech: waveform/source+continuation canvas + inspector.
- Multi Speaker: full script timeline + speaker rail + inspector.
- Speaker Gallery: manager/library layout.
- API: command centre/docs layout.

Minimum window caveat:

- At 1180x720, side panels must collapse cleanly.
- Remember panel open/closed widths per user.
- No fixed panel that permanently steals too much width.

### Empty/loading states

Add proper empty states for:

- no model,
- no Whisper model,
- no speakers,
- no history,
- no queue,
- no API logs,
- hardware waiting,
- downloads idle,
- failed model scan.

Use skeleton or small loading rows instead of blank areas.

### Command palette

Shortcut: `Ctrl+K` or `Ctrl+Shift+P`.

Actions:

- Switch tab.
- Load engine.
- Load model.
- Open Model Doctor.
- Download model/DLL/Whisper.
- Add speaker.
- Find speaker.
- Start/stop API.
- Copy API URL/key.
- Open queue.
- Open logs folder.
- Copy diagnostics.
- Toggle theme/accent.

Add `?` shortcut for keyboard help.

## Phase 5 - Workflow Upgrades

### Take comparison

Voice cloning and expressive TTS are stochastic. Let users generate several takes
and choose.

UI:

- `Generate 1`, `Generate 2`, `Generate 4`.
- Each take has waveform, play, seed, duration, save, keep, discard.
- A/B compare view.
- "Promote to output" button.

Backend:

- Takes are separate jobs or child jobs under one parent.
- Seed strategy:
  - fixed base seed + increment,
  - random set,
  - user-specified seed list.

### Session and recipe files

Session file:

- current workflow,
- text/script,
- speakers,
- references,
- transcripts,
- advanced options,
- model selection,
- output history metadata.

Recipe file:

- reusable settings preset without generated audio.
- Examples:
  - `Fast Q4 draft`
  - `Balanced Q8 voice clone`
  - `Longform stable`
  - `Audiobook narrator`
  - `Multi-speaker dialogue`

Tasks:

- Save/open `.higgs-session.json`.
- Save/open `.higgs-recipe.json`.
- Add "Recent sessions".
- Add "Export session bundle" including references and outputs.

### Speaker Gallery Pro

Add:

- search/filter,
- tags,
- favorite/pin,
- duplicate speaker,
- quality badge,
- reference duration,
- peak/LUFS,
- transcript status,
- cache status,
- consent/source status,
- bulk prepare/cache,
- bulk export/delete,
- "used in sessions" metadata.

### Multi Speaker Script Timeline

Make this the most advanced workflow.

Features:

- Speaker color lanes.
- Drag lines with insertion marker and smooth motion.
- Scene/section groups.
- Per-line status:
  - missing reference,
  - missing text,
  - transcript inferred,
  - cached speaker,
  - generated,
  - failed.
- Per-line regenerate.
- Per-line playback.
- Per-line trim/crossfade handles.
- Import:
  - `[Speaker] line`,
  - CSV,
  - JSON,
  - SRT.
- Export:
  - mixed WAV/MP3,
  - stems per speaker,
  - line-by-line WAV,
  - transcript/script.

### Audio post-processing

Shared by TTS, longform, and multi-speaker:

- trim leading/trailing silence,
- normalize peak,
- normalize LUFS,
- fade in/out,
- crossfade stitched lines,
- insert silence,
- output limiter,
- waveform zoom/scrub,
- optional spectrogram view for reference clips.

## Phase 6 - Downloads, Manifest, Checksums

Goal: make model/runtime installation reliable for multi-GB files.

Manifest shape:

```json
{
  "schemaVersion": 1,
  "appVersion": "0.2.0",
  "engines": [
    {
      "id": "windows-cuda13-x64",
      "path": "engines/audiocpp_engine.dll",
      "sha256": "...",
      "size": 76000000,
      "cuda": "13",
      "platform": "windows-x64"
    }
  ],
  "models": [
    {
      "id": "higgs-q8_0",
      "folder": "models/higgs-q8_0",
      "file": "q8_0.gguf",
      "sha256": "...",
      "size": 0,
      "vramRecommendedGb": 12,
      "assets": "higgs-assets/higgs-audio-v3-tts-4b"
    }
  ],
  "whisper": [
    {
      "id": "base.en-q8_0",
      "file": "ggml-base.en-q8_0.bin",
      "sha1": "...",
      "size": 78000000
    }
  ]
}
```

Tasks:

- Download manifest on startup/manual refresh.
- Verify SHA256/SHA1 after download.
- Show verification status in Model Doctor.
- HTTP Range resume:
  - preserve `.tmp` file,
  - store partial size and ETag/Last-Modified,
  - resume after app restart,
  - restart from zero if server metadata changed.
- Add disk space check before download.
- Add download queue.
- Add "verify existing files" button.

## Phase 7 - API Parity and Local Serving

Goal: make the API feel complete and trustworthy.

### API features

- MP3 response support for `/v1/audio/speech`.
- Multi-speaker API route.
- Transcribe-reference API route.
- Async jobs:
  - `POST /v1/higgs/jobs`
  - `GET /v1/higgs/jobs/:id`
  - `DELETE /v1/higgs/jobs/:id`
- Streaming API:
  - SSE or chunked response for streaming audio.
  - raw audio chunks or base64 events.
- Hot-reload speaker registry when speaker gallery changes.
- API jobs visible in UI job queue.
- API request replay from Command Centre.

### API security

- API disabled by default.
- Localhost default: `127.0.0.1`.
- LAN mode requires explicit warning and API key.
- API key in OS keychain.
- Command Centre redacts secrets and paths by default.

### Command Centre upgrade

Rows should include:

- time,
- source IP,
- method,
- route,
- status,
- latency,
- job ID,
- model,
- speaker,
- output format,
- message.

Actions:

- copy request,
- copy response,
- copy curl,
- replay request,
- cancel job,
- reveal output,
- export logs.

## Phase 8 - Reliability and Shipping

### Crash handling

Tasks:

- Rust panic hook writes crash report to app data.
- Include:
  - app version,
  - engine version/path,
  - model path,
  - GPU/driver,
  - last active job ID,
  - recent logs,
  - last API request metadata without secrets.
- On next launch, show "Previous crash detected" with buttons:
  - copy crash report,
  - open logs folder,
  - dismiss.
- Optional "send report" can come later.

### Graceful CUDA/runtime degradation

Tasks:

- Detect CUDA/driver issues explicitly before model load when possible.
- Show specific fix hints:
  - "Engine DLL missing",
  - "CUDA runtime missing",
  - "Driver too old for CUDA 13",
  - "No NVIDIA GPU detected",
  - "Not enough free VRAM for selected model",
  - "Model assets missing",
  - "Wrong folder selected".
- Never make users infer these from a raw DLL load failure.

### Diagnostics and support

Add `Copy Diagnostics`:

- app version,
- OS,
- GPU,
- VRAM,
- driver,
- engine status,
- model status,
- model doctor results,
- API status,
- recent logs,
- redacted settings.

### Test and QA plan

Automated checks:

- TypeScript build.
- Cargo check.
- Rust unit tests for manifest/checksum/download resume.
- API smoke tests.
- Speaker ZIP import/export roundtrip.
- Settings migration tests.

Manual QA scenarios:

- first run with no DLL/model,
- first run with bundled portable resources,
- installed app under Program Files,
- broken model folder,
- missing Higgs assets,
- download pause/resume/stop,
- network failure during model download,
- voice clone with saved speaker,
- multi-speaker with 2, 6, 20 lines,
- API generation while UI queues another job,
- cancel UI job,
- cancel API job,
- tray close with API running.

## Recommended Build Sequence

1. Split `main.ts` into modules and add typed IPC wrappers.
2. Start `audioPlayer` refactor with streaming event support built in.
3. Build Model Doctor and first-run wizard as an isolated module in parallel.
4. Implement unified job queue spanning UI and API.
5. Add Higgs streaming C ABI/Rust events/frontend live playback.
6. Add speaker reference cache.
7. Add manifest/checksum verification and durable Range resume.
8. Add design-system token pass and component states.
9. Build Multi Speaker script timeline and take comparison.
10. Add session/recipe files.
11. Add API parity: MP3, multi-speaker, transcribe-reference, async jobs,
    streaming, hot-reload speakers.
12. Add crash handling, keychain API key storage, diagnostics bundle, and
    settings migrations.

## Near-Term Agent Tickets

These can be handed to coding agents directly.

### Ticket 1 - Typed IPC and module split

- Create module folders.
- Move Tauri command calls to `core/ipc.ts`.
- Export typed command wrappers.
- Keep behavior identical.
- No UI redesign in this ticket.

### Ticket 2 - Model Doctor

- Add backend command `runtime_health`.
- Return DLL/model/assets/CUDA/GPU/VRAM/checksum/app-data status.
- Add UI panel/modal.
- Add one-click fix buttons.

### Ticket 3 - Unified job queue

- Define `StudioJob`.
- UI and API both submit through same Rust job runner.
- Queue Manager shows UI/API jobs.
- Add job events and cancellation.

### Ticket 4 - Streaming prototype

- Add mocked streaming frontend path first using generated chunks from completed
  WAV to validate playback UI.
- Then wire real C ABI streaming callbacks.
- Add "Live playback" toggle.

### Ticket 5 - Speaker cache

- Add speaker cache metadata.
- Add prepare/clear/status commands.
- Add Speaker Gallery cache badges.

### Ticket 6 - Manifest downloads

- Add manifest fetch.
- Add checksum verify.
- Add durable `.tmp` resume with Range.
- Add Model Doctor verification badges.

### Ticket 7 - Design system pass

- Add token file/section.
- Replace hardcoded canvas colors with CSS variables.
- Add focus-visible/loading states.
- Add empty/loading states.
- Respect `prefers-reduced-motion`.

## Done Means

The app is "production studio ready" when:

- A new user can install, download the right runtime/model, and generate audio
  without reading docs.
- Audio can start streaming before full generation completes.
- Saved speakers are reusable, cacheable, exportable, and diagnosable.
- UI and API jobs are visible in one queue.
- Downloads are resumable and verified.
- API feature set matches the desktop workflows.
- Crashes and failures produce useful diagnostics.
- The UI has consistent tokens, component states, empty states, and keyboard
  navigation.
