import type { GenerationResult, WavPcm } from "./types";

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

function yieldFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function base64ToBytesAsync(base64: string): Promise<Uint8Array> {
  const chunkChars = 0x8000;
  const bytes = new Uint8Array(Math.floor((base64.length * 3) / 4));
  let offset = 0;
  for (let i = 0; i < base64.length; i += chunkChars) {
    const sliceEnd = Math.min(base64.length, i + chunkChars);
    const safeEnd = sliceEnd === base64.length ? sliceEnd : sliceEnd - (sliceEnd % 4);
    const binary = atob(base64.slice(i, safeEnd));
    for (let j = 0; j < binary.length; j++) bytes[offset++] = binary.charCodeAt(j);
    i = safeEnd - chunkChars;
    if ((offset & 0x3ffff) === 0) await yieldFrame();
  }
  return bytes.subarray(0, offset);
}

export async function base64ToBlobAsync(base64: string, mime: string): Promise<Blob> {
  const bytes = await base64ToBytesAsync(base64);
  return new Blob([bytesToArrayBuffer(bytes)], { type: mime });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function parseWavPcm(base64: string): WavPcm {
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

export function encodeWavPcm(pcm: WavPcm): string {
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

export function concatenateWavResults(results: GenerationResult[], pauseSeconds = 0): GenerationResult {
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

export async function encodeMp3FromWav(base64: string): Promise<Uint8Array> {
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
