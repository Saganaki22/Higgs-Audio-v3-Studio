declare module "lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }

  const lamejs: {
    Mp3Encoder: typeof Mp3Encoder;
  };

  export default lamejs;
}

declare module "lamejs/lame.all.js?raw" {
  const source: string;
  export default source;
}
