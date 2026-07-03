import "./styles.css";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

type Mode = "tts" | "clone" | "finish" | "multi" | "history";
type SaveFormat = "wav" | "mp3";
type DownloadKind = "model" | "whisper" | "engine";

type WhisperModelPreset = {
  id: string;
  size: string;
  sha: string;
  recommended?: boolean;
};

type ModelListing = {
  name: string;
  path: string;
  format: string;
  sizeBytes: number;
  hasConfig: boolean;
};

type GenerationResult = {
  sampleRate: number;
  channels: number;
  sampleCount: number;
  wavBase64: string;
};

type HardwareSnapshot = {
  gpuName: string;
  totalVram: number;
  usedVram: number;
  freeVram: number;
  gpuUtilization: number;
  temperature: number;
  powerDraw: number;
  powerLimit: number;
  processRam: number;
  totalRam: number;
  usedRam: number;
  message: string;
};

type ProgressEvent = {
  current: number;
  total: number;
  phase: string;
};

type DownloadProgressEvent = {
  downloaded: number;
  total: number;
  speedMbps: number;
  percent: number;
};

type ModelStatusEvent = {
  engineLoaded: boolean;
  modelLoaded: boolean;
  family?: string;
  displayName?: string;
  weightType?: string;
};

type HistoryEntry = {
  id: string;
  mode: Mode;
  label: string;
  timestamp: number;
  wavBase64: string;
  sampleRate: number;
  channels: number;
};

type MultiSpeaker = {
  id: string;
  name: string;
  refPath: string | null;
  refName: string;
  refText: string;
  open: boolean;
};

type MultiLine = {
  id: string;
  speakerId: string;
  text: string;
  overridePath: string | null;
  overrideName: string;
  overrideText: string;
  open: boolean;
};

type LinePointerDrag = {
  id: string;
  pointerId: number;
  grip: HTMLElement;
  active: boolean;
};

type RefPreviewKind = "clone" | "finish";

type RefPlayer = {
  audio: HTMLAudioElement;
  play: HTMLButtonElement;
  seek: HTMLInputElement;
  time: HTMLElement;
  canvas: HTMLCanvasElement;
  raf: number | null;
};

type WavPcm = {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
};

type LameJs = {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => {
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  };
};

let lamejsPromise: Promise<LameJs> | null = null;

function loadLameJs(): Promise<LameJs> {
  if (!lamejsPromise) {
    lamejsPromise = import("lamejs/lame.all.js?raw").then(({ default: source }) => (
      new Function(`${source}\nreturn lamejs;`)() as LameJs
    ));
  }
  return lamejsPromise;
}

// ═══════════════════════════════════════════════════════════════════════════
// DOM helpers
// ═══════════════════════════════════════════════════════════════════════════

function el<T extends HTMLElement>(id: string): T {
  return document.querySelector<T>(id)!;
}

function setText(id: string, text: string): void {
  const e = el<HTMLElement>(id);
  if (e) e.textContent = text;
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function setProgress(id: string, current: number, total: number): void {
  const pct = total > 0 ? Math.min(100, Math.max(0, (current / total) * 100)) : 0;
  const e = el<HTMLElement>(id);
  if (e) e.style.width = `${pct}%`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "−";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = new Uint8Array(atob(base64).split("").map((c) => c.charCodeAt(0)));
  return new Blob([bytes], { type: mime });
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function parseWavPcm(base64: string): WavPcm {
  const bytes = base64ToBytes(base64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44 || view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error("Invalid WAV data");
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkData = offset + 8;
    if (chunkId === "fmt ") {
      const format = view.getUint16(chunkData, true);
      channels = view.getUint16(chunkData + 2, true);
      sampleRate = view.getUint32(chunkData + 4, true);
      bitsPerSample = view.getUint16(chunkData + 14, true);
      if (format !== 1 || bitsPerSample !== 16) {
        throw new Error("Only PCM16 WAV output is supported");
      }
    } else if (chunkId === "data") {
      dataOffset = chunkData;
      dataSize = chunkSize;
      break;
    }
    offset = chunkData + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || !channels || dataOffset < 0) throw new Error("WAV data is missing audio samples");
  const sampleCount = Math.floor(dataSize / 2);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getInt16(dataOffset + i * 2, true);
  }
  return { sampleRate, channels, samples };
}

function encodeWavPcm(pcm: WavPcm): string {
  const dataBytes = pcm.samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, pcm.channels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * pcm.channels * 2, true);
  view.setUint16(32, pcm.channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.samples.length; i++) {
    view.setInt16(44 + i * 2, pcm.samples[i], true);
  }
  return bytesToBase64(bytes);
}

function concatenateWavResults(results: GenerationResult[], pauseSeconds = 0): GenerationResult {
  if (results.length === 0) throw new Error("No audio to combine");
  const decoded = results.map((result) => parseWavPcm(result.wavBase64));
  const sampleRate = decoded[0].sampleRate;
  const channels = decoded[0].channels;
  for (const wav of decoded) {
    if (wav.sampleRate !== sampleRate || wav.channels !== channels) {
      throw new Error("Cannot combine audio with different sample rates or channel counts");
    }
  }
  const pauseSamples = Math.max(0, Math.round(pauseSeconds * sampleRate)) * channels;
  const totalSamples = decoded.reduce((sum, wav) => sum + wav.samples.length, 0)
    + Math.max(0, decoded.length - 1) * pauseSamples;
  const combined = new Int16Array(totalSamples);
  let offset = 0;
  decoded.forEach((wav, index) => {
    combined.set(wav.samples, offset);
    offset += wav.samples.length;
    if (pauseSamples > 0 && index < decoded.length - 1) offset += pauseSamples;
  });
  return {
    sampleRate,
    channels,
    sampleCount: totalSamples,
    wavBase64: encodeWavPcm({ sampleRate, channels, samples: combined }),
  };
}

async function encodeMp3FromWav(base64: string): Promise<Uint8Array> {
  const lamejs = await loadLameJs();
  const wav = parseWavPcm(base64);
  const encoder = new lamejs.Mp3Encoder(wav.channels, wav.sampleRate, 128);
  const chunks: Int8Array[] = [];
  const frameSize = 1152;

  if (wav.channels === 1) {
    for (let i = 0; i < wav.samples.length; i += frameSize) {
      const encoded = encoder.encodeBuffer(wav.samples.subarray(i, i + frameSize));
      if (encoded.length) chunks.push(encoded);
    }
  } else if (wav.channels === 2) {
    const frames = Math.floor(wav.samples.length / 2);
    const left = new Int16Array(frames);
    const right = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      left[i] = wav.samples[i * 2];
      right[i] = wav.samples[i * 2 + 1];
    }
    for (let i = 0; i < frames; i += frameSize) {
      const encoded = encoder.encodeBuffer(left.subarray(i, i + frameSize), right.subarray(i, i + frameSize));
      if (encoded.length) chunks.push(encoded);
    }
  } else {
    throw new Error("MP3 export supports mono or stereo WAV output");
  }

  const tail = encoder.flush();
  if (tail.length) chunks.push(tail);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const mp3 = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    mp3.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
    offset += chunk.length;
  }
  return mp3;
}

async function openExternalUrl(url: string): Promise<void> {
  try {
    await invoke("open_external_url", { url });
  } catch (e) {
    showToast(`Could not open link: ${e}`, "error");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

const APP_VERSION = "0.1.0";
const GITHUB_URL = "https://github.com/Saganaki22/Higgs-Audio-v3-Studio";
const RELEASES_URL = "https://github.com/Saganaki22/Higgs-Audio-v3-Studio/releases";
const HIGGS_MODEL_RESOLVE_BASE = "https://huggingface.co/drbaph/Higgs-Audio-v3-Studio/resolve/main";
const HIGGS_RECOMMENDED_MODEL_URL = `${HIGGS_MODEL_RESOLVE_BASE}/models/higgs-q8_0/q8_0.gguf`;
const ENGINE_DLL_URL = "https://huggingface.co/drbaph/Higgs-Audio-v3-Studio/resolve/main/engines/audiocpp_engine.dll";
const WHISPER_MODELS_URL = "https://huggingface.co/ggerganov/whisper.cpp";
const WHISPER_MODEL_TREE_URL = `${WHISPER_MODELS_URL}/tree/main`;
const WHISPER_MODEL_RESOLVE_BASE = `${WHISPER_MODELS_URL}/resolve/main`;
const WHISPER_RECOMMENDED_MODEL = "base.en-q8_0";
const WHISPER_MODEL_PRESETS: WhisperModelPreset[] = [
  { id: "tiny", size: "75 MiB", sha: "bd577a113a864445d4c299885e0cb97d4ba92b5f" },
  { id: "tiny-q5_1", size: "31 MiB", sha: "2827a03e495b1ed3048ef28a6a4620537db4ee51" },
  { id: "tiny-q8_0", size: "42 MiB", sha: "19e8118f6652a650569f5a949d962154e01571d9" },
  { id: "tiny.en", size: "75 MiB", sha: "c78c86eb1a8faa21b369bcd33207cc90d64ae9df" },
  { id: "tiny.en-q5_1", size: "31 MiB", sha: "3fb92ec865cbbc769f08137f22470d6b66e071b6" },
  { id: "tiny.en-q8_0", size: "42 MiB", sha: "802d6668e7d411123e672abe4cb6c18f12306abb" },
  { id: "base", size: "142 MiB", sha: "465707469ff3a37a2b9b8d8f89f2f99de7299dac" },
  { id: "base-q5_1", size: "57 MiB", sha: "a3733eda680ef76256db5fc5dd9de8629e62c5e7" },
  { id: "base-q8_0", size: "78 MiB", sha: "7bb89bb49ed6955013b166f1b6a6c04584a20fbe" },
  { id: "base.en", size: "142 MiB", sha: "137c40403d78fd54d454da0f9bd998f78703390c", recommended: true },
  { id: "base.en-q5_1", size: "57 MiB", sha: "d26d7ce5a1b6e57bea5d0431b9c20ae49423c94a" },
  { id: "base.en-q8_0", size: "78 MiB", sha: "bb1574182e9b924452bf0cd1510ac034d323e948", recommended: true },
  { id: "small", size: "466 MiB", sha: "55356645c2b361a969dfd0ef2c5a50d530afd8d5" },
  { id: "small-q5_1", size: "181 MiB", sha: "6fe57ddcfdd1c6b07cdcc73aaf620810ce5fc771" },
  { id: "small-q8_0", size: "252 MiB", sha: "bcad8a2083f4e53d648d586b7dbc0cd673d8afad" },
  { id: "small.en", size: "466 MiB", sha: "db8a495a91d927739e50b3fc1cc4c6b8f6c2d022" },
  { id: "small.en-q5_1", size: "181 MiB", sha: "20f54878d608f94e4a8ee3ae56016571d47cba34" },
  { id: "small.en-q8_0", size: "252 MiB", sha: "9d75ff4ccfa0a8217870d7405cf8cef0a5579852" },
  { id: "small.en-tdrz", size: "465 MiB", sha: "b6c6e7e89af1a35c08e6de56b66ca6a02a2fdfa1" },
  { id: "medium", size: "1.5 GiB", sha: "fd9727b6e1217c2f614f9b698455c4ffd82463b4" },
  { id: "medium-q5_0", size: "514 MiB", sha: "7718d4c1ec62ca96998f058114db98236937490e" },
  { id: "medium-q8_0", size: "785 MiB", sha: "e66645948aff4bebbec71b3485c576f3d63af5d6" },
  { id: "medium.en", size: "1.5 GiB", sha: "8c30f0e44ce9560643ebd10bbe50cd20eafd3723" },
  { id: "medium.en-q5_0", size: "514 MiB", sha: "bb3b5281bddd61605d6fc76bc5b92d8f20284c3b" },
  { id: "medium.en-q8_0", size: "785 MiB", sha: "b1cf48c12c807e14881f634fb7b6c6ca867f6b38" },
  { id: "large-v1", size: "2.9 GiB", sha: "b1caaf735c4cc1429223d5a74f0f4d0b9b59a299" },
  { id: "large-v2", size: "2.9 GiB", sha: "0f4c8e34f21cf1a914c59d8b3ce882345ad349d6" },
  { id: "large-v2-q5_0", size: "1.1 GiB", sha: "00e39f2196344e901b3a2bd5814807a769bd1630" },
  { id: "large-v2-q8_0", size: "1.5 GiB", sha: "da97d6ca8f8ffbeeb5fd147f79010eeea194ba38" },
  { id: "large-v3", size: "2.9 GiB", sha: "ad82bf6a9043ceed055076d0fd39f5f186ff8062" },
  { id: "large-v3-q5_0", size: "1.1 GiB", sha: "e6e2ed78495d403bef4b7cff42ef4aaadcfea8de" },
  { id: "large-v3-turbo", size: "1.5 GiB", sha: "4af2b29d7ec73d781377bfd1758ca957a807e941" },
  { id: "large-v3-turbo-q5_0", size: "547 MiB", sha: "e050f7970618a659205450ad97eb95a18d69c9ee", recommended: true },
  { id: "large-v3-turbo-q8_0", size: "834 MiB", sha: "01bf15bedffe9f39d65c1b6ff9b687ea91f59e0e" },
];

let currentMode: Mode = "tts";
let isGenerating = false;
let cloneRefPath: string | null = null;
let finishRefPath: string | null = null;
let lastResult: GenerationResult | null = null;
const outputByMode: Partial<Record<Mode, GenerationResult>> = {};
let history: HistoryEntry[] = [];
let activeWork = 0;
let genStartedAt = 0;
let genTimer: number | null = null;
let idCounter = 0;
let selectedSaveFormat: SaveFormat = (localStorage.getItem("higgsAudio.saveFormat") as SaveFormat) || "wav";
let currentProgressLabels: string[] = [];
let draggedLineId: string | null = null;
let linePointerDrag: LinePointerDrag | null = null;
let activeDownloadKind: DownloadKind = "model";

// Settings state
let currentTheme = localStorage.getItem("higgsAudio.theme") || "dark";
let currentAccent = localStorage.getItem("higgsAudio.accent") || "teal";
let currentUiScale = parseInt(localStorage.getItem("higgsAudio.uiScale") ?? "100", 10);

// Hardware state
let hardwarePollMs = parseInt(localStorage.getItem("higgsAudio.hardwarePollMs") ?? "1000", 10);
const hardwareHistory: HardwareSnapshot[] = [];
const hardwareHistoryLimit = 1200; // ~20 min at 1s/tick
const hardwareGraphPoints = 120;   // visible window width
let hardwareViewOffset = 0;        // 0 = live (right edge), positive = looking back
let hardwareFollowLive = true;     // when true, graph auto-scrolls to newest
let hardwareScrubDrag: { startX: number; startOffset: number } | null = null;
let hardwareHover: { x: number; idx: number } | null = null;

const audioPlayer = el<HTMLAudioElement>("#audio-player");

const multiSpeakers: MultiSpeaker[] = [];
const multiLines: MultiLine[] = [];
const refPlayers: Partial<Record<RefPreviewKind, RefPlayer>> = {};

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Toast
// ═══════════════════════════════════════════════════════════════════════════

let toastTimer: number | null = null;

function showToast(message: string, tone: "success" | "warning" | "error" = "success"): void {
  const toast = el<HTMLDivElement>("#toast");
  toast.textContent = message;
  toast.className = "toast";
  if (tone !== "success") toast.classList.add(tone);
  toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("show");
    toastTimer = null;
  }, 3200);
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings system
// ═══════════════════════════════════════════════════════════════════════════

function applyTheme(theme: string): void {
  currentTheme = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", currentTheme);
  localStorage.setItem("higgsAudio.theme", currentTheme);
  el<HTMLButtonElement>("#theme-dark").classList.toggle("active", currentTheme === "dark");
  el<HTMLButtonElement>("#theme-light").classList.toggle("active", currentTheme === "light");
  drawHardwareGraph();
  drawWaveform();
}

function applyAccent(accent: string): void {
  const allowed = ["teal", "blue", "green", "red", "yellow"];
  currentAccent = allowed.includes(accent) ? accent : "teal";
  document.documentElement.setAttribute("data-accent", currentAccent);
  localStorage.setItem("higgsAudio.accent", currentAccent);
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-accent-choice]")) {
    btn.classList.toggle("active", btn.dataset.accentChoice === currentAccent);
  }
  drawHardwareGraph();
  drawWaveform();
}

function applyUiScale(percent: number): void {
  currentUiScale = Math.min(115, Math.max(90, percent || 100));
  document.documentElement.style.setProperty("--ui-scale", (currentUiScale / 100).toFixed(2));
  localStorage.setItem("higgsAudio.uiScale", String(currentUiScale));
  el<HTMLInputElement>("#ui-scale").value = String(currentUiScale);
  setText("#ui-scale-label", `${currentUiScale}%`);
  requestAnimationFrame(() => {
    drawHardwareGraph();
    drawWaveform();
  });
}

function initSettings(): void {
  const button = el<HTMLButtonElement>("#settings-button");
  const popover = el<HTMLDivElement>("#settings-popover");
  const setOpen = (open: boolean) => {
    popover.hidden = !open;
    button.classList.toggle("active", open);
  };
  button.addEventListener("click", (e) => { e.stopPropagation(); setOpen(popover.hidden); });
  const settingsClose = document.querySelector<HTMLElement>("#settings-close");
  if (settingsClose) settingsClose.addEventListener("click", (e) => { e.stopPropagation(); setOpen(false); });
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (!popover.hidden && !popover.contains(target) && !button.contains(target)) {
      setOpen(false);
    }
  });

  el("#theme-dark").addEventListener("click", () => applyTheme("dark"));
  el("#theme-light").addEventListener("click", () => applyTheme("light"));
  for (const accentBtn of document.querySelectorAll<HTMLButtonElement>("[data-accent-choice]")) {
    accentBtn.addEventListener("click", () => applyAccent(accentBtn.dataset.accentChoice || "teal"));
  }
  el<HTMLInputElement>("#ui-scale").addEventListener("input", (event) => {
    applyUiScale(parseInt((event.target as HTMLInputElement).value, 10));
  });

  applyAccent(currentAccent);
  applyTheme(currentTheme);
  applyUiScale(currentUiScale);
}

function initExternalLinks(): void {
  setText("#version-link", `v${APP_VERSION}`);
  el("#github-link").addEventListener("click", () => openExternalUrl(GITHUB_URL));
  el("#version-link").addEventListener("click", () => openExternalUrl(RELEASES_URL));
}

function setWhisperModelPath(path: string): void {
  el<HTMLInputElement>("#whisper-model-path").value = path;
  localStorage.setItem("higgsAudio.whisperModel", path);
}

function whisperPresetFilename(preset: WhisperModelPreset): string {
  return `ggml-${preset.id}.bin`;
}

function whisperPresetUrl(preset: WhisperModelPreset): string {
  return `${WHISPER_MODEL_RESOLVE_BASE}/${whisperPresetFilename(preset)}`;
}

function selectedWhisperPreset(): WhisperModelPreset {
  const selectedId = el<HTMLSelectElement>("#whisper-model-select").value || WHISPER_RECOMMENDED_MODEL;
  return WHISPER_MODEL_PRESETS.find((preset) => preset.id === selectedId) || WHISPER_MODEL_PRESETS[0];
}

function populateWhisperModelSelect(): void {
  const select = el<HTMLSelectElement>("#whisper-model-select");
  const savedPreset = localStorage.getItem("higgsAudio.whisperPreset") || WHISPER_RECOMMENDED_MODEL;
  select.innerHTML = "";
  for (const preset of WHISPER_MODEL_PRESETS) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = `${preset.recommended ? "★ " : ""}${preset.id} · ${preset.size}${preset.recommended ? " · recommended" : ""}`;
    option.title = `${whisperPresetFilename(preset)} | SHA1 ${preset.sha}`;
    select.appendChild(option);
  }
  select.value = WHISPER_MODEL_PRESETS.some((preset) => preset.id === savedPreset) ? savedPreset : WHISPER_RECOMMENDED_MODEL;
}

function initWhisperPanel(): void {
  const whisperInput = el<HTMLInputElement>("#whisper-model-path");
  const whisperSelect = el<HTMLSelectElement>("#whisper-model-select");
  populateWhisperModelSelect();
  whisperInput.value = localStorage.getItem("higgsAudio.whisperModel") || "";
  whisperInput.addEventListener("change", () => setWhisperModelPath(whisperInput.value.trim()));
  whisperSelect.addEventListener("change", () => {
    localStorage.setItem("higgsAudio.whisperPreset", whisperSelect.value);
  });
  el("#whisper-browse-btn").addEventListener("click", async () => {
    const selected = await open({
      filters: [{ name: "Whisper Model", extensions: ["bin"] }],
    });
    if (selected) setWhisperModelPath(selected);
  });
  el("#whisper-models-link").addEventListener("click", () => openExternalUrl(WHISPER_MODEL_TREE_URL));
}

// ═══════════════════════════════════════════════════════════════════════════
// Mode switching
// ═══════════════════════════════════════════════════════════════════════════

function switchMode(mode: Mode): void {
  if (isGenerating) {
    showToast("Cannot switch modes while generating", "warning");
    return;
  }
  currentMode = mode;
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".mode-tab")) {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const content of document.querySelectorAll<HTMLElement>(".mode-content")) {
    content.classList.toggle("hidden", content.id !== `mode-${mode}`);
  }
  // Hide generation UI when in history mode
  const isHistory = mode === "history";
  el<HTMLElement>("#advanced-details").classList.toggle("hidden", isHistory);
  el<HTMLElement>("#action-row").classList.toggle("hidden", isHistory);
  el<HTMLElement>("#progress-section").classList.toggle("hidden", isHistory || !isGenerating);
  for (const item of document.querySelectorAll<HTMLElement>(".multi-only-advanced")) {
    item.classList.toggle("hidden", mode !== "multi");
  }

  // Show this mode's output if it has one, otherwise hide
  const modeOutput = outputByMode[mode];
  if (modeOutput && !isHistory) {
    lastResult = modeOutput;
    showOutput(modeOutput);
  } else {
    el<HTMLElement>("#output-section").classList.add("hidden");
  }
}

function initModeTabs(): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".mode-tab")) {
    tab.addEventListener("click", () => switchMode(tab.dataset.mode as Mode));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Model management
// ═══════════════════════════════════════════════════════════════════════════

function isRecommendedTtsModel(model: ModelListing): boolean {
  return model.name.toLowerCase().includes("q8_0");
}

function modelDisplayName(model: ModelListing): string {
  const name = model.name.toLowerCase();
  if (name.includes("bf16")) return "Higgs Audio v3 BF16";
  if (name.includes("q8_0")) return "Higgs Audio v3 Q8_0";
  if (name.includes("q4_k")) return "Higgs Audio v3 Q4_K_M";
  return model.name;
}

function modelSortRank(model: ModelListing): number {
  const name = model.name.toLowerCase();
  if (name.includes("q8_0")) return 0;
  if (name.includes("q4_k")) return 1;
  if (name.includes("bf16")) return 2;
  return 10;
}

async function refreshModelList(): Promise<void> {
  try {
    const models = await invoke<ModelListing[]>("list_models");
    const sortedModels = [...models].sort((a, b) => {
      const rank = modelSortRank(a) - modelSortRank(b);
      return rank !== 0 ? rank : a.name.localeCompare(b.name);
    });
    const select = el<HTMLSelectElement>("#model-select");
    const currentVal = select.value;
    select.innerHTML = '<option value="">Select a model…</option>';
    for (const m of sortedModels) {
      const opt = document.createElement("option");
      const recommended = isRecommendedTtsModel(m);
      opt.value = m.path;
      opt.textContent = `${recommended ? "★ " : ""}${modelDisplayName(m)}${recommended ? " · recommended" : ""} (${m.format}, ${formatBytes(m.sizeBytes)})`;
      opt.title = m.name;
      select.appendChild(opt);
    }
    if (currentVal && models.some((m) => m.path === currentVal)) {
      select.value = currentVal;
    }
    el<HTMLButtonElement>("#load-model-btn").disabled = false;
  } catch (e) {
    showToast(`Failed to list models: ${e}`, "error");
  }
}

async function doLoadEngine(): Promise<void> {
  try {
    const bundled = await invoke<string | null>("bundled_engine_path");
    const libPath = bundled ?? undefined;
    const result = await invoke<{ success: boolean; version: string }>("load_engine", {
      libraryPath: libPath,
    });
    if (result.success) {
      setText("#engine-chip", "Engine loaded");
      el<HTMLElement>("#engine-chip").classList.add("active");
      showToast("Engine loaded");
      await refreshModelList();
    }
  } catch (e) {
    showToast(`Failed to load engine: ${e}`, "error");
  }
}

async function doLoadModel(): Promise<void> {
  const modelRoot = el<HTMLSelectElement>("#model-select").value;
  if (!modelRoot) {
    showToast("Select a model first", "warning");
    return;
  }
  try {
    el<HTMLButtonElement>("#load-model-btn").disabled = true;
    setText("#model-state", "Loading…");
    const result = await invoke<{ success: boolean; modelInfo: { family: string; displayName: string; weightType: string } }>(
      "load_model",
      {
        request: {
          modelRoot,
          backend: "cuda",
          device: 0,
          threads: 4,
          weightType: null,
          sessionOptions: null,
        },
      },
    );
    if (result.success) {
      const info = result.modelInfo;
      setText("#model-state", "Loaded");
      el("#model-state").classList.add("ok");
      setText("#model-chip", `${info.displayName} (${info.weightType || "default"})`);
      el("#model-chip").classList.remove("muted");
      el("#model-chip").classList.add("active");
      el<HTMLButtonElement>("#unload-model-btn").disabled = false;
      showToast(`Model loaded: ${info.displayName}`);
    }
  } catch (e) {
    setText("#model-state", "Error");
    showToast(`Failed to load model: ${e}`, "error");
  } finally {
    el<HTMLButtonElement>("#load-model-btn").disabled = false;
  }
}

async function doUnloadModel(): Promise<void> {
  try {
    await invoke("unload_model");
    setText("#model-state", "Not loaded");
    el("#model-state").classList.remove("ok");
    setText("#model-chip", "No model");
    el("#model-chip").classList.add("muted");
    el("#model-chip").classList.remove("active");
    el<HTMLButtonElement>("#unload-model-btn").disabled = true;
    showToast("Model unloaded");
  } catch (e) {
    showToast(`Failed to unload: ${e}`, "error");
  }
}

function initModelPanel(): void {
  el("#load-engine-btn").addEventListener("click", doLoadEngine);
  el("#load-model-btn").addEventListener("click", doLoadModel);
  el("#unload-model-btn").addEventListener("click", doUnloadModel);
  el("#browse-model-btn").addEventListener("click", doBrowseModel);
}

async function doBrowseModel(): Promise<void> {
  const selected = await open({ directory: true, multiple: false });
  if (!selected) return;

  const dirPath = Array.isArray(selected) ? selected[0] : selected;
  const dirName = dirPath.split(/[/\\]/).pop() || dirPath;

  // Check for model files
  let hasWeights = false;
  let format = "";
  try {
    const models = await invoke<ModelListing[]>("list_models");
    const found = models.find((m) => m.path === dirPath);
    if (found) {
      hasWeights = true;
      format = found.format;
    }
  } catch {
    // list_models might not cover this dir; check via filesystem
  }

  // Add to dropdown regardless — the load will validate
  const select = el<HTMLSelectElement>("#model-select");
  for (const opt of select.options) {
    if (opt.value === dirPath) {
      select.value = dirPath;
      showToast(`Selected: ${dirName}`);
      return;
    }
  }
  const opt = document.createElement("option");
  opt.value = dirPath;
  opt.textContent = `${dirName} (local)`;
  select.appendChild(opt);
  select.value = dirPath;
  showToast(`Added local model: ${dirName}`);
  el<HTMLButtonElement>("#load-model-btn").disabled = false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Dropzone
// ═══════════════════════════════════════════════════════════════════════════

function setupDropzone(
  dropzoneId: string,
  onFile: (path: string, name: string) => void,
  onRemove?: () => void,
): void {
  const dz = el<HTMLElement>(dropzoneId);
  dz.dataset.emptyHtml = dz.innerHTML;

  dz.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    if (target.closest(".dropzone-remove")) {
      event.preventDefault();
      event.stopPropagation();
      onRemove?.();
      return;
    }
    const selected = await open({
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "m4a", "ogg", "webm"] }],
    });
    if (selected) {
      const name = selected.split(/[/\\]/).pop() || selected;
      onFile(selected, name);
    }
  });

  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag-over");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag-over");
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      onFile((file as any).path || file.name, file.name);
    }
  });
}

function setDropzoneFile(dropzoneId: string, name: string): void {
  const dz = el<HTMLElement>(dropzoneId);
  dz.classList.add("has-file");
  dz.innerHTML = `
    <div class="dropzone-file">
      <span class="dropzone-file-icon">🎵</span>
      <span class="dropzone-file-name">${escapeHtml(name)}</span>
      <button class="dropzone-remove" type="button" aria-label="Remove audio">✕</button>
      <span class="dropzone-hint">Drop another audio file to replace it</span>
    </div>`;
}

function clearDropzone(dropzoneId: string): void {
  const dz = el<HTMLElement>(dropzoneId);
  dz.classList.remove("has-file", "drag-over");
  dz.innerHTML = dz.dataset.emptyHtml || "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDuration(seconds: number): string {
  return Number.isFinite(seconds) ? formatTime(seconds) : "00:00";
}

function drawRefPreview(kind: RefPreviewKind): void {
  const player = refPlayers[kind];
  if (!player) return;
  const ctx = player.canvas.getContext("2d");
  if (!ctx) return;
  const rect = player.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (player.canvas.width !== Math.floor(width * dpr) || player.canvas.height !== Math.floor(height * dpr)) {
    player.canvas.width = Math.floor(width * dpr);
    player.canvas.height = Math.floor(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = cssVar("--bg-field", "#0f1215");
  ctx.fillRect(0, 0, width, height);
  const duration = player.audio.duration || 0;
  const progress = duration > 0 ? Math.min(1, player.audio.currentTime / duration) : 0;
  const accent = cssVar("--accent", "#25b8ab");
  const muted = cssVar("--text-muted", "#9ea8b3");
  const bars = Math.max(28, Math.floor(width / 8));
  const gap = 3;
  const barW = Math.max(2, (width - gap * (bars - 1)) / bars);
  for (let i = 0; i < bars; i += 1) {
    const t = i / Math.max(1, bars - 1);
    const barH = 8 + Math.abs(Math.sin(i * 0.83)) * (height - 14);
    const x = i * (barW + gap);
    ctx.fillStyle = t <= progress ? accent : `${muted}55`;
    ctx.fillRect(x, (height - barH) / 2, barW, barH);
  }
}

function updateRefPlayback(kind: RefPreviewKind): void {
  const player = refPlayers[kind];
  if (!player) return;
  const duration = player.audio.duration || 0;
  const current = player.audio.currentTime || 0;
  player.seek.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : "0";
  player.time.textContent = `${formatDuration(current)} / ${formatDuration(duration)}`;
  player.play.textContent = player.audio.paused ? "▶" : "⏸";
  drawRefPreview(kind);
}

function stopRefLoop(kind: RefPreviewKind): void {
  const player = refPlayers[kind];
  if (player?.raf) {
    cancelAnimationFrame(player.raf);
    player.raf = null;
  }
}

function startRefLoop(kind: RefPreviewKind): void {
  stopRefLoop(kind);
  const tick = () => {
    updateRefPlayback(kind);
    const player = refPlayers[kind];
    if (player && !player.audio.paused && !player.audio.ended) {
      player.raf = requestAnimationFrame(tick);
    }
  };
  refPlayers[kind]!.raf = requestAnimationFrame(tick);
}

function pauseOtherAudio(except?: RefPreviewKind): void {
  if (!audioPlayer.paused) audioPlayer.pause();
  el<HTMLButtonElement>("#play-btn").textContent = "▶";
  for (const kind of ["clone", "finish"] as RefPreviewKind[]) {
    if (kind === except) continue;
    const player = refPlayers[kind];
    if (player && !player.audio.paused) {
      player.audio.pause();
      updateRefPlayback(kind);
    }
  }
}

function initRefPlayer(kind: RefPreviewKind): void {
  const player: RefPlayer = {
    audio: new Audio(),
    play: el<HTMLButtonElement>(`#${kind}-ref-play`),
    seek: el<HTMLInputElement>(`#${kind}-ref-seek`),
    time: el<HTMLElement>(`#${kind}-ref-time`),
    canvas: el<HTMLCanvasElement>(`#${kind}-ref-waveform`),
    raf: null,
  };
  player.audio.preload = "metadata";
  player.play.addEventListener("click", async () => {
    if (!player.audio.src) return;
    if (player.audio.paused) {
      pauseOtherAudio(kind);
      try {
        await player.audio.play();
        startRefLoop(kind);
      } catch {
        stopRefLoop(kind);
        updateRefPlayback(kind);
        showToast("Could not play that audio file", "warning");
      }
    } else {
      player.audio.pause();
      stopRefLoop(kind);
      updateRefPlayback(kind);
    }
  });
  player.seek.addEventListener("input", () => {
    const duration = player.audio.duration || 0;
    if (duration > 0) {
      player.audio.currentTime = (parseInt(player.seek.value, 10) / 1000) * duration;
      updateRefPlayback(kind);
    }
  });
  player.audio.addEventListener("loadedmetadata", () => updateRefPlayback(kind));
  player.audio.addEventListener("timeupdate", () => updateRefPlayback(kind));
  player.audio.addEventListener("ended", () => {
    stopRefLoop(kind);
    updateRefPlayback(kind);
  });
  refPlayers[kind] = player;
  drawRefPreview(kind);
}

function showRefPreview(kind: RefPreviewKind, path: string): void {
  const preview = el<HTMLElement>(`#${kind}-ref-preview`);
  const player = refPlayers[kind];
  if (!player) return;
  preview.classList.remove("hidden");
  player.audio.pause();
  stopRefLoop(kind);
  player.audio.src = convertFileSrc(path);
  player.audio.load();
  player.seek.value = "0";
  updateRefPlayback(kind);
}

function hideRefPreview(kind: RefPreviewKind): void {
  const player = refPlayers[kind];
  if (player) {
    player.audio.pause();
    stopRefLoop(kind);
    player.audio.removeAttribute("src");
    player.audio.load();
    player.seek.value = "0";
    updateRefPlayback(kind);
  }
  el<HTMLElement>(`#${kind}-ref-preview`).classList.add("hidden");
}

function initDropzones(): void {
  initRefPlayer("clone");
  initRefPlayer("finish");

  const clearClone = () => {
    cloneRefPath = null;
    clearDropzone("#clone-dropzone");
    hideRefPreview("clone");
  };
  const clearFinish = () => {
    finishRefPath = null;
    clearDropzone("#finish-dropzone");
    hideRefPreview("finish");
  };

  setupDropzone("#clone-dropzone", (path, name) => {
    cloneRefPath = path;
    setDropzoneFile("#clone-dropzone", name);
    showRefPreview("clone", path);
  }, clearClone);
  setupDropzone("#finish-dropzone", (path, name) => {
    finishRefPath = path;
    setDropzoneFile("#finish-dropzone", name);
    showRefPreview("finish", path);
  }, clearFinish);
}

// ═══════════════════════════════════════════════════════════════════════════
// Auto-transcribe
// ═══════════════════════════════════════════════════════════════════════════

async function doAutoTranscribe(refPath: string | null, textareaId: string): Promise<void> {
  if (!refPath) {
    showToast("Drop an audio file first", "warning");
    return;
  }
  const btn = refPath === cloneRefPath
    ? el<HTMLButtonElement>("#auto-transcribe-btn")
    : el<HTMLButtonElement>("#finish-auto-transcribe-btn");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("transcribing");
  try {
    const text = await transcribeAudioText(refPath);
    if (text === null) return;
    const textarea = el<HTMLTextAreaElement>(textareaId);
    textarea.value = text;
    textarea.classList.add("flash");
    setTimeout(() => textarea.classList.remove("flash"), 1000);
  } catch (e) {
    showToast(`Transcription failed: ${e}`, "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove("transcribing");
  }
}

async function transcribeAudioText(refPath: string): Promise<string | null> {
  const whisperModelPath = localStorage.getItem("higgsAudio.whisperModel") || "";
  if (!whisperModelPath) {
    showToast("Select a whisper model in Settings first", "warning");
    return null;
  }
  const result = await invoke<{ text: string }>("transcribe_audio", {
    audioPath: refPath,
    whisperModelPath,
    language: null,
  });
  return result.text;
}

async function tryAutoTranscribeSilently(refPath: string): Promise<string> {
  const whisperModelPath = localStorage.getItem("higgsAudio.whisperModel") || "";
  if (!whisperModelPath) return "";
  try {
    const result = await invoke<{ text: string }>("transcribe_audio", {
      audioPath: refPath,
      whisperModelPath,
      language: null,
    });
    return result.text.trim();
  } catch {
    return "";
  }
}

async function pickAudioFile(): Promise<{ path: string; name: string } | null> {
  const selected = await open({
    filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "m4a", "ogg", "webm"] }],
  });
  if (!selected) return null;
  const path = Array.isArray(selected) ? selected[0] : selected;
  return { path, name: path.split(/[/\\]/).pop() || path };
}

function createSpeaker(name?: string): MultiSpeaker {
  const count = multiSpeakers.length + 1;
  return {
    id: nextId("speaker"),
    name: name || `Speaker ${count}`,
    refPath: null,
    refName: "",
    refText: "",
    open: true,
  };
}

function createLine(speakerId?: string): MultiLine {
  return {
    id: nextId("line"),
    speakerId: speakerId || multiSpeakers[0]?.id || "",
    text: "",
    overridePath: null,
    overrideName: "",
    overrideText: "",
    open: false,
  };
}

function ensureMultiDefaults(): void {
  while (multiSpeakers.length < 2) {
    multiSpeakers.push(createSpeaker());
  }
  while (multiLines.length < 2) {
    multiLines.push(createLine(multiSpeakers[multiLines.length]?.id || multiSpeakers[0]?.id));
  }
  const fallbackSpeaker = multiSpeakers[0]?.id || "";
  for (const line of multiLines) {
    if (!multiSpeakers.some((speaker) => speaker.id === line.speakerId)) {
      line.speakerId = fallbackSpeaker;
    }
  }
}

function multiDropzoneMarkup(fileName: string, emptyText: string): string {
  if (fileName) {
    return `
      <div class="dropzone-file">
        <span class="dropzone-file-icon">🎵</span>
        <span class="dropzone-file-name">${escapeHtml(fileName)}</span>
        <button class="dropzone-remove" type="button" data-action="clear-audio" aria-label="Remove audio">✕</button>
        <span class="dropzone-hint">Drop another audio file to replace it</span>
      </div>`;
  }
  return `
    <div class="dropzone-empty">
      <p>⤒ ${emptyText}</p>
      <p class="dropzone-hint">mp3 · wav · flac · m4a</p>
    </div>`;
}

function speakerOptions(selectedId: string): string {
  return multiSpeakers
    .map((speaker) => `<option value="${speaker.id}" ${speaker.id === selectedId ? "selected" : ""}>${escapeHtml(speaker.name)}</option>`)
    .join("");
}

function renderMultiSpeakers(): void {
  ensureMultiDefaults();
  const list = el<HTMLElement>("#speaker-library");
  list.innerHTML = "";
  for (const speaker of multiSpeakers) {
    const card = document.createElement("article");
    card.className = "speaker-card";
    card.dataset.speakerId = speaker.id;
    card.innerHTML = `
      <div class="speaker-card-head">
        <input class="text-input speaker-name-input" data-field="speaker-name" value="${escapeHtml(speaker.name)}" />
        <button class="compact-button" data-action="auto-speaker" type="button">✦ Auto-transcribe</button>
        <button class="icon-button speaker-toggle" data-action="toggle-speaker" type="button" aria-label="${speaker.open ? "Collapse speaker" : "Expand speaker"}">${speaker.open ? "▴" : "▾"}</button>
        <button class="compact-button" data-action="remove-speaker" type="button" ${multiSpeakers.length <= 2 ? "disabled" : ""}>−</button>
      </div>
      <div class="speaker-card-body ${speaker.open ? "" : "hidden"}">
        <div class="dropzone mini-dropzone ${speaker.refName ? "has-file" : ""}" data-action="pick-speaker-audio">
          ${multiDropzoneMarkup(speaker.refName, "Drop reference voice, or click to browse")}
        </div>
        <label class="field-label transcript-label">Reference transcript</label>
        <textarea class="text-area" data-field="speaker-transcript" rows="2" placeholder="Optional. Auto-filled with Whisper when available.">${escapeHtml(speaker.refText)}</textarea>
      </div>`;
    list.appendChild(card);
  }
}

function renderMultiLines(): void {
  ensureMultiDefaults();
  const list = el<HTMLElement>("#multi-lines");
  list.innerHTML = "";
  multiLines.forEach((line, index) => {
    const item = document.createElement("article");
    item.className = "dialogue-line";
    item.dataset.lineId = line.id;
    item.innerHTML = `
      <div class="line-main">
        <span class="line-grip" role="button" tabindex="0" aria-label="Drag line">⋮⋮</span>
        <span class="line-number">${index + 1}</span>
        <select class="select-input speaker-select" data-field="line-speaker">${speakerOptions(line.speakerId)}</select>
        <button class="compact-button" data-action="toggle-line-ref" type="button">${line.open ? "Hide reference" : "Reference"}</button>
        <button class="compact-button" data-action="remove-line" type="button" ${multiLines.length <= 2 ? "disabled" : ""}>−</button>
      </div>
      <textarea class="text-area line-text" data-field="line-text" rows="3" placeholder="Text to speak for this line...">${escapeHtml(line.text)}</textarea>
      <div class="line-reference ${line.open ? "" : "hidden"}">
        <div class="dropzone mini-dropzone ${line.overrideName ? "has-file" : ""}" data-action="pick-line-audio">
          ${multiDropzoneMarkup(line.overrideName, "Optional line-specific reference voice")}
        </div>
        <div class="label-row">
          <label class="field-label">Reference transcript override</label>
          <button class="link-button" data-action="auto-line" type="button">✦ Auto-transcribe</button>
        </div>
        <textarea class="text-area" data-field="line-transcript" rows="2" placeholder="Leave blank to use the selected speaker transcript.">${escapeHtml(line.overrideText)}</textarea>
      </div>`;
    list.appendChild(item);
  });
}

function renderMultiWorkflow(): void {
  renderMultiSpeakers();
  renderMultiLines();
}

function updateSpeakerTagsFromInput(): void {
  const names = el<HTMLInputElement>("#speaker-tags-input").value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  while (names.length < 2) names.push(`Speaker ${names.length + 1}`);
  while (multiSpeakers.length < names.length) multiSpeakers.push(createSpeaker());
  while (multiSpeakers.length > Math.max(2, names.length)) {
    const removed = multiSpeakers.pop();
    if (removed) {
      for (const line of multiLines) {
        if (line.speakerId === removed.id) line.speakerId = multiSpeakers[0]?.id || "";
      }
    }
  }
  names.forEach((name, index) => {
    multiSpeakers[index].name = name;
  });
  renderMultiWorkflow();
}

function speakerFromElement(target: HTMLElement): MultiSpeaker | undefined {
  const card = target.closest<HTMLElement>("[data-speaker-id]");
  return card ? multiSpeakers.find((speaker) => speaker.id === card.dataset.speakerId) : undefined;
}

function lineFromElement(target: HTMLElement): MultiLine | undefined {
  const lineEl = target.closest<HTMLElement>("[data-line-id]");
  return lineEl ? multiLines.find((line) => line.id === lineEl.dataset.lineId) : undefined;
}

function clearLineDragStyles(lineList = el<HTMLElement>("#multi-lines")): void {
  for (const item of lineList.querySelectorAll(".dialogue-line")) {
    item.classList.remove("dragging", "drag-target");
  }
}

function lineElementFromPoint(clientX: number, clientY: number): HTMLElement | null {
  return (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest<HTMLElement>(".dialogue-line") ?? null;
}

function scrollMultiModeDuringDrag(clientY: number): void {
  const mode = el<HTMLElement>("#mode-multi");
  const rect = mode.getBoundingClientRect();
  const edge = 42;
  if (clientY < rect.top + edge) mode.scrollTop -= 18;
  else if (clientY > rect.bottom - edge) mode.scrollTop += 18;
}

async function setSpeakerAudioFromDrop(speaker: MultiSpeaker, files: FileList | null): Promise<void> {
  const file = files?.[0];
  if (!file) return;
  speaker.refPath = (file as any).path || file.name;
  speaker.refName = file.name;
  renderMultiSpeakers();
}

async function setLineAudioFromDrop(line: MultiLine, files: FileList | null): Promise<void> {
  const file = files?.[0];
  if (!file) return;
  line.overridePath = (file as any).path || file.name;
  line.overrideName = file.name;
  renderMultiLines();
}

function reorderMultiLine(targetLineId: string, clientY: number): void {
  if (!draggedLineId || draggedLineId === targetLineId) return;
  const from = multiLines.findIndex((line) => line.id === draggedLineId);
  const to = multiLines.findIndex((line) => line.id === targetLineId);
  if (from < 0 || to < 0) return;
  const targetEl = document.querySelector<HTMLElement>(`[data-line-id="${targetLineId}"]`);
  const rect = targetEl?.getBoundingClientRect();
  const insertAfter = rect ? clientY > rect.top + rect.height / 2 : false;
  const [line] = multiLines.splice(from, 1);
  let nextIndex = to;
  if (from < to) nextIndex -= 1;
  if (insertAfter) nextIndex += 1;
  multiLines.splice(Math.max(0, Math.min(multiLines.length, nextIndex)), 0, line);
  renderMultiLines();
}

function moveDraggedLineToEnd(): void {
  if (!draggedLineId) return;
  const from = multiLines.findIndex((line) => line.id === draggedLineId);
  if (from < 0 || from === multiLines.length - 1) return;
  const [line] = multiLines.splice(from, 1);
  multiLines.push(line);
  renderMultiLines();
}

function initMultiSpeakerWorkflow(): void {
  ensureMultiDefaults();
  renderMultiWorkflow();

  el("#apply-speaker-tags").addEventListener("click", updateSpeakerTagsFromInput);
  el("#add-speaker-btn").addEventListener("click", () => {
    multiSpeakers.push(createSpeaker());
    renderMultiWorkflow();
  });
  el("#add-line-btn").addEventListener("click", () => {
    multiLines.push(createLine(multiSpeakers[0]?.id));
    renderMultiLines();
  });

  const speakerList = el<HTMLElement>("#speaker-library");
  speakerList.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    const speaker = speakerFromElement(target);
    if (!speaker) return;
    if ((target as HTMLInputElement).dataset.field === "speaker-name") {
      speaker.name = (target as HTMLInputElement).value || "Speaker";
      renderMultiLines();
    } else if ((target as HTMLTextAreaElement).dataset.field === "speaker-transcript") {
      speaker.refText = (target as HTMLTextAreaElement).value;
    }
  });
  speakerList.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const action = target.dataset.action || target.closest<HTMLElement>("[data-action]")?.dataset.action;
    const speaker = speakerFromElement(target);
    if (!speaker || !action) return;
    if (action === "toggle-speaker") {
      speaker.open = !speaker.open;
      renderMultiSpeakers();
    } else if (action === "remove-speaker" && multiSpeakers.length > 2) {
      const idx = multiSpeakers.findIndex((item) => item.id === speaker.id);
      multiSpeakers.splice(idx, 1);
      for (const line of multiLines) {
        if (line.speakerId === speaker.id) line.speakerId = multiSpeakers[0]?.id || "";
      }
      renderMultiWorkflow();
    } else if (action === "pick-speaker-audio") {
      const file = await pickAudioFile();
      if (file) {
        speaker.refPath = file.path;
        speaker.refName = file.name;
        renderMultiSpeakers();
      }
    } else if (action === "clear-audio") {
      speaker.refPath = null;
      speaker.refName = "";
      renderMultiSpeakers();
    } else if (action === "auto-speaker") {
      if (!speaker.refPath) {
        showToast("Drop a reference voice first", "warning");
        return;
      }
      target.classList.add("transcribing");
      const text = await transcribeAudioText(speaker.refPath);
      target.classList.remove("transcribing");
      if (text !== null) {
        speaker.refText = text;
        renderMultiSpeakers();
      }
    }
  });
  speakerList.addEventListener("dragover", (event) => {
    const dz = (event.target as HTMLElement).closest<HTMLElement>(".dropzone");
    if (!dz) return;
    event.preventDefault();
    dz.classList.add("drag-over");
  });
  speakerList.addEventListener("dragleave", (event) => {
    (event.target as HTMLElement).closest<HTMLElement>(".dropzone")?.classList.remove("drag-over");
  });
  speakerList.addEventListener("drop", async (event) => {
    const target = event.target as HTMLElement;
    const dz = target.closest<HTMLElement>(".dropzone");
    const speaker = speakerFromElement(target);
    if (!dz || !speaker) return;
    event.preventDefault();
    dz.classList.remove("drag-over");
    await setSpeakerAudioFromDrop(speaker, event.dataTransfer?.files || null);
  });

  const lineList = el<HTMLElement>("#multi-lines");
  lineList.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const line = lineFromElement(target);
    if (!line) return;
    if (target.dataset.field === "line-text") line.text = target.value;
    else if (target.dataset.field === "line-transcript") line.overrideText = target.value;
    else if (target.dataset.field === "line-speaker") line.speakerId = target.value;
  });
  lineList.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    const line = lineFromElement(target);
    if (line && target.dataset.field === "line-speaker") line.speakerId = target.value;
  });
  lineList.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const action = target.dataset.action || target.closest<HTMLElement>("[data-action]")?.dataset.action;
    const line = lineFromElement(target);
    if (!line || !action) return;
    if (action === "toggle-line-ref") {
      line.open = !line.open;
      renderMultiLines();
    } else if (action === "remove-line" && multiLines.length > 2) {
      const idx = multiLines.findIndex((item) => item.id === line.id);
      multiLines.splice(idx, 1);
      renderMultiLines();
    } else if (action === "pick-line-audio") {
      const file = await pickAudioFile();
      if (file) {
        line.overridePath = file.path;
        line.overrideName = file.name;
        renderMultiLines();
      }
    } else if (action === "clear-audio") {
      line.overridePath = null;
      line.overrideName = "";
      renderMultiLines();
    } else if (action === "auto-line") {
      const path = line.overridePath || multiSpeakers.find((speaker) => speaker.id === line.speakerId)?.refPath;
      if (!path) {
        showToast("Drop a reference voice first", "warning");
        return;
      }
      target.classList.add("transcribing");
      const text = await transcribeAudioText(path);
      target.classList.remove("transcribing");
      if (text !== null) {
        line.overrideText = text;
        line.open = true;
        renderMultiLines();
      }
    }
  });
  lineList.addEventListener("pointerdown", (event) => {
    const grip = (event.target as HTMLElement).closest<HTMLElement>(".line-grip");
    const line = grip ? lineFromElement(grip) : undefined;
    if (!grip || !line || event.button !== 0) return;
    event.preventDefault();
    linePointerDrag = { id: line.id, pointerId: event.pointerId, grip, active: false };
    draggedLineId = line.id;
    grip.setPointerCapture(event.pointerId);
    grip.closest(".dialogue-line")?.classList.add("dragging");
  });
  const handleLinePointerMove = (event: PointerEvent) => {
    if (!linePointerDrag || linePointerDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    linePointerDrag.active = true;
    scrollMultiModeDuringDrag(event.clientY);
    const item = lineElementFromPoint(event.clientX, event.clientY);
    clearLineDragStyles(lineList);
    lineList.querySelector<HTMLElement>(`[data-line-id="${linePointerDrag.id}"]`)?.classList.add("dragging");
    if (item?.dataset.lineId && item.dataset.lineId !== linePointerDrag.id) item.classList.add("drag-target");
  };
  const finishLinePointerDrag = (event: PointerEvent) => {
    if (!linePointerDrag || linePointerDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const activeDrag = linePointerDrag;
    const item = lineElementFromPoint(event.clientX, event.clientY);
    const listRect = lineList.getBoundingClientRect();
    const inList =
      event.clientX >= listRect.left &&
      event.clientX <= listRect.right &&
      event.clientY >= listRect.top &&
      event.clientY <= listRect.bottom;
    if (activeDrag.active) {
      if (item?.dataset.lineId && item.dataset.lineId !== activeDrag.id) reorderMultiLine(item.dataset.lineId, event.clientY);
      else if (!item && inList) moveDraggedLineToEnd();
    }
    try {
      activeDrag.grip.releasePointerCapture(activeDrag.pointerId);
    } catch {
      // Pointer capture may already be released if the browser cancels the gesture.
    }
    linePointerDrag = null;
    draggedLineId = null;
    clearLineDragStyles(lineList);
  };
  window.addEventListener("pointermove", handleLinePointerMove);
  window.addEventListener("pointerup", finishLinePointerDrag);
  window.addEventListener("pointercancel", finishLinePointerDrag);
  lineList.addEventListener("dragstart", (event) => {
    const grip = (event.target as HTMLElement).closest<HTMLElement>(".line-grip");
    const line = grip ? lineFromElement(grip) : undefined;
    if (!line || !grip) {
      event.preventDefault();
      return;
    }
    draggedLineId = line.id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", line.id);
      event.dataTransfer.setDragImage(grip, 10, 10);
    }
    grip.closest(".dialogue-line")?.classList.add("dragging");
  });
  lineList.addEventListener("dragover", (event) => {
    if (!draggedLineId || (event.target as HTMLElement).closest(".line-reference .dropzone")) return;
    const item = (event.target as HTMLElement).closest<HTMLElement>(".dialogue-line");
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    clearLineDragStyles(lineList);
    lineList.querySelector<HTMLElement>(`[data-line-id="${draggedLineId}"]`)?.classList.add("dragging");
    item?.classList.add("drag-target");
  });
  lineList.addEventListener("dragleave", (event) => {
    (event.target as HTMLElement).closest<HTMLElement>(".dialogue-line")?.classList.remove("drag-target");
  });
  lineList.addEventListener("drop", (event) => {
    if (!draggedLineId || (event.target as HTMLElement).closest(".line-reference .dropzone")) return;
    const item = (event.target as HTMLElement).closest<HTMLElement>(".dialogue-line");
    event.preventDefault();
    event.stopPropagation();
    if (item?.dataset.lineId) reorderMultiLine(item.dataset.lineId, event.clientY);
    else moveDraggedLineToEnd();
  });
  lineList.addEventListener("dragend", () => {
    draggedLineId = null;
    clearLineDragStyles(lineList);
  });
  lineList.addEventListener("dragover", (event) => {
    if (draggedLineId) return;
    const dz = (event.target as HTMLElement).closest<HTMLElement>(".line-reference .dropzone");
    if (!dz) return;
    event.preventDefault();
    dz.classList.add("drag-over");
  });
  lineList.addEventListener("drop", async (event) => {
    if (draggedLineId) return;
    const target = event.target as HTMLElement;
    const dz = target.closest<HTMLElement>(".line-reference .dropzone");
    const line = lineFromElement(target);
    if (!dz || !line) return;
    event.preventDefault();
    dz.classList.remove("drag-over");
    await setLineAudioFromDrop(line, event.dataTransfer?.files || null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Advanced options
// ═══════════════════════════════════════════════════════════════════════════

function initAdvancedOptions(): void {
  const sliders: [string, string, (v: number) => string][] = [
    ["#opt-temperature", "#val-temperature", (v) => v.toFixed(2)],
    ["#opt-top-k", "#val-top-k", (v) => String(Math.round(v))],
    ["#opt-top-p", "#val-top-p", (v) => v.toFixed(2)],
    ["#opt-pause", "#val-pause", (v) => v.toFixed(2)],
    ["#opt-speaker-pause", "#val-speaker-pause", (v) => v.toFixed(2)],
  ];
  for (const [inputId, valueId, fmt] of sliders) {
    const input = el<HTMLInputElement>(inputId);
    const update = () => setText(valueId, fmt(parseFloat(input.value)));
    input.addEventListener("input", update);
    update();
  }

  // Longform chunking toggle — show/hide chunk size + pause fields
  const chunkToggle = el<HTMLInputElement>("#opt-chunk-enabled");
  const updateChunkFields = () => {
    const enabled = chunkToggle.checked;
    el<HTMLInputElement>("#opt-chunk-size").disabled = !enabled;
    el<HTMLInputElement>("#opt-pause").disabled = !enabled;
    el<HTMLElement>("#chunk-size-row").classList.toggle("disabled-row", !enabled);
    el<HTMLElement>("#pause-row").classList.toggle("disabled-row", !enabled);
    el<HTMLElement>("#val-pause").style.opacity = enabled ? "1" : "0.4";
  };
  chunkToggle.addEventListener("change", updateChunkFields);
  updateChunkFields();

  el("#seed-randomize").addEventListener("click", () => {
    el<HTMLInputElement>("#opt-seed").value = String(Math.floor(Math.random() * 2147483647));
  });
}

function gatherOptions(): Record<string, number | string | boolean> {
  const temp = parseFloat(el<HTMLInputElement>("#opt-temperature").value);
  const topK = parseInt(el<HTMLInputElement>("#opt-top-k").value, 10);
  const topP = parseFloat(el<HTMLInputElement>("#opt-top-p").value);
  let seed = parseInt(el<HTMLInputElement>("#opt-seed").value, 10);
  const seedMode = el<HTMLSelectElement>("#opt-seed-mode").value;
  const maxTokens = parseInt(el<HTMLInputElement>("#opt-max-tokens").value, 10);
  const chunkEnabled = el<HTMLInputElement>("#opt-chunk-enabled").checked;
  const chunkSize = parseInt(el<HTMLInputElement>("#opt-chunk-size").value, 10);
  const pause = parseFloat(el<HTMLInputElement>("#opt-pause").value);
  const speakerPause = parseFloat(el<HTMLInputElement>("#opt-speaker-pause").value);

  // Apply seed mode
  if (seedMode === "random") {
    seed = Math.floor(Math.random() * 2147483647);
    el<HTMLInputElement>("#opt-seed").value = String(seed);
  }

  const opts: Record<string, number | string | boolean> = {
    temperature: temp,
    top_k: topK,
    top_p: topP,
    seed,
    max_tokens: maxTokens,
  };

  if (chunkEnabled) {
    opts.text_chunk_size = chunkSize;
    opts.pause_between_chunks = pause;
  }

  if (currentMode === "multi") {
    opts.pause_between_speakers = speakerPause;
  }

  return opts;
}

function deliveryControlPrefix(): string {
  const emotion = el<HTMLSelectElement>("#opt-emotion").value;
  const style = el<HTMLSelectElement>("#opt-style").value;
  const speed = el<HTMLSelectElement>("#opt-speed").value;
  const pitch = el<HTMLSelectElement>("#opt-pitch").value;
  const expressive = el<HTMLSelectElement>("#opt-expressive").value;
  const parts: string[] = [];
  if (emotion) parts.push(`<|emotion:${emotion}|>`);
  if (style) parts.push(`<|style:${style}|>`);
  for (const prosody of [speed, pitch, expressive]) {
    if (prosody) parts.push(`<|prosody:${prosody}|>`);
  }
  return parts.join("");
}

function applyDeliveryControls(text: string): string {
  return `${deliveryControlPrefix()}${text}`;
}

function advanceSeedAfterGeneration(): void {
  const seedMode = el<HTMLSelectElement>("#opt-seed-mode").value;
  const seedEl = el<HTMLInputElement>("#opt-seed");
  const cur = parseInt(seedEl.value, 10) || 0;
  if (seedMode === "increment") {
    seedEl.value = String(cur + 1);
  } else if (seedMode === "decrement") {
    seedEl.value = String(cur - 1);
  } else if (seedMode === "random") {
    seedEl.value = String(Math.floor(Math.random() * 2147483647));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Generate / Cancel
// ═══════════════════════════════════════════════════════════════════════════

function renderGenerationSteps(labels: string[], activeIndex = 0, completedThrough = -1): void {
  currentProgressLabels = labels;
  const steps = el<HTMLElement>("#gen-progress-steps");
  steps.innerHTML = "";
  labels.forEach((label, index) => {
    const item = document.createElement("span");
    item.className = "progress-step";
    if (index <= completedThrough) item.classList.add("complete");
    if (index === activeIndex) item.classList.add("active");
    item.textContent = label;
    steps.appendChild(item);
  });
}

function updateGenerationStep(activeIndex: number, completedThrough = activeIndex - 1): void {
  if (currentProgressLabels.length === 0) return;
  renderGenerationSteps(currentProgressLabels, activeIndex, completedThrough);
}

function beginGeneration(): void {
  isGenerating = true;
  genStartedAt = performance.now();
  el<HTMLButtonElement>("#generate-btn").classList.add("hidden");
  el<HTMLButtonElement>("#cancel-btn").classList.remove("hidden");
  el<HTMLElement>("#progress-section").classList.remove("hidden");
  el<HTMLElement>("#output-section").classList.add("hidden");
  const bar = el<HTMLElement>("#gen-progress-bar");
  bar.classList.add("indeterminate");
  bar.style.width = "";
  renderGenerationSteps(["Prepare", "Generate", "Process", "Output"], 0);
  setText("#gen-progress-text", "Starting generation…");
  genTimer = window.setInterval(() => {
    const elapsed = ((performance.now() - genStartedAt) / 1000).toFixed(1);
    setText("#gen-progress-text", `Generating | ${elapsed}s elapsed`);
  }, 250);
}

function finishGeneration(success: boolean, message: string): void {
  isGenerating = false;
  if (genTimer) {
    clearInterval(genTimer);
    genTimer = null;
  }
  el<HTMLButtonElement>("#generate-btn").classList.remove("hidden");
  el<HTMLButtonElement>("#cancel-btn").classList.add("hidden");
  const bar = el<HTMLElement>("#gen-progress-bar");
  bar.classList.remove("indeterminate");
  if (success) {
    setProgress("#gen-progress-bar", 1, 1);
    const labels = currentProgressLabels.length ? currentProgressLabels : ["Prepare", "Generate", "Process", "Output"];
    renderGenerationSteps(labels, labels.length - 1, labels.length - 1);
    setText("#gen-progress-text", "Complete");
    setTimeout(() => el<HTMLElement>("#progress-section").classList.add("hidden"), 1000);
  } else {
    el<HTMLElement>("#progress-section").classList.add("hidden");
  }
  if (message) showToast(message, success ? "success" : "error");
}

async function resolveMultiLineReference(line: MultiLine): Promise<{ refPath: string; refText?: string; speakerName: string }> {
  const speaker = multiSpeakers.find((item) => item.id === line.speakerId);
  const refPath = line.overridePath || speaker?.refPath || "";
  if (!refPath) {
    throw new Error(`Line ${multiLines.indexOf(line) + 1} needs a reference voice`);
  }

  let refText = (line.overrideText || speaker?.refText || "").trim();
  if (!refText) {
    const text = await tryAutoTranscribeSilently(refPath);
    if (text) {
      refText = text;
      if (line.overridePath) line.overrideText = text;
      else if (speaker) speaker.refText = text;
    }
  }

  return {
    refPath,
    refText: refText || undefined,
    speakerName: speaker?.name || "Speaker",
  };
}

async function generateMultiSpeaker(options: Record<string, number | string | boolean>): Promise<GenerationResult> {
  ensureMultiDefaults();
  const lines = multiLines;
  const speakerPause = typeof options.pause_between_speakers === "number" ? options.pause_between_speakers : 0.15;
  const lineOptions = { ...options };
  delete lineOptions.pause_between_speakers;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].text.trim()) {
      throw new Error(`Line ${i + 1} needs text`);
    }
  }

  const labels = lines.map((line, index) => {
    const speaker = multiSpeakers.find((item) => item.id === line.speakerId);
    return `${index + 1}. ${speaker?.name || "Speaker"}`;
  });
  renderGenerationSteps(labels, 0);

  const outputs: GenerationResult[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    updateGenerationStep(i, i - 1);
    setProgress("#gen-progress-bar", i, lines.length);
    const resolved = await resolveMultiLineReference(line);
    setText("#gen-progress-text", `Line ${i + 1}/${lines.length}: ${resolved.speakerName}`);
    const result = await invoke<GenerationResult>("generate_voice_clone", {
      request: {
        text: applyDeliveryControls(line.text.trim()),
        refAudioPath: resolved.refPath,
        refText: resolved.refText,
        options: lineOptions,
      },
    });
    outputs.push(result);
    setProgress("#gen-progress-bar", i + 1, lines.length);
  }
  renderMultiWorkflow();
  return concatenateWavResults(outputs, speakerPause);
}

async function doGenerate(): Promise<void> {
  if (isGenerating) return;

  const options = gatherOptions();
  let result: GenerationResult;

  try {
    beginGeneration();

    if (currentMode === "tts") {
      const text = el<HTMLTextAreaElement>("#tts-text").value.trim();
      if (!text) {
        finishGeneration(false, "Please enter text to speak");
        return;
      }
      result = await invoke<GenerationResult>("generate_tts", {
        request: { text: applyDeliveryControls(text), options },
      });
    } else if (currentMode === "clone") {
      const text = el<HTMLTextAreaElement>("#clone-text").value.trim();
      if (!text) {
        finishGeneration(false, "Please enter text to speak");
        return;
      }
      if (!cloneRefPath) {
        finishGeneration(false, "Please provide a reference voice");
        return;
      }
      const refText = el<HTMLTextAreaElement>("#clone-ref-text").value.trim() || undefined;
      result = await invoke<GenerationResult>("generate_voice_clone", {
        request: { text: applyDeliveryControls(text), refAudioPath: cloneRefPath, refText, options },
      });
    } else if (currentMode === "finish") {
      if (!finishRefPath) {
        finishGeneration(false, "Please provide audio to continue");
        return;
      }
      const text = el<HTMLTextAreaElement>("#finish-text").value.trim();
      if (!text) {
        finishGeneration(false, "Continuation text is required");
        return;
      }
      const transcript = el<HTMLTextAreaElement>("#finish-transcript").value.trim();
      const opts = { ...options, reference_text: transcript };
      result = await invoke<GenerationResult>("generate_finish_sentence", {
        request: { audioPath: finishRefPath, continuationText: applyDeliveryControls(text), options: opts },
      });
      if (el<HTMLInputElement>("#finish-include-source").checked) {
        updateGenerationStep(2, 1);
        setText("#gen-progress-text", "Combining source audio and continuation");
        const source = await invoke<GenerationResult>("read_audio_as_wav", {
          audioPath: finishRefPath,
          targetSampleRate: result.sampleRate,
        });
        result = concatenateWavResults([source, result]);
      }
    } else {
      result = await generateMultiSpeaker(options);
    }

    updateGenerationStep(2, 1);
    setText("#gen-progress-text", "Processing audio output");
    lastResult = result;
    showOutput(result);
    updateGenerationStep(3, 2);
    finishGeneration(true, "Generation complete");

    advanceSeedAfterGeneration();

    const label = currentMode === "tts"
      ? el<HTMLTextAreaElement>("#tts-text").value.slice(0, 40)
      : currentMode === "clone"
        ? el<HTMLTextAreaElement>("#clone-text").value.slice(0, 40)
        : currentMode === "finish"
          ? el<HTMLTextAreaElement>("#finish-text").value.slice(0, 40)
          : multiLines.map((line) => line.text.trim()).filter(Boolean).join(" / ").slice(0, 40);
    addHistory(currentMode, label || "Untitled", result);
  } catch (e) {
    finishGeneration(false, `Generation failed: ${e}`);
  }
}

async function doCancel(): Promise<void> {
  try {
    await invoke("cancel_generation");
    showToast("Cancelling…");
  } catch (e) {
    showToast(`Cancel failed: ${e}`, "error");
  }
}

function initGenerate(): void {
  el("#generate-btn").addEventListener("click", doGenerate);
  el("#cancel-btn").addEventListener("click", doCancel);
  el("#auto-transcribe-btn").addEventListener("click", () => doAutoTranscribe(cloneRefPath, "#clone-ref-text"));
  const finishTranscribe = document.querySelector<HTMLElement>("#finish-auto-transcribe-btn");
  if (finishTranscribe) finishTranscribe.addEventListener("click", () => doAutoTranscribe(finishRefPath, "#finish-transcript"));
  el("#history-clear-all").addEventListener("click", () => {
    history = [];
    renderHistory();
    showToast("History cleared");
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Audio output — waveform + playback
// ═══════════════════════════════════════════════════════════════════════════

function showOutput(result: GenerationResult): void {
  // Store for this mode
  outputByMode[currentMode] = result;
  lastResult = result;

  // Stop any current playback
  if (!audioPlayer.paused) audioPlayer.pause();
  el<HTMLButtonElement>("#play-btn").textContent = "▶";

  const blob = base64ToBlob(result.wavBase64, "audio/wav");
  const url = URL.createObjectURL(blob);
  audioPlayer.src = url;
  el<HTMLElement>("#output-section").classList.remove("hidden");

  const duration = result.sampleCount / result.sampleRate / result.channels;
  setText("#output-time", `00:00 / ${formatTime(duration)}`);

  audioPlayer.onloadedmetadata = () => {
    setText("#output-time", `00:00 / ${formatTime(audioPlayer.duration)}`);
  };
  audioPlayer.onended = () => {
    el<HTMLButtonElement>("#play-btn").textContent = "▶";
    if (waveRAF) { cancelAnimationFrame(waveRAF); waveRAF = null; }
    drawWaveform();
  };

  drawWaveformFromBase64(result.wavBase64);
}

let waveformSamples: Float32Array | null = null;
let waveRAF: number | null = null;

function startWaveLoop(): void {
  const tick = () => {
    setText("#output-time", `${formatTime(audioPlayer.currentTime)} / ${formatTime(audioPlayer.duration || 0)}`);
    drawWaveform();
    if (!audioPlayer.paused && !audioPlayer.ended) {
      waveRAF = requestAnimationFrame(tick);
    } else {
      waveRAF = null;
    }
  };
  if (waveRAF) cancelAnimationFrame(waveRAF);
  waveRAF = requestAnimationFrame(tick);
}

async function drawWaveformFromBase64(base64: string): Promise<void> {
  try {
    const bytes = atob(base64);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    const dv = new DataView(buf.buffer);
    const numChannels = dv.getUint16(22, true);
    const dataOffset = 44;
    const totalSamples = (buf.length - dataOffset) / 2 / numChannels;
    const samples = new Float32Array(Math.min(totalSamples, 48000 * 120));
    for (let i = 0; i < samples.length; i++) {
      const offset = dataOffset + i * numChannels * 2;
      if (offset + 1 >= buf.length) break;
      samples[i] = dv.getInt16(offset, true) / 32768.0;
    }
    waveformSamples = samples;
    drawWaveform();
  } catch {
    // ignore decode errors
  }
}

function drawWaveform(): void {
  const canvas = el<HTMLCanvasElement>("#waveform-canvas");
  if (!canvas || !waveformSamples) return;
  const ctx = canvas.getContext("2d")!;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.floor(width * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = cssVar("--bg-inner", "#0d1013");
  ctx.fillRect(0, 0, width, height);

  const accent = cssVar("--accent", "#25b8ab");
  const muted = cssVar("--text-muted", "#9ea8b3");
  const barGap = 2;
  const barMinW = 3;
  const barCount = Math.max(60, Math.min(300, Math.floor(width / (barMinW + barGap))));
  const barW = (width - barCount * barGap) / barCount;
  const step = Math.max(1, Math.floor(waveformSamples.length / barCount));
  const mid = height / 2;

  const progress = audioPlayer.duration > 0 ? audioPlayer.currentTime / audioPlayer.duration : 0;
  const playheadX = progress * width;

  for (let i = 0; i < barCount; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) {
      const idx = i * step + j;
      if (idx >= waveformSamples.length) break;
      sum += waveformSamples[idx] ** 2;
    }
    const rms = Math.sqrt(sum / step);
    const barH = Math.max(2, rms * height * 2.5);
    const x = i * (barW + barGap);
    ctx.fillStyle = x + barW / 2 <= playheadX ? accent : muted + "50";
    ctx.fillRect(x, mid - barH / 2, barW, barH);
  }

  // Playhead line
  if (progress > 0 && progress < 1) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
  }
}

function setSaveFormat(format: SaveFormat): void {
  selectedSaveFormat = format === "mp3" ? "mp3" : "wav";
  localStorage.setItem("higgsAudio.saveFormat", selectedSaveFormat);
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".save-format")) {
    const active = btn.dataset.format === selectedSaveFormat;
    btn.classList.toggle("active", active);
    btn.textContent = `${active ? "✓ " : ""}${(btn.dataset.format || "wav").toUpperCase()}`;
  }
}

function initAudioPlayer(): void {
  const playBtn = el<HTMLButtonElement>("#play-btn");

  playBtn.addEventListener("click", () => {
    if (audioPlayer.paused) {
      audioPlayer.play();
      playBtn.textContent = "⏸";
      startWaveLoop();
    } else {
      audioPlayer.pause();
      playBtn.textContent = "▶";
      if (waveRAF) { cancelAnimationFrame(waveRAF); waveRAF = null; }
      drawWaveform();
    }
  });

  // Click-to-seek on waveform
  const canvas = el<HTMLCanvasElement>("#waveform-canvas");
  canvas.style.cursor = "pointer";
  canvas.addEventListener("click", (e) => {
    if (!audioPlayer.duration) return;
    const rect = canvas.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audioPlayer.currentTime = pct * audioPlayer.duration;
    drawWaveform();
    if (!audioPlayer.paused) startWaveLoop();
  });

  setSaveFormat(selectedSaveFormat);
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".save-format")) {
    btn.addEventListener("click", () => setSaveFormat((btn.dataset.format as SaveFormat) || "wav"));
  }

  el("#download-output-btn").addEventListener("click", async () => {
    if (!lastResult) return;
    const format = selectedSaveFormat;
    try {
      const path = await save({
        defaultPath: `higgs_output_${Date.now()}.${format}`,
        filters: [
          format === "wav"
            ? { name: "WAV Audio", extensions: ["wav"] }
            : { name: "MP3 Audio", extensions: ["mp3"] },
        ],
      });
      if (path) {
        const base64Audio = format === "wav"
          ? lastResult.wavBase64
          : bytesToBase64(await encodeMp3FromWav(lastResult.wavBase64));
        await invoke("save_binary_file", { path, base64Data: base64Audio });
        showToast(`Saved ${format.toUpperCase()} file`);
      }
    } catch (e) {
      showToast(`Save failed: ${e}`, "error");
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Generation history
// ═══════════════════════════════════════════════════════════════════════════

function addHistory(mode: Mode, label: string, result: GenerationResult): void {
  const entry: HistoryEntry = {
    id: `gen_${Date.now()}`,
    mode,
    label,
    timestamp: Date.now(),
    wavBase64: result.wavBase64,
    sampleRate: result.sampleRate,
    channels: result.channels,
  };
  history.unshift(entry);
  if (history.length > 10) history.length = 10; // keep last 10
  renderHistory();
}

function renderHistory(): void {
  const list = el<HTMLElement>("#recent-list");
  if (history.length === 0) {
    list.innerHTML = '<p class="empty-state">No generations yet</p>';
    el<HTMLElement>("#history-clear-all").classList.add("hidden");
    return;
  }
  el<HTMLElement>("#history-clear-all").classList.remove("hidden");
  list.innerHTML = "";
  for (const entry of history) {
    const item = document.createElement("div");
    item.className = "recent-item";
    const time = new Date(entry.timestamp).toLocaleTimeString();
    item.innerHTML = `<span class="recent-mode">${entry.mode}</span><span class="recent-label">${entry.label}</span><span class="recent-time">${time}</span><button class="recent-delete" data-id="${entry.id}" title="Delete">✕</button>`;

    // Click on the item (not the delete button) plays it
    item.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains("recent-delete")) return;
      // Stop current playback
      if (!audioPlayer.paused) audioPlayer.pause();
      el<HTMLButtonElement>("#play-btn").textContent = "▶";
      // Load this entry
      const fakeResult: GenerationResult = {
        sampleRate: entry.sampleRate,
        channels: entry.channels,
        sampleCount: 0,
        wavBase64: entry.wavBase64,
      };
      // Switch to the entry's mode so it shows in the right tab
      switchMode(entry.mode as Mode);
      showOutput(fakeResult);
    });

    list.appendChild(item);
  }

  // Wire delete buttons
  for (const btn of list.querySelectorAll<HTMLButtonElement>(".recent-delete")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      history = history.filter((h) => h.id !== id);
      renderHistory();
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Download flow
// ═══════════════════════════════════════════════════════════════════════════

function modelDownloadTarget(url: string): { destDir: string; filename: string | null } {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/models\/([^/]+)\/([^/]+)$/);
    if (match) {
      return {
        destDir: `models/${decodeURIComponent(match[1])}`,
        filename: decodeURIComponent(match[2]),
      };
    }
  } catch {
    // The backend will report the invalid URL. Keep the fallback target simple.
  }
  return { destDir: "models", filename: null };
}

function initDownload(): void {
  const trigger = el("#download-trigger");
  const whisperTrigger = el("#whisper-download-trigger");
  const engineTrigger = el("#download-engine-btn");
  const popover = el<HTMLDivElement>("#download-popover");
  const urlInput = el<HTMLInputElement>("#download-url-input");
  const title = el<HTMLElement>("#download-title");
  const setOpen = (open: boolean, kind: DownloadKind = activeDownloadKind) => {
    const previousKind = activeDownloadKind;
    activeDownloadKind = kind;
    const whisperPreset = selectedWhisperPreset();
    title.textContent = kind === "whisper"
      ? "Download Whisper Model"
      : kind === "engine"
        ? "Download DLL Engine"
        : "Download Model";
    urlInput.placeholder = kind === "whisper"
      ? "Paste whisper.cpp ggml .bin URL…"
      : kind === "engine"
        ? "DLL engine URL…"
        : "Paste HuggingFace GGUF URL…";
    if (kind === "whisper") {
      urlInput.value = whisperPresetUrl(whisperPreset);
      urlInput.title = `${whisperPreset.id} (${whisperPreset.size})`;
    } else if (kind === "engine") {
      urlInput.value = ENGINE_DLL_URL;
      urlInput.title = "Downloads as audiocpp_engine.dll";
    } else {
      if (previousKind !== "model" || !urlInput.value.trim()) urlInput.value = HIGGS_RECOMMENDED_MODEL_URL;
      urlInput.title = "Recommended Higgs Audio v3 Q8_0 GGUF";
    }
    popover.hidden = !open;
  };
  trigger.addEventListener("click", (e) => { e.stopPropagation(); setOpen(popover.hidden, "model"); });
  whisperTrigger.addEventListener("click", (e) => { e.stopPropagation(); setOpen(popover.hidden, "whisper"); });
  engineTrigger.addEventListener("click", async (e) => {
    e.stopPropagation();
    setOpen(true, "engine");
    el<HTMLElement>("#download-progress-container").classList.remove("hidden");
    setProgress("#download-progress-bar", 0, 1);
    setText("#download-size-text", "0 / 0");
    setText("#download-speed-text", "0 MB/s");
    try {
      const result = await invoke<{ path: string; size: number }>("download_engine_dll", { url: ENGINE_DLL_URL });
      showToast(`DLL engine downloaded: ${result.path}`);
    } catch (err) {
      showToast(`Engine download failed: ${err}`, "error");
    }
  });
  const dlClose = document.querySelector<HTMLElement>("#download-close");
  if (dlClose) dlClose.addEventListener("click", (e) => { e.stopPropagation(); setOpen(false); });
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (!popover.hidden && !popover.contains(target) && !trigger.contains(target) && !whisperTrigger.contains(target) && !engineTrigger.contains(target)) {
      setOpen(false);
    }
  });

  el("#download-fetch-btn").addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) {
      showToast(activeDownloadKind === "whisper" ? "Enter a whisper.cpp model URL" : "Enter a HuggingFace URL", "warning");
      return;
    }
    const destDir = activeDownloadKind === "whisper" ? "models/whisper" : "models";
    el<HTMLElement>("#download-progress-container").classList.remove("hidden");
    setProgress("#download-progress-bar", 0, 1);
    try {
      if (activeDownloadKind === "engine") {
        const result = await invoke<{ path: string; size: number }>("download_engine_dll", { url });
        showToast(`DLL engine downloaded: ${result.path}`);
      } else if (activeDownloadKind === "whisper") {
        const result = await invoke<{ path: string; size: number }>("download_model", { request: { url, destDir, filename: null } });
        localStorage.setItem("higgsAudio.whisperPreset", selectedWhisperPreset().id);
        setWhisperModelPath(result.path);
        showToast("Whisper model downloaded");
      } else {
        const target = modelDownloadTarget(url);
        await invoke<{ path: string; size: number }>("download_model", {
          request: { url, destDir: target.destDir, filename: target.filename },
        });
        showToast("Download complete");
        await refreshModelList();
      }
    } catch (e) {
      showToast(`Download failed: ${e}`, "error");
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Hardware monitor (port from SAM3DBody)
// ═══════════════════════════════════════════════════════════════════════════

const hardwareCanvas = document.querySelector<HTMLCanvasElement>("#hardware-graph")!;
const hardwareCtx = hardwareCanvas.getContext("2d")!;

function setMeter(barId: string, textId: string, current: number, total: number, text: string): void {
  setProgress(barId, current, total || current || 1);
  setText(textId, text);
}

function updateHardware(snapshot: HardwareSnapshot): void {
  hardwareHistory.push(snapshot);
  if (hardwareHistory.length > hardwareHistoryLimit) hardwareHistory.shift();

  setText("#hardware-detail", `${snapshot.gpuName} | ${snapshot.temperature || "−"} C | app RAM ${formatBytes(snapshot.processRam)}`);

  setMeter("#hw-vram-bar", "#hw-vram-text",
    snapshot.usedVram, snapshot.totalVram,
    `${formatBytes(snapshot.usedVram)} / ${formatBytes(snapshot.totalVram)}`);

  setMeter("#hw-gpu-bar", "#hw-gpu-text",
    snapshot.gpuUtilization, 100,
    `${snapshot.gpuUtilization || 0}%`);

  setMeter("#hw-power-bar", "#hw-power-text",
    snapshot.powerDraw, snapshot.powerLimit,
    snapshot.powerLimit ? `${snapshot.powerDraw.toFixed(0)} / ${snapshot.powerLimit.toFixed(0)} W` : "−");

  setMeter("#hw-ram-bar", "#hw-ram-text",
    snapshot.usedRam, snapshot.totalRam,
    `${formatBytes(snapshot.usedRam)} / ${formatBytes(snapshot.totalRam)}`);

  drawHardwareGraph();
}

function drawHardwareGraph(): void {
  const rect = hardwareCanvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (hardwareCanvas.width !== Math.floor(width * dpr)) {
    hardwareCanvas.width = Math.floor(width * dpr);
    hardwareCanvas.height = Math.floor(height * dpr);
  }
  hardwareCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  hardwareCtx.clearRect(0, 0, width, height);
  hardwareCtx.fillStyle = cssVar("--bg-inner", "#0d1013");
  hardwareCtx.fillRect(0, 0, width, height);

  const labelWidth = 38;
  const plotX = labelWidth;
  const plotWidth = Math.max(1, width - labelWidth - 4);

  // Grid lines + labels
  hardwareCtx.font = "10px Inter, sans-serif";
  hardwareCtx.fillStyle = cssVar("--text-muted", "#9ea8b3");
  hardwareCtx.textAlign = "right";
  hardwareCtx.textBaseline = "middle";
  for (const [pct, label] of [[1, "100%"], [0.5, "50%"], [0, "0%"]] as const) {
    const y = Math.round(height - pct * height) + 0.5;
    hardwareCtx.fillText(label, labelWidth - 7, Math.max(8, Math.min(height - 8, y)));
  }
  hardwareCtx.strokeStyle = cssVar("--border", "#1f262d");
  hardwareCtx.lineWidth = 1;
  for (const pct of [0, 0.25, 0.5, 0.75, 1]) {
    const y = Math.round(height * pct) + 0.5;
    hardwareCtx.beginPath();
    hardwareCtx.moveTo(plotX, y);
    hardwareCtx.lineTo(width, y);
    hardwareCtx.stroke();
  }

  // Determine visible window based on viewOffset
  const totalLen = hardwareHistory.length;
  const visibleStart = hardwareFollowLive
    ? Math.max(0, totalLen - hardwareGraphPoints)
    : Math.max(0, Math.min(totalLen - hardwareGraphPoints, totalLen - hardwareGraphPoints - hardwareViewOffset));
  const visibleEnd = Math.min(totalLen, visibleStart + hardwareGraphPoints);

  drawHardwareLine(plotX, plotWidth, height, "#e0a12b", (s) => s.totalVram ? s.usedVram / s.totalVram : 0, visibleStart, visibleEnd);
  drawHardwareLine(plotX, plotWidth, height, "#25b8ab", (s) => s.gpuUtilization / 100, visibleStart, visibleEnd);
  drawHardwareLine(plotX, plotWidth, height, "#c56cf0", (s) => s.powerLimit ? s.powerDraw / s.powerLimit : 0, visibleStart, visibleEnd);
  drawHardwareLine(plotX, plotWidth, height, "#6aa6ff", (s) => s.totalRam ? s.usedRam / s.totalRam : 0, visibleStart, visibleEnd);

  // Hover crosshair
  if (hardwareHover && !hardwareScrubDrag) {
    const hoverIdx = visibleStart + hardwareHover.idx;
    if (hoverIdx >= 0 && hoverIdx < totalLen) {
      const x = plotX + (hardwareHover.idx / Math.max(1, hardwareGraphPoints - 1)) * plotWidth;
      hardwareCtx.strokeStyle = cssVar("--text-muted", "#9ea8b3");
      hardwareCtx.lineWidth = 1;
      hardwareCtx.setLineDash([3, 3]);
      hardwareCtx.beginPath();
      hardwareCtx.moveTo(x, 0);
      hardwareCtx.lineTo(x, height);
      hardwareCtx.stroke();
      hardwareCtx.setLineDash([]);

      // Dots at each line's value for the hovered sample
      const snap = hardwareHistory[hoverIdx];
      const drawDot = (color: string, val: number) => {
        const y = height - Math.min(1, Math.max(0, val)) * height;
        hardwareCtx.fillStyle = color;
        hardwareCtx.beginPath();
        hardwareCtx.arc(x, y, 3, 0, Math.PI * 2);
        hardwareCtx.fill();
      };
      drawDot("#e0a12b", snap.totalVram ? snap.usedVram / snap.totalVram : 0);
      drawDot("#25b8ab", snap.gpuUtilization / 100);
      drawDot("#c56cf0", snap.powerLimit ? snap.powerDraw / snap.powerLimit : 0);
      drawDot("#6aa6ff", snap.totalRam ? snap.usedRam / snap.totalRam : 0);

      // Tooltip text in the detail line
      setText("#hardware-detail",
        `${formatBytes(snap.usedVram)} VRAM · ${snap.gpuUtilization.toFixed(0)}% GPU · ${snap.powerDraw.toFixed(0)}W` +
        (hardwareFollowLive ? "" : "  ◀ scrubbed"));
    }
  } else if (!hardwareFollowLive) {
    setText("#hardware-detail", `◀ Scrubbed view — drag to navigate, release at right edge to resume live`);
  }
}

function drawHardwareLine(
  start: number, width: number, height: number, color: string,
  valueFor: (sample: HardwareSnapshot) => number,
  visStart: number, visEnd: number,
): void {
  const count = visEnd - visStart;
  if (count < 2) return;
  const step = width / Math.max(1, hardwareGraphPoints - 1);
  hardwareCtx.beginPath();
  hardwareCtx.strokeStyle = color;
  hardwareCtx.lineWidth = 1.8;
  for (let i = 0; i < count; i++) {
    const sample = hardwareHistory[visStart + i];
    const value = Math.min(1, Math.max(0, valueFor(sample)));
    const x = start + step * i;
    const y = height - value * height;
    if (i === 0) hardwareCtx.moveTo(x, y);
    else hardwareCtx.lineTo(x, y);
  }
  hardwareCtx.stroke();
}

function scheduleGraphRedraw(): void {
  requestAnimationFrame(() => drawHardwareGraph());
}

function initHardwareScrubbing(): void {
  hardwareCanvas.style.cursor = "crosshair";

  hardwareCanvas.addEventListener("mousemove", (e) => {
    const rect = hardwareCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const plotX = 38;
    const plotWidth = Math.max(1, rect.width - plotX - 4);
    const slotIdx = Math.round(((x - plotX) / plotWidth) * (hardwareGraphPoints - 1));

    if (hardwareScrubDrag) {
      // Dragging — adjust viewOffset
      const dxPx = e.clientX - hardwareScrubDrag.startX;
      const ptsPerPx = hardwareGraphPoints / Math.max(1, plotWidth);
      const maxOffset = Math.max(0, hardwareHistory.length - hardwareGraphPoints);
      hardwareViewOffset = Math.max(0, Math.min(maxOffset,
        Math.round(hardwareScrubDrag.startOffset + dxPx * ptsPerPx)));
      scheduleGraphRedraw();
    } else {
      // Hovering — show crosshair
      const visStart = hardwareFollowLive
        ? Math.max(0, hardwareHistory.length - hardwareGraphPoints)
        : Math.max(0, Math.min(hardwareHistory.length - hardwareGraphPoints, hardwareHistory.length - hardwareGraphPoints - hardwareViewOffset));
      hardwareHover = { x, idx: Math.max(0, Math.min(hardwareGraphPoints - 1, slotIdx)) };
      scheduleGraphRedraw();
    }
  });

  hardwareCanvas.addEventListener("mouseleave", () => {
    if (!hardwareScrubDrag) {
      hardwareHover = null;
      scheduleGraphRedraw();
    }
  });

  hardwareCanvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    hardwareScrubDrag = { startX: e.clientX, startOffset: hardwareViewOffset };
    hardwareFollowLive = false;
    hardwareHover = null;
    hardwareCanvas.style.cursor = "grabbing";
  });

  document.addEventListener("mousemove", (e) => {
    if (!hardwareScrubDrag) return;
    const rect = hardwareCanvas.getBoundingClientRect();
    const plotWidth = Math.max(1, rect.width - 38 - 4);
    const dxPx = e.clientX - hardwareScrubDrag.startX;
    const ptsPerPx = hardwareGraphPoints / Math.max(1, plotWidth);
    const maxOffset = Math.max(0, hardwareHistory.length - hardwareGraphPoints);
    hardwareViewOffset = Math.max(0, Math.min(maxOffset,
      Math.round(hardwareScrubDrag.startOffset + dxPx * ptsPerPx)));
    scheduleGraphRedraw();
  });

  document.addEventListener("mouseup", () => {
    if (!hardwareScrubDrag) return;
    hardwareScrubDrag = null;
    hardwareCanvas.style.cursor = "crosshair";
    // Release near right edge → resume live
    if (hardwareViewOffset <= 1) {
      hardwareViewOffset = 0;
      hardwareFollowLive = true;
    }
    drawHardwareGraph();
  });
}

async function pollHardware(): Promise<void> {
  try {
    const snapshot = await invoke<HardwareSnapshot>("hardware_snapshot");
    updateHardware(snapshot);
  } catch {
    // ignore
  } finally {
    setTimeout(pollHardware, hardwarePollMs);
  }
}

function initHardwarePollRate(): void {
  const select = el<HTMLSelectElement>("#hardware-poll-rate");
  if (![250, 500, 1000, 1500].includes(hardwarePollMs)) hardwarePollMs = 1000;
  select.value = String(hardwarePollMs);
  select.addEventListener("change", () => {
    hardwarePollMs = parseInt(select.value, 10) || 1000;
    localStorage.setItem("higgsAudio.hardwarePollMs", String(hardwarePollMs));
  });
}

function initHardwareCollapse(): void {
  const panel = el<HTMLElement>("#hardware-panel");
  const toggle = el<HTMLButtonElement>("#hardware-toggle");
  toggle.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    toggle.textContent = collapsed ? "+" : "−";
    toggle.setAttribute("aria-label", collapsed ? "Expand hardware" : "Collapse hardware");
    drawHardwareGraph();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Event listeners (Tauri events from backend)
// ═══════════════════════════════════════════════════════════════════════════

async function initEventListeners(): Promise<void> {
  await listen<ModelStatusEvent>("model-status", (event) => {
    const status = event.payload;
    setText("#engine-chip", status.engineLoaded ? "Engine loaded" : "Engine unloaded");
    el<HTMLElement>("#engine-chip").classList.toggle("active", status.engineLoaded);

    if (!status.modelLoaded) {
      setText("#model-state", "Not loaded");
      el("#model-state").classList.remove("ok");
      setText("#model-chip", "No model");
      el("#model-chip").classList.add("muted");
      el("#model-chip").classList.remove("active");
      el<HTMLButtonElement>("#unload-model-btn").disabled = true;
      return;
    }

    if (status.displayName) {
      setText("#model-state", "Loaded");
      el("#model-state").classList.add("ok");
      setText("#model-chip", `${status.displayName} (${status.weightType || "default"})`);
      el("#model-chip").classList.remove("muted");
      el("#model-chip").classList.add("active");
      el<HTMLButtonElement>("#unload-model-btn").disabled = false;
    }
  });

  await listen<ProgressEvent>("generation-progress", (event) => {
    const p = event.payload;
    const bar = el<HTMLElement>("#gen-progress-bar");
    if (currentMode === "multi" && currentProgressLabels.length === multiLines.length) {
      bar.classList.remove("indeterminate");
      const completeCount = document.querySelectorAll("#gen-progress-steps .progress-step.complete").length;
      const active = Math.max(0, Math.min(currentProgressLabels.length - 1, completeCount));
      setText("#gen-progress-text", `${currentProgressLabels[active] || "Line"} · ${p.phase}`);
      return;
    }

    const phase = p.phase.toLowerCase();
    if (p.total <= 1) {
      if (phase.includes("complete") || phase.includes("done")) {
        bar.classList.remove("indeterminate");
        updateGenerationStep(2, 1);
        setText("#gen-progress-text", "Processing audio output");
      } else {
        bar.classList.add("indeterminate");
        updateGenerationStep(1, 0);
        const elapsed = genStartedAt > 0 ? ` | ${((performance.now() - genStartedAt) / 1000).toFixed(1)}s elapsed` : "";
        setText("#gen-progress-text", `${p.phase || "Generating"}${elapsed}`);
      }
      return;
    }

    bar.classList.remove("indeterminate");
    if (p.total > 0) {
      setProgress("#gen-progress-bar", p.current, p.total);
    }
    if (p.total > 1 && p.total <= 12) {
      const active = Math.max(0, Math.min(p.total - 1, p.current));
      const labels = Array.from({ length: p.total }, (_, i) => `Step ${i + 1}`);
      renderGenerationSteps(labels, active, active - 1);
      setText("#gen-progress-text", `${p.phase} · step ${active + 1}/${p.total}`);
    } else {
      const active = phase.includes("encode") || phase.includes("save")
        ? 3
        : phase.includes("token") || phase.includes("decode") || phase.includes("process")
          ? 2
          : phase.includes("generate") || phase.includes("sample")
            ? 1
            : 0;
      updateGenerationStep(active);
      setText("#gen-progress-text", p.phase);
    }
  });

  await listen<DownloadProgressEvent>("download-progress", (event) => {
    const p = event.payload;
    setProgress("#download-progress-bar", p.downloaded, p.total);
    setText("#download-size-text", `${formatBytes(p.downloaded)} / ${formatBytes(p.total)}`);
    setText("#download-speed-text", `${p.speedMbps.toFixed(1)} MB/s`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Text input char counting
// ═══════════════════════════════════════════════════════════════════════════

function initTextCounting(): void {
  const ttsText = el<HTMLTextAreaElement>("#tts-text");
  const ttsCount = el<HTMLElement>("#tts-count");
  ttsText.addEventListener("input", () => {
    ttsCount.textContent = String(ttsText.value.length);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  initSettings();
  initExternalLinks();
  initWhisperPanel();
  initModeTabs();
  initModelPanel();
  initDropzones();
  initMultiSpeakerWorkflow();
  initAdvancedOptions();
  initGenerate();
  initAudioPlayer();
  initDownload();
  initTextCounting();
  initHardwarePollRate();
  initHardwareCollapse();
  initHardwareScrubbing();
  await initEventListeners();

  renderHistory();
  pollHardware();

  // Auto-load engine on startup if bundled
  const bundled = await invoke<string | null>("bundled_engine_path");
  if (bundled) {
    await doLoadEngine();
  }

  window.addEventListener("resize", () => {
    drawHardwareGraph();
    drawWaveform();
  });
}

document.addEventListener("contextmenu", (e) => e.preventDefault());

main();
