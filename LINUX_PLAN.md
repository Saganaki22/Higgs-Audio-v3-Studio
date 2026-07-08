# Linux Stabilization Plan

This branch tracks the Linux desktop/CUDA port of Higgs Audio v3 Studio. The current priority is to stabilize Linux generation failures that happen after token generation, during the Higgs codec/vocoder decode stage.

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

