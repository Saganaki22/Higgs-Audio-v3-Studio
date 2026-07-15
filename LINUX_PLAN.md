# Linux Stabilization Plan

This branch tracks the Linux desktop/CUDA port of Higgs Audio v3 Studio. The current priority is to stabilize Linux generation failures that happen after token generation, during the Higgs codec/vocoder decode stage.

## Linux v0.3.0 Parity Plan

This section is the implementation checklist for bringing the Linux release from the
v0.2.31-era codebase to Windows `main` v0.3.0 parity. The Linux branch currently
reports `0.2.40` in several metadata files, so treat that as the actual checkout
baseline and audit every version surface before publishing. Use Windows `main`
commit `0c08ea8` as the parity reference.

Do not replace the Linux branch with Windows `main` wholesale. Preserve the Linux
engine loader, NVML handling, WebKitGTK workarounds, Linux icons and packages,
`$ORIGIN` engine runtime layout, and the codec stabilization work documented below.

### 0. Protect The Working Linux Baseline

- [ ] Commit or separately back up all current Ubuntu-only fixes before integrating v0.3.0.
- [ ] Save the last known-good `libaudiocpp_engine.so`, AppImage, DEB, and generation logs.
- [ ] Run the existing seed/max-token matrix below once and keep its results as the pre-upgrade baseline.
- [ ] Confirm UI TTS, voice clone, continue speech, multi-speaker, streaming, cancellation, API, Whisper, and Speaker Gallery still work before changing code.
- [ ] Record `ldd` output for the app binary and `libaudiocpp_engine.so` so new runtime dependencies are intentional.
- [ ] Compare `git diff linux..main` module by module. Port features selectively instead of resolving `src-tauri/src/lib.rs`, `main.ts`, or `tauri.conf.json` by choosing one side in full.

Linux behavior that must be retained:

- `libaudiocpp_engine.so` discovery and loading.
- `libnvidia-ml.so.1` NVML loading and Linux hardware telemetry.
- Linux `Download Engine Files` URLs and labels using Hugging Face `engines_linux/`.
- `$ORIGIN` rpath for the downloadable Linux engine/CUDA runtime package.
- WebKitGTK/NVIDIA DMABUF handling.
- Linux-safe UI scaling and dropdown styling.
- PNG application icons required by DEB/AppImage/RPM packaging.
- Full codec decode first, overlapped chunked fallback second.
- `HIGGS_TTS_CODEC_FALLBACK_FRAMES` and `HIGGS_TTS_CODEC_FALLBACK_OVERLAP_FRAMES` diagnostics.
- Linux CUDA architecture support for the intended RTX 30xx, 40xx, and 50xx targets.

### 1. Align Version Metadata

- [ ] Set the application version to `0.3.0` in `desktop/package.json`.
- [ ] Refresh the root/package entries in `desktop/package-lock.json` without changing unrelated dependency versions.
- [ ] Set `desktop/src-tauri/Cargo.toml` package version to `0.3.0` and refresh only the application entry in `Cargo.lock`.
- [ ] Set `desktop/src-tauri/tauri.conf.json` to `0.3.0`.
- [ ] Set `desktop/src/config.ts` `APP_VERSION` to `0.3.0`.
- [ ] Change the initial footer version in `desktop/index.html` to `v0.3.0`.
- [ ] Update Linux package filenames and commands in `README.md` and `README_ZH.md`.
- [ ] Leave historical statements such as "0.2.31 added dependency diagnostics" unchanged when they describe feature history rather than the current version.
- [ ] Verify `rg '0\.2\.40|v0\.2\.40' desktop README.md README_ZH.md` returns no stale current-release references.

### 2. Port Native Opus Reference Decoding

- [ ] Port the v0.3.0 `audio.rs` content-based WAV detection and unique temporary-file naming.
- [ ] Port native OGG/Opus and WebM/Opus packet decoding from Windows `main`.
- [ ] Add `audiopus` and its lockfile changes without removing existing Symphonia codecs.
- [ ] Decide Linux Opus linkage explicitly. Prefer static linkage for AppImage portability, or declare/package `libopus.so.0` as a DEB/RPM dependency and verify it is present in AppImage runtime testing.
- [ ] If static linkage is selected, enable the underlying `audiopus_sys` static feature or set the supported static-link environment during the release build; prove the result with `ldd`.
- [ ] Install Ubuntu build prerequisites as needed: `pkg-config`, `libopus-dev`, a C toolchain, CMake, and Clang/bindgen dependencies.
- [ ] Keep clear errors for empty packets, damaged containers, unsupported mapped multi-stream Opus, and audio above two channels.
- [ ] Test genuine Telegram OGG/Opus and WhatsApp OGG/Opus files, not only renamed Vorbis fixtures.
- [ ] Test WebM/Opus, OGG/Vorbis, WAV, MP3, FLAC, and M4A to ensure the new path does not regress existing decoding.
- [ ] Verify waveform generation, normalization, Whisper transcription, and Higgs reference preparation all consume the decoded result.

### 3. Port Microphone Reference Recording

- [ ] Add `cpal` and `hound` plus the matching Cargo lockfile changes.
- [ ] Add `desktop/src-tauri/src/recorder.rs` and register its Tauri commands/events without removing Linux-specific command registration.
- [ ] Add `desktop/src/referenceRecorder.ts` and integrate it into `main.ts`.
- [ ] Port the recorder markup, styles, types, and event bindings from `index.html`, `styles.css`, and `types.ts`.
- [ ] Install `libasound2-dev` for Ubuntu builds and include the appropriate ALSA runtime dependency in DEB/RPM metadata.
- [ ] Test microphone enumeration through the host's PipeWire/PulseAudio ALSA compatibility layer.
- [ ] Test the default input plus at least one explicitly selected USB/Bluetooth microphone.
- [ ] Verify recording works in Voice Clone, Continue Speech, Speaker Gallery, Multi Speaker identities, and line-specific reference overrides.
- [ ] Confirm live meter/waveform events do not block the WebKitGTK UI thread.
- [ ] Confirm stop, automatic 30-second stop, replace, retry, and remove all release the CPAL stream and file writer.
- [ ] Verify device removal and permission-denied errors show useful messages instead of panicking.
- [ ] Verify a completed recording becomes a valid mono WAV before replacing the current reference.
- [ ] Recheck the recorder toolbar and timer at the minimum window size and every supported UI scale.

### 4. Port Reference Trimming

- [ ] Port `audio::trim_reference_wav` and its Rust unit test.
- [ ] Register the `trim_reference_audio` command in the Linux command handler.
- [ ] Add `desktop/src/referenceTrimmer.ts` and its modal/waveform styles.
- [ ] Integrate trimming into Voice Clone, Continue Speech, Speaker Gallery, Multi Speaker identities, and line-specific overrides.
- [ ] Enforce a minimum non-empty selection and the 30-second cloning-reference maximum.
- [ ] Confirm applying a trim writes a new WAV in the correct Linux temp/storage directory before replacing the current reference path.
- [ ] Confirm trimming a saved speaker clears stale `.hspkcache` state and refreshes the live API speaker registry.
- [ ] Test play-selection, playhead-to-start/end controls, numeric controls, drag handles, close/cancel, light/dark themes, and low-window tooltip/modal stacking.
- [ ] Confirm the trimmed file, not the original, is supplied to Higgs and optional Whisper transcription.

### 5. Port Storage Routing Without Breaking AppImage

- [ ] Port `desktop/src-tauri/src/storage.rs` and `desktop/src/storage.ts` so recorder, trimmer, models, speakers, and downloads use one path policy.
- [ ] Call storage initialization before any feature tries to create temporary files or speaker directories.
- [ ] Keep installed Linux engine downloads at `~/.higgs-audio-v3-studio/engine/`.
- [ ] Keep installed Linux model downloads at `~/audiocpp/models/` unless a deliberate migration is introduced.
- [ ] Keep installed speaker/settings data under the normal Tauri/XDG application-data directory.
- [ ] Do not place `portable.flag` inside an AppImage: its mounted application directory is read-only. AppImage must use installed/XDG storage mode.
- [ ] If a raw portable tar/zip is published, put `portable.flag` beside its writable binary and verify `resources/engine/`, `models/`, and `data/` resolve beside that binary.
- [ ] Store portable paths relatively (`@portable/...`) so moving a raw portable directory does not break selected model/reference paths.
- [ ] Test paths containing spaces, non-ASCII names, symlinks, and a second mounted drive.
- [ ] Document AppImage, DEB/RPM, and optional raw-portable storage separately.

### 6. Port The Bundled API Test Console

- [ ] Add `desktop/src-tauri/resources/api-console/higgs-console.html`.
- [ ] Add the API console resource to the Linux Tauri bundle configuration.
- [ ] Port `open_api_console` and retain the Linux `xdg-open` default-browser path.
- [ ] Verify packaged resource discovery for DEB, AppImage, RPM, and `tauri dev`; do not assume the Windows `resources/resources/...` layout is the only layout.
- [ ] Register the command without removing Linux-specific Tauri setup, tray, or close behavior.
- [ ] Test current base URL injection and API-key clipboard copy.
- [ ] Test health, status, models, speakers, plain TTS, saved-speaker clone, reference clone, continue speech, WAV, MP3, and NDJSON streaming.
- [ ] Confirm streamed live chunks remain WAV/PCM while the final event respects requested WAV or MP3 output.
- [ ] Confirm final NDJSON events work without a trailing newline and malformed events show a useful error.

### 7. Port Token Progress And UI Fixes

- [ ] Port generated-token `current / total` display beside elapsed time while preserving Linux line-progress and streaming labels.
- [ ] Verify native progress callbacks on Linux actually provide totals; use a graceful elapsed-only fallback when they do not.
- [ ] Port recorder timer overflow fixes and Normalize Reference toggle alignment.
- [ ] Port waveform refresh fixes for theme changes and newly recorded/uploaded references.
- [ ] Check every toggle at 100%, minimum, and maximum supported UI scale under WebKitGTK.
- [ ] Test dark/light themes and all accent colors without reintroducing Windows-only CSS behavior.
- [ ] Verify advanced-option tooltips are not clipped by workflow containers.

### 8. Port The Codec Input Upload Optimization

- [ ] Apply the v0.3.0 packed codec input tensor change to the existing Linux `DecoderGraph`.
- [ ] Replace per-codebook backend uploads with one contiguous packed I32 tensor upload and codebook views.
- [ ] Preserve Linux full-decode-first behavior and the current chunked fallback logic exactly.
- [ ] Do not reintroduce `ggml_gallocr_alloc_graph` into the unstable final codec path.
- [ ] Rebuild `libaudiocpp_engine.so` for the intended CUDA architectures.
- [ ] Run the complete seed/max-token matrix below before and after the packed upload change.
- [ ] Compare output duration, waveform/spectral shape, audible joins, codec input-upload timing, total decode time, and peak VRAM.
- [ ] Confirm fallback telemetry still appears for retryable failures and no new tensor-stride or codebook-order errors occur.

### 9. Keep Engine Files Out Of Linux App Packages

- [ ] Remove `resources/engine/*` from Linux `tauri.conf.json` application resources.
- [ ] Keep Higgs config/tokenizer assets and the API console bundled with the app.
- [ ] Do not embed `libaudiocpp_engine.so`, `libcudart`, `libcublas`, `libcublasLt`, or other engine CUDA libraries in DEB, RPM, AppImage, or the raw app binary.
- [ ] Keep the separate Hugging Face `engines_linux/` package and `Download Engine Files` workflow.
- [ ] Confirm a missing engine never crashes startup; the wizard and sidebar must remain usable and direct the user to download it.
- [ ] Verify partial engine downloads report the exact missing `.so` files and can resume/retry.
- [ ] Inspect DEB contents with `dpkg-deb -c` and fail release validation if engine/CUDA `.so` files are present.
- [ ] Inspect AppImage contents with `--appimage-extract` or `unsquashfs -l` and fail validation if engine/CUDA `.so` files are present.
- [ ] Inspect RPM contents with `rpm -qlp` when publishing RPM.
- [ ] Record final compressed package sizes and investigate any unexpected large increase.

Expected installed Linux engine destination:

```text
~/.higgs-audio-v3-studio/engine/
  libaudiocpp_engine.so
  libcudart.so.13
  libcublas.so.13
  libcublasLt.so.13
```

### 10. Build And Test Matrix

Install/confirm Ubuntu build dependencies, including the existing Tauri/WebKitGTK
requirements plus the new microphone and Opus requirements:

```bash
sudo apt update
sudo apt install -y \
  build-essential cmake ninja-build pkg-config clang libclang-dev \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
  libasound2-dev libopus-dev
```

Required source checks:

```bash
cd desktop
npm ci
npm run build:vite
cd src-tauri
cargo check --locked
cargo test --locked
```

Required native and package checks:

- [ ] Build the Linux CUDA engine with the known-good Linux CMake options.
- [ ] Run TTS, clone, continuation, multi-speaker, streaming, cancellation, and regeneration after cancellation.
- [ ] Test Q4_K_M, Q5_K, Q6_K, Q8_0, and BF16 where hardware permits.
- [ ] Test max tokens `128`, `256`, `512`, `1024`, and `2048` with fixed and random seeds.
- [ ] Run the codec failure matrix in this document with streaming both on and off.
- [ ] Confirm VRAM returns to the loaded-model baseline after success, error, and cancellation.
- [ ] Test Speaker Gallery create/edit/delete, image replace/remove, transcript edit/Whisper, selected ZIP export/import, and `.hspkcache` reuse.
- [ ] Test API and UI requests serially through the shared generation lock/queue.
- [ ] Test system tray open/cancel/quit and minimize-to-tray API operation.
- [ ] Build DEB and AppImage, then test each on a clean Ubuntu user account without a local development checkout.
- [ ] Test startup with no engine, no model, no Whisper model, missing microphone permission/device, and no network.
- [ ] Confirm external links and the API console open in the default browser through `xdg-open`.

### 11. Documentation And Release Acceptance

- [ ] Update Linux `README.md` and `README_ZH.md` to v0.3.0 without copying Windows-only installation paths or DLL diagnostics into Linux instructions.
- [ ] Document microphone dependencies and Linux audio-stack troubleshooting.
- [ ] Document native OGG/Opus and WebM/Opus support and whether `libopus` is static or a package dependency.
- [ ] Document AppImage/XDG storage and explain why AppImage is not `portable.flag` mode.
- [ ] Document that engine `.so` files are separate downloads from Hugging Face.
- [ ] Add v0.3.0 Linux release notes covering parity features plus retained codec fallback stabilization.
- [ ] Verify GitHub artifact names, package version metadata, desktop entry, icon, and About/footer version all say `0.3.0`.
- [ ] Publish only after DEB/AppImage content inspection confirms no engine/CUDA `.so` payloads.

Linux v0.3.0 is ready when all v0.3.0 workflows behave like Windows where the
platform allows, the Linux-specific engine/graphics/package behavior remains intact,
the codec seed matrix is stable, and clean-system package tests pass without relying
on files from the build machine.

## Current Problem

Some Linux generations complete the text/audio-token generation stage, then fail during decode with an error around the Higgs codec graph. The failure is seed- and length-sensitive:

- Example: seed `0` can fail with `max_tokens=1024`.
- The same seed may not fail with `max_tokens=2048`.
- Other seeds can still fail at different token limits.

That pattern points at final codec/vocoder graph shape sensitivity, not model loading, prompt parsing, or CUDA graph capture. Different seeds stop at different audio-code frame counts, so only some final codec graph shapes hit the Linux failure.

## Windows vs Linux Difference

The Windows/main path used the older codec decoder tensor allocation path:

- `ggml_backend_alloc_ctx_tensors`
- 1 GB default codec graph arena

The Linux branch briefly changed the codec decoder to:

- `ggml_gallocr_alloc_graph`
- 4 GB default codec graph arena

`gallocr` is GGML's graph allocator. It is useful when graph shapes are stable because it can plan tensor lifetimes and reuse memory. In this Higgs codec decoder path, the vocoder graph shape changes with generated frame count. On Linux/CUDA, some shapes appear to fail even when VRAM is available.

## Fixes Already Applied

The current Linux branch now:

1. Restores the codec decoder to `ggml_backend_alloc_ctx_tensors`.
2. Restores the default codec graph arena to 1 GB.
3. Keeps full final codec decode as the first/default path.
4. Adds a retry fallback only if full decode fails with a retryable codec graph error.
5. The fallback decodes in overlapped chunks instead of one large final graph.
6. Adds environment variables for quick Ubuntu testing without repeatedly changing source constants.

Current fallback environment variables:

```bash
export HIGGS_TTS_CODEC_FALLBACK_FRAMES=256
export HIGGS_TTS_CODEC_FALLBACK_OVERLAP_FRAMES=8
```

Recommended test values for `HIGGS_TTS_CODEC_FALLBACK_FRAMES`:

```text
256
128
64
32
```

Set overlap to `8` first. If chunked decode still fails or the join sounds odd, test overlap `0`.

## Ubuntu Pull And Rebuild

From the Ubuntu checkout:

```bash
git checkout linux
git pull
```

Build the native engine:

```bash
cmake -S . -B build/linux-cuda-release -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DENGINE_ENABLE_CUDA=ON \
  -DENGINE_ENABLE_CUDA_GRAPHS=OFF \
  -DENGINE_ENABLE_OPENMP=ON \
  -DGGML_OPENMP=ON \
  -DENGINE_BUILD_DESKTOP_API=ON

cmake --build build/linux-cuda-release --target audiocpp_engine -j"$(nproc)"
```

Then rebuild the Tauri app from `desktop/`:

```bash
cd desktop
npm ci
npm run build:vite
npm run build
```

If testing directly from a terminal with env vars, export the vars before launching the app from that same terminal.

## Required Test Matrix

Use the exact prompt/text that was failing before.

Test these first:

```text
seed=0, max_tokens=1024
seed=0, max_tokens=2048
known failing seed, max_tokens=1024
known failing seed, max_tokens=2048
3 random seeds, max_tokens=1024
3 random seeds, max_tokens=2048
```

For each failed run, repeat with:

```bash
export HIGGS_TTS_CODEC_FALLBACK_FRAMES=128
```

Then if needed:

```bash
export HIGGS_TTS_CODEC_FALLBACK_FRAMES=64
```

Then if needed:

```bash
export HIGGS_TTS_CODEC_FALLBACK_FRAMES=32
```

## Logs To Check

A successful fallback should log these trace names:

```text
higgs_tts.codec.chunked_decode_fallback
higgs_tts.codec.chunked_decode_original_frames
higgs_tts.codec.chunked_decode_initial_frames
higgs_tts.codec.chunked_decode_frames
higgs_tts.codec.chunked_decode_overlap_frames
```

If the app still fails at decode, capture:

```text
full error text
seed
max_tokens
actual prompt length
model quant
whether streaming is enabled
HIGGS_TTS_CODEC_FALLBACK_FRAMES value
HIGGS_TTS_CODEC_FALLBACK_OVERLAP_FRAMES value
last 50 native trace/log lines
```

## Next Fixes If It Still Fails

If fallback logs do not appear, the Rust/UI layer may be surfacing a different native error string than the retry detector catches. Next step: broaden the retry detector with the exact error text.

If fallback appears but still fails at `256`, test `128`, `64`, and `32`. If one works reliably, make that value the Linux default.

If fallback appears and succeeds but audio joins sound rough, tune overlap:

```text
8 frames = about 0.32 seconds
4 frames = about 0.16 seconds
0 frames = no overlap
```

If full decode keeps failing frequently on Linux even after allocator rollback, make Linux use preemptive chunked final decode for outputs over a frame threshold, while Windows keeps full decode.

If failures happen only with streaming enabled, compare:

```text
streaming on
streaming off
API streaming
normal UI generation
```

Streaming already decodes prefixes during generation. The final decode fallback should protect the final render, but streaming-specific decode paths may need the same configurable chunking if the failure is in a prefix decode.

## Longer-Term Linux Work

- Add a Linux-only setting in advanced diagnostics for codec fallback frames.
- Add codec frame count and fallback state to the UI/API diagnostics.
- Add an engine self-test that runs a tiny fixed-seed generation and reports whether codec full decode and fallback decode work.
- Keep Windows and Linux native paths as close as possible unless a Linux-specific allocator workaround is proven necessary.
- Only reintroduce `gallocr` for codec decode if there is a reproducible test showing it is stable across many generated frame counts on Linux/CUDA.
