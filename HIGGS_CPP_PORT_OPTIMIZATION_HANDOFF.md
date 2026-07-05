# Higgs Audio v3 Studio C++ Port And Optimization Handoff

This document is for an optimization agent that needs to understand the current
Higgs Audio v3 Studio implementation without reading the whole repository first.
It describes how the Python/Hugging Face style Higgs Audio v3 pipeline was
ported into the local C++/Rust/Tauri desktop app, where the model pipeline lives,
how streaming and speaker caching work, and what should be investigated next for
VRAM and latency optimization.

## Executive Summary

Higgs Audio v3 Studio is a Windows Rust/Tauri desktop application that loads a
native C++ DLL named `audiocpp_engine.dll`. The DLL contains the ported Higgs
Audio v3 TTS runtime plus `whisper.cpp` for local transcription. The app does
not run a Python sidecar, does not shell out to a CLI for generation, and does
not call a web API for inference.

The pipeline is:

```text
Tauri frontend
  -> Rust commands / local HTTP API
  -> Rust `libloading` wrapper
  -> C ABI in `audiocpp_engine.dll`
  -> C++ runtime registry
  -> HiggsTTSSession
  -> HiggsTTSGeneratorRuntime
  -> HiggsAudioCodecDecoderRuntime
  -> PCM samples returned to Rust/UI/API
```

The current port is functional and supports plain TTS, voice clone, continue
speech, saved speaker identities, multi-speaker UI workflows, streaming playback,
API streaming, MP3/WAV finished-file output, Whisper transcription, and speaker
reference caching.

The current main performance issue is VRAM pressure during generation. Before
the `0.2.2` hotfix, cancelling a streaming generation could leave large CUDA
runtime graph allocations alive. `0.2.2` fixes that by adding explicit runtime
graph release hooks and an RAII cleanup guard around each Higgs generation chunk.
However, a separate design issue remains: the ggml decode graph currently
allocates KV/cache memory for `prompt_steps + max_tokens` up front. That can
cause high VRAM reservation even for short prompts if `max_tokens` is set high.

## Important Files

```text
desktop/src/main.ts
  Main frontend application state, workflow UI, streaming preview, queue UI,
  API info examples, speaker gallery, waveform handling, and invoke calls.

desktop/index.html
  Main Tauri HTML structure and controls, including Advanced Options.

desktop/src-tauri/src/lib.rs
  Tauri command layer, local HTTP API, queue serialization, speaker zip import
  and export, speaker cache path management, audio normalization prep, API
  streaming response writer, and app setup.

desktop/src-tauri/src/engine.rs
  Rust wrapper around `audiocpp_engine.dll` using `libloading`. Defines the C
  function signatures, converts Rust requests/options into C strings, receives
  generated PCM, and bridges streaming callbacks into Rust closures.

app/desktop_api/audiocpp_api.h
  Stable C ABI exported by the DLL.

app/desktop_api/audiocpp_api.cpp
  DLL entry point. Owns EngineState, model load/unload, generation functions,
  streaming callbacks, cancellation flag, and embedded `whisper.cpp` transcription.

src/models/higgs_tts/session.cpp
  High-level Higgs TTS session. Handles chunking, reference voice encoding,
  speaker reference cache read/write, prompt construction, generator call,
  codec decode, streaming chunk emission, and runtime graph cleanup.

src/models/higgs_tts/generator.cpp
  Ported talker/generator runtime. Builds the prefill graph, builds the decode
  graph with static KV cache, performs sampling, and emits audio code frames.

src/models/higgs_tts/codec.cpp
  Higgs audio codec runtime. Encodes reference audio into audio code tokens and
  decodes generated code tokens back into PCM audio.

include/engine/models/higgs_tts/generator.h
include/engine/models/higgs_tts/codec.h
  Public runtime interfaces, including `release_runtime_cache()`.
```

## Build And Packaging State

The Windows release DLL is built with CMake/Ninja/MSVC/CUDA 13. The release
build used explicit CUDA architectures:

```text
86-real      RTX 30 series
89-real      RTX 40 series
120a-real    RTX 50 series / Blackwell
```

The DLL also compiles `whisper.cpp` into the same shared library. The desktop app
therefore uses one engine DLL for both Higgs generation and Whisper reference
transcription.

The release app bundles:

```text
resources/engine/audiocpp_engine.dll
resources/higgs-assets/higgs-audio-v3-tts-4b/config.json
resources/higgs-assets/higgs-audio-v3-tts-4b/tokenizer.json
resources/higgs-assets/higgs-audio-v3-tts-4b/tokenizer_config.json
resources/higgs-assets/higgs-audio-v3-tts-4b/higgs_audio_v2_tokenizer_config.json
resources/higgs-assets/higgs-audio-v3-tts-4b/chat_template.jinja
```

Large GGUF model files are downloaded separately from Hugging Face and are not
bundled into the app installer/portable package.

## Frontend To Rust Flow

The frontend is a single-page Tauri UI. It collects workflow state and sends a
`GenerateRequest` to Rust through Tauri `invoke()` calls.

Main generation routes:

```text
generate_tts
generate_voice_clone
generate_finish_sentence
transcribe_audio
```

The frontend options include:

```text
max_tokens
temperature
top_p
top_k
seed
seed mode
emotion/style/speed/pitch/expressiveness tags
longform chunking
reference normalization
stream_playback
speaker pause for multi-speaker
reference_cache_path for saved speakers
```

For streaming playback, the frontend enables `stream_playback`. Rust then sets
`emit_stream_audio_chunks` so the C++ streaming path sends PCM chunks during
generation. The frontend receives those chunks through Tauri events and keeps a
live PCM buffer for play/pause, waveform drawing, and final replacement.

## Rust FFI Layer

Rust loads the DLL at runtime through `libloading` in `desktop/src-tauri/src/engine.rs`.
It resolves these important exported symbols:

```text
audiocpp_create
audiocpp_destroy
audiocpp_load_model
audiocpp_unload_model
audiocpp_is_model_loaded
audiocpp_is_generating
audiocpp_cancel
audiocpp_get_model_info
audiocpp_generate_tts
audiocpp_generate_voice_clone
audiocpp_generate_finish_sentence
audiocpp_generate_tts_stream
audiocpp_generate_voice_clone_stream
audiocpp_generate_finish_sentence_stream
audiocpp_free_result
audiocpp_last_error
audiocpp_version
audiocpp_transcribe
```

The wrapper stores raw function pointers and keeps the `Library` alive inside the
`Engine` struct. The `Engine` owns the opaque C handle returned by
`audiocpp_create()`. Rust marks the wrapper `Send` and `Sync`, while the native
DLL serializes generation with a mutex inside `EngineState`.

Rust passes options as JSON strings to the C ABI. The C++ layer parses JSON into
`std::unordered_map<std::string, std::string>` for the runtime session.

## Local HTTP API

The app also exposes a local HTTP API implemented in Rust, not a separate web
server framework. It uses `TcpListener`/`TcpStream` directly.

Important API behavior:

```text
GET  /health
GET  /v1/status
GET  /v1/models
GET  /v1/higgs/speakers
POST /v1/audio/speech
POST /v1/higgs/voice-clone
POST /v1/higgs/continue-speech
POST /v1/higgs/audio/stream
POST /v1/higgs/cancel
```

The API and UI both feed the same engine path. Generation is serialized so two
jobs do not fight the loaded model. The API speaker list is hot-updated from the
Speaker Gallery through `api_update_speakers`; the API does not need a restart
when speakers are edited.

Finished API routes can return WAV or MP3. The streaming API currently returns
NDJSON events with WAV-base64 chunks and a final WAV-base64 result.

## C ABI Engine State

`app/desktop_api/audiocpp_api.cpp` owns:

```cpp
struct EngineState {
    std::mutex mutex;
    rt::ModelRegistry registry;
    std::unique_ptr<rt::ILoadedVoiceModel> loaded_model;
    std::unique_ptr<rt::IVoiceTaskSession> session;
    rt::IOfflineVoiceTaskSession * offline = nullptr;
    std::atomic<bool> model_loaded{false};
    std::atomic<bool> generating{false};
    std::atomic<bool> cancel_requested{false};
    std::string model_root;
    std::string weight_type;
    std::string family_name;
    std::string display_name;
    std::string last_error;
    audiocpp_progress_fn progress_fn = nullptr;
    audiocpp_audio_chunk_fn audio_chunk_fn = nullptr;
    void * progress_user_data = nullptr;
};
```

Every generate function takes `state.mutex`, sets callbacks, sets
`generating = true`, clears `cancel_requested`, builds a runtime request, and
calls either the non-streaming or streaming session method. Cancel only sets
`cancel_requested = true`; the running generation checks the flag through
callbacks/progress and returns false to unwind.

Important consequence: cancellation is cooperative. It cannot instantly abort a
CUDA kernel already in flight. It becomes effective at the next progress/audio
callback or other explicit cancellation check.

## Model Load Flow

When Rust calls `audiocpp_load_model()`:

1. Existing model/session are dropped.
2. The model root path is validated.
3. `rt::ModelRegistry` loads the model folder.
4. The runtime creates a TTS offline session.
5. The backend is selected from Rust options: best, CPU, CUDA, Vulkan, Metal.
6. The session is prepared.
7. `model_loaded` becomes true.

The Higgs session constructor creates:

```text
HiggsTTSGeneratorRuntime
HiggsAudioCodecDecoderRuntime
```

It also calls `assets_->model_weights->release_storage()` after runtime creation
so the source weight storage is not kept around unnecessarily after the runtime
has loaded what it needs.

## Higgs Runtime Pipeline

For a normal request:

```text
request text/options/reference
  -> optional text chunking
  -> optional reference audio encoding
  -> prompt construction with tokenizer/template
  -> generator prefill graph
  -> generator decode graph loop and sampling
  -> delayed audio-code matrix
  -> reverse delay pattern
  -> raw audio-code matrix
  -> codec decode graph
  -> PCM AudioBuffer
  -> C ABI result
  -> Rust AudioResult
  -> UI/API WAV or MP3
```

Higgs Audio v3 is two-stage in this port:

1. Talker/generator stage: Qwen/Higgs text/audio-token model predicts delayed
   multi-codebook audio tokens.
2. Codec/vocoder stage: Higgs audio codec decodes raw codebook frames to PCM.

The generator uses the delay-pattern style expected by the model. Generated
tokens are stored as a delayed code matrix, then converted with
`reverse_delay_pattern()` before codec decode.

## Reference Voice And Speaker Cache

Saved speakers store:

```text
reference audio file
reference transcript
optional display photo
notes/metadata
cache/speaker.hspkcache
```

The C++ cache format is currently custom and intentionally simple:

```text
magic: HSPKCACHE01
schema version
sample rate
channel count
sample count
audio fingerprint
delayed code frames
codebook count
token count
int32 token ids
```

The cache stores the reference delayed audio-code matrix, not model weights and
not a full KV prefix. It avoids re-running codec reference encoding for the same
speaker reference audio. This saves compute in voice cloning and API saved
speaker use, especially for repeated generations with the same speaker.

The cache is tied to the reference audio fingerprint, sample count, sample rate,
and channel count. If the reference audio changes, the cache will not be reused.

Important limitation: this cache is model-agnostic only at the code-token level.
It assumes the same Higgs audio codec/tokenizer semantics. It should be fine
across quant tiers of the same Higgs model family, but it should not be treated
as portable across unrelated model families or changed codec configs.

Future optimization idea: cache more than delayed codes. A deeper cache could
store a validated prompt/reference prefix representation or reusable KV prefix,
but that is more model/config/quant sensitive and needs careful invalidation.

## Streaming Path

Streaming is implemented in C++ session code, exposed by extra C ABI functions,
wrapped by Rust callbacks, then surfaced to the frontend/API.

Native streaming flow:

```text
HiggsTTSSession::run_streaming()
  -> run_chunk_streaming()
  -> generator_->generate(..., code_stream callback)
  -> code_stream receives partial delayed code matrix
  -> if enough new raw frames exist:
       reverse_delay_pattern(delayed_codes)
       codec_decoder_->decode(raw_prefix)
       slice only newly generated PCM
       on_audio(chunk, start_sample, is_final)
  -> final full codec decode
  -> return complete AudioBuffer
```

Default streaming frame settings:

```text
first_stream_frames = 20
stream_frames = 40
```

The stream currently decodes the full raw prefix repeatedly, then slices off the
new samples. This is simple and correct, but expensive. It can cause extra codec
graph work and temporary memory pressure because the codec decode graph grows as
the prefix grows.

Major future optimization: make the codec/vocoder streaming stateful so each
stream chunk decodes only the new code frames plus any required overlap/context,
instead of re-decoding the entire prefix repeatedly.

## Progress Reporting

The DLL reports progress through callbacks:

```text
non-stream path:
  0/1 generating
  1/1 complete

stream path:
  0/4 preparing
  1/4 first audio
  2/4 streaming
  token current/total generating
  token current/total decoding
  3/4 finalizing
  4/4 complete
```

The token progress comes from `code_stream` callback in the generator. It is not
a Python `tqdm` progress bar; it is callback-driven C++ progress based on
available generated audio-code frames versus `max_tokens`.

## Graphs In The Current C++ Port

The port uses ggml graphs for the generator and codec. The key graph types are:

```text
Generator:
  PrefillGraph
  DecodeGraph

Codec:
  EncoderGraph
  DecoderGraph
```

`PrefillGraph` processes the prompt/reference prefix and returns logits plus KV
state. It is reset after prefill in current code.

`DecodeGraph` performs one audio-code generation step at a time using a static
KV cache sized to `prompt_steps + max_tokens`. This graph is the main VRAM spike
suspect.

`EncoderGraph` encodes reference audio into audio-code tokens for speaker clone.

`DecoderGraph` decodes generated raw audio-code tokens to PCM.

## CUDA Graphs: Should We Use Them?

This build enables `ENGINE_ENABLE_CUDA_GRAPHS=ON` at compile time through the
Windows CUDA release preset. In principle, CUDA graph capture can help repeated
fixed-shape execution, especially batch-1 decode/talker loops. But not every
stage should be graph-captured.

Recommendation for optimization agent:

1. Keep graph/capture focus on the talker/generator decode stage first.
2. Do not try to capture the whole pipeline as one CUDA graph.
3. Do not force graph capture over vocoder/codec streaming if shapes change.
4. Measure with CUDA graphs on/off for:
   - prefill graph,
   - decode graph step loop,
   - codec final decode,
   - codec repeated prefix streaming.
5. If graph capture increases VRAM or prevents releasing buffers promptly, make
   it optional from session options.

The current biggest practical issue is probably not "graphs exist"; it is that
the decode graph uses a static worst-case KV allocation and the streaming codec
path repeatedly builds/uses larger prefix decode graphs.

## KV Cache And VRAM Spike Analysis

The generator decode graph currently does this:

```text
prompt_steps = prompt.input_ids.size()
required_cache_steps = prompt_steps + options.max_tokens
DecodeGraph(weights, required_cache_steps, decode_graph_arena_bytes)
```

Inside `DecodeGraph`, each transformer layer allocates static cache tensors:

```text
cache_keys:
  shape roughly [1, cache_steps, num_key_value_heads, head_dim]

cache_values:
  shape roughly [1, cache_steps, num_key_value_heads, head_dim]
```

That means VRAM reservation is tied to `max_tokens`, not to how many tokens are
eventually generated. If `max_tokens` is 2048, the runtime can reserve a large
cache up front even if the actual output stops early or the user asked for a
short sentence.

This is why low generated output length can still show high VRAM usage: the
cache capacity was allocated before generation knew where it would stop.

## What 0.2.2 Fixed

Before `0.2.2`, cancellation during streaming could throw/unwind before the end
of `run_chunk_streaming()`. The old cleanup was near the normal end of the
function, so cancelled streams could skip codec runtime cache release. Also the
generator decode graph could remain alive between runs.

`0.2.2` added:

```text
HiggsTTSGeneratorRuntime::release_runtime_cache()
RuntimeCacheReleaseGuard in HiggsTTSSession
early codec encoder graph release after reference encode
early generator graph release after token generation
codec graph release after final decode
codec graph release after each streaming prefix decode
safe cleanup on success, cancel, and exception
```

The guard releases:

```text
codec_decoder_->release_runtime_cache()
generator_->release_runtime_cache()
```

The option `keep_runtime_cache` exists internally. Default is false. If false,
runtime graphs are released after each request/chunk and on error/cancel. If true,
the graph cache can be retained, but this is not recommended for low-VRAM safety.

## F16 Decode KV Cache Attempt

An F16 static generator decode KV cache was attempted after the first `0.2.3`
hotfix:

```text
DecodeGraph static cache key/value tensors: GGML_TYPE_F16
decode_kv_estimated_bytes dtype bytes: sizeof(ggml_fp16_t)
```

That build compiled, but it caused the desktop app to close/crash when generation
started. The packaged build was reverted to the known-stable F32 decode cache:

```text
DecodeGraph static cache key/value tensors: GGML_TYPE_F32
decode_kv_estimated_bytes dtype bytes: sizeof(float)
```

Do not re-enable F16 by only changing the tensor type. Before retrying, isolate
the crash with a native harness and validate:

```text
ggml_set_rows support for F16 cache tensors on CUDA
ggml_cast(row -> F16) before set_rows
ggml_flash_attn_ext support for F32 Q with F16 K/V cache tensors
backend graph validation for the updated cache graph
quality regression on fixed seed/reference clips
```

The row-update helper and `TransformerKVCache` can tolerate F16 cache tensors in
code, but the shipped cache allocation remains F32 until the CUDA crash is
understood.

Prefill K/V outputs remain F32 for now. They are prompt-length and transient,
whereas the decode cache is sized to `prompt_steps + max_tokens`, so decode cache
was the cheaper first target. If telemetry shows a large prefill-stage spike,
prefill K/V dtype can be revisited separately.

## Remaining VRAM Problems

Even after the leak fix, active generation can still reserve a lot of VRAM. Main
suspects:

1. Static F32 decode KV cache allocation for `prompt_steps + max_tokens`.
2. ggml backend graph workspaces/scratch buffers sized for current graph.
3. CUDA graph capture or backend allocator retaining pools.
4. Codec streaming path re-decoding growing prefixes.
5. Final full codec decode overlapping with generator/streaming allocations.
6. Reference encoder graph allocations during voice clone, although 0.2.2 now
   releases the encoder graph immediately after extracting reference codes.

## Best Next Optimizations

### 1. Re-run max-token telemetry sweep

Run the sweep with the restored stable F32 decode cache:

```text
max_tokens: 128, 256, 512, 1024, 2048
watch: before_generator -> after_generator
watch: decode_kv_estimated_mib
```

Use the estimate and measured VRAM delta as the baseline for the next stable
optimization. If VRAM scales with `max_tokens`, tiered/chunked decode cache is
still the safer next production change.

### 2. Dynamic or chunked decode KV cache

The next important VRAM optimization is to avoid allocating the full
`prompt_steps + max_tokens` decode cache up front.

Possible designs:

```text
Option A: start with smaller cache capacity and rebuild/grow when needed.
Option B: allocate cache in pages/blocks and append pages as generation grows.
Option C: cap default max_tokens much lower and use longform chunking for long text.
Option D: expose low-vram mode that builds a smaller decode graph and stops early.
```

Option B is best architecturally but hardest in ggml because the graph currently
expects static tensor shapes. Option A may be realistic: allocate for a smaller
runtime cap, and if generation reaches the cap, continue in a new segment/chunk.

### 3. Separate "requested length" from "hard safety cap"

The UI currently uses `max_tokens` as both user-facing length and hard graph
capacity. A better design is:

```text
target_tokens: normal expected generation length
max_tokens: hard stop
cache_window_tokens: allocation window
```

The decode graph could allocate `cache_window_tokens`, generate within that
window, then extend/rebuild only if the output actually needs more.

### 4. Stateful streaming codec decode

The current streaming implementation decodes the whole raw prefix repeatedly:

```text
raw_prefix = reverse_delay_pattern(delayed_codes)
audio_prefix = codec_decoder_->decode(raw_prefix)
chunk = audio_prefix[previous_samples..]
```

This is simple but inefficient. A better streaming codec should maintain vocoder
state and decode only the new code frames plus overlap/context. This should lower
latency, reduce memory churn, and reduce streaming pops/edge artifacts.

### 4. Better cancellation checks inside generator loop

Cancellation currently reaches C++ through the streaming callback returning
false. There is no direct cancel token passed into every decode step outside the
callback path. Add a cancellation callback/check into the generator loop before
and after heavy compute calls so cancellation can unwind sooner.

### 5. Backend memory trim after cancel

Investigate whether ggml CUDA backend exposes an allocator trim/free-pool call.
If it does, call it after cancellation and maybe after unload. The current graph
objects are freed, but CUDA/backend memory pools may still show reserved memory
until the backend decides to release them.

### 6. Measure graph memory by stage

Add debug telemetry around:

```text
before reference encode
after reference encode
after reference cache release
before prefill
after prefill
after decode graph build
after generator release
after each stream vocoder decode
after final vocoder decode
after codec release
after cancellation unwind
```

Use NVML from Rust or native CUDA memory queries from C++ to record used/free
memory. This will show whether the spike is generator KV, codec graph, CUDA pool,
or Windows/NVML reporting reserved memory.

## How Saved Speaker Cache Should Affect Compute

The saved speaker cache saves reference extraction work only. It means:

```text
First use of a speaker:
  read/normalize reference audio
  codec encode reference audio
  apply delay pattern
  write speaker.hspkcache

Next use of same speaker:
  read speaker.hspkcache
  validate fingerprint/sample metadata
  reuse delayed code matrix
  skip codec reference encode
```

It does not skip the main generator decode and it does not skip final codec
decode. It also does not currently store a reusable transformer KV prefix.

If an optimization agent wants bigger speedups for repeated speaker generation,
the next level is reference/prompt prefix KV caching. That must include strict
invalidators:

```text
model family
model quant or exact model hash
assets/config hash
tokenizer hash
reference audio fingerprint
reference transcript text hash
prompt template/schema version
backend compatibility
```

Without those invalidators, KV reuse can silently produce wrong voice/style or
crash on shape mismatch.

## Why ComfyUI Can Look Better On VRAM

The ComfyUI implementation uses PyTorch/Comfy model management and optional
DynamicVRAM-style paging. It can unload/offload modules and call PyTorch/Comfy
cache cleanup hooks. This desktop C++ port uses ggml/CUDA native graphs and
backend allocations. Those allocations are not automatically managed by PyTorch
or Comfy. Therefore the C++ port needs explicit graph lifetime management and
possibly backend allocator trimming.

ComfyUI also does not necessarily build the same static ggml decode graph with a
large fixed `max_tokens` cache. Different runtime architecture means different
VRAM behavior even with the same model.

## Concrete Recommendations For The Optimization Agent

1. Confirm the 0.2.2 cancellation fix with a test:
   - load q4/q8/bf16,
   - start streaming generation,
   - cancel while audio is streaming,
   - verify VRAM returns near pre-generation level,
   - run a second generation without freezing.

2. Add native memory instrumentation before changing algorithms.

3. Measure with `max_tokens` values:
   - 128,
   - 256,
   - 512,
   - 1024,
   - 2048.

4. If VRAM scales with `max_tokens`, the static decode KV cache is confirmed.

5. If VRAM stays high after graph release, investigate ggml CUDA allocator
   pooling and CUDA graph capture retention.

6. Implement a low-VRAM mode:
   - lower default `max_tokens`,
   - smaller stream frame windows,
   - release runtime graphs aggressively,
   - no `keep_runtime_cache`,
   - maybe disable CUDA graph capture for vocoder/codec.

7. Investigate dynamic decode cache:
   - fixed small windows,
   - graph rebuild at boundaries,
   - paged KV,
   - or split long requests into text chunks with consistent speaker cache.

8. Replace repeated full-prefix streaming codec decode with stateful incremental
   vocoder decode if possible.

9. Keep the saved speaker code-token cache, but do not confuse it with KV cache.

10. Only add deeper KV speaker caching if invalidation is strict and measured
    benefits justify the complexity.

## Known Tradeoffs

Aggressively releasing graphs after every request reduces VRAM pressure and fixes
cancel leaks, but it may add latency to the next request because graphs must be
rebuilt. That is acceptable for safety right now. A future setting could expose:

```text
Runtime cache mode:
  Safe / release after every request
  Balanced / keep small compatible graphs
  Fast / keep graphs until model unload
```

For now, default should stay safe because the user reported full-card VRAM after
cancelling a stream and system freezes on the next generation.

## Current Status After 0.2.2

Implemented:

```text
native runtime graph cleanup after normal generation
native runtime graph cleanup after streaming generation
native runtime graph cleanup after cancel/error
generator graph release API
codec graph release after reference encode
codec graph release after streaming prefix decode
default UI max_tokens lowered to 1024
API examples lowered to max_tokens 1024
engine DLL version reports 0.2.2
release DLL built for 30/40/50-series CUDA architectures
```

Still to optimize:

```text
static decode KV cache allocation
ggml CUDA allocator pool retention after graph release
stateful/incremental streaming codec decode
better cancel checks inside heavy compute loop
per-stage VRAM telemetry
optional CUDA graph capture policy by stage
```
