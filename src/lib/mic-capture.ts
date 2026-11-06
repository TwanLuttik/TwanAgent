import { meterLevel } from "./speech.ts";

/** Level samples kept while the microphone is open. The composer draws the newest few. */
export const VOICE_TRACE = 42;
const TRACE_GAP_MS = 48;

const PCM_WORKLET = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel);
    return true;
  }
}
registerProcessor("pcm-capture", PcmCaptureProcessor);
`;

/**
 * Samples posted by an audio worklet.
 * The buffer is not always a Float32Array of this window, so a typed-array
 * check drops the whole recording and the dictation looks empty.
 */
export function pcmFromMessage(data: unknown): Float32Array | null {
  if (data instanceof Float32Array) return new Float32Array(data);
  if (data instanceof ArrayBuffer && data.byteLength >= 4 && data.byteLength % 4 === 0) {
    return new Float32Array(data.slice(0));
  }
  if (data == null || typeof data !== "object") return null;
  const view = data as { length?: unknown };
  if (typeof view.length !== "number" || view.length <= 0) return null;
  const out = new Float32Array(view.length);
  const source = data as { [index: number]: unknown };
  for (let i = 0; i < view.length; i += 1) {
    const sample = source[i];
    out[i] = typeof sample === "number" && Number.isFinite(sample) ? sample : 0;
  }
  return out;
}

/** Newest sample on the right. Unfilled bars stay quiet on the left. */
export function orderedVoiceTrace(trace: ArrayLike<number>, written: number): number[] {
  const size = trace.length;
  const out = new Array<number>(size).fill(0);
  if (size === 0 || written <= 0) return out;
  const count = Math.min(written, size);
  if (written <= size) {
    const pad = size - count;
    for (let i = 0; i < count; i += 1) out[pad + i] = clampLevel(trace[i]);
    return out;
  }
  const start = written % size;
  for (let i = 0; i < size; i += 1) out[i] = clampLevel(trace[(start + i) % size]);
  return out;
}

export function pushVoiceTrace(trace: Float32Array, written: number, level: number): number {
  if (trace.length === 0) return written;
  trace[written % trace.length] = clampLevel(level);
  return written + 1;
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.min(1, level);
}

export type MicCapture = {
  stop: () => void;
  sampleRate: number;
};

type ScriptProcessorHost = AudioContext & {
  createScriptProcessor?: (bufferSize: number, inputs: number, outputs: number) => ScriptProcessorNode;
};

/**
 * Record mono PCM from a microphone stream.
 * The worklet is loaded from a blob because this webview cannot fetch the
 * module URL. When that still fails, the older script processor is used.
 */
export async function openMicCapture(
  ctx: AudioContext,
  stream: MediaStream,
  onSamples: (samples: Float32Array) => void,
  onLevel: (level: number) => void,
): Promise<MicCapture> {
  if (ctx.state === "suspended") await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  let bucket = 0;
  let markedAt = 0;
  const take = (samples: Float32Array) => {
    onSamples(samples);
    bucket = Math.max(bucket, meterLevel(samples));
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - markedAt < TRACE_GAP_MS) return;
    markedAt = now;
    onLevel(bucket);
    bucket = 0;
  };
  try {
    return await openWorklet(ctx, source, sink, take);
  } catch {
    return openScriptProcessor(ctx, source, sink, take);
  }
}

async function openWorklet(
  ctx: AudioContext,
  source: MediaStreamAudioSourceNode,
  sink: GainNode,
  take: (samples: Float32Array) => void,
): Promise<MicCapture> {
  if (!ctx.audioWorklet) throw new Error("no worklet");
  const url = URL.createObjectURL(new Blob([PCM_WORKLET], { type: "text/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const processor = new AudioWorkletNode(ctx, "pcm-capture");
  processor.port.onmessage = (event: MessageEvent<unknown>) => {
    const samples = pcmFromMessage(event.data);
    if (samples) take(samples);
  };
  source.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);
  return {
    sampleRate: ctx.sampleRate || 48_000,
    stop: () => {
      processor.port.onmessage = null;
      disconnect(processor, source, sink);
    },
  };
}

function openScriptProcessor(
  ctx: AudioContext,
  source: MediaStreamAudioSourceNode,
  sink: GainNode,
  take: (samples: Float32Array) => void,
): MicCapture {
  const host = ctx as ScriptProcessorHost;
  if (!host.createScriptProcessor) throw new Error("no capture");
  const processor = host.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    const channel = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(channel.length);
    copy.set(channel);
    take(copy);
  };
  source.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);
  return {
    sampleRate: ctx.sampleRate || 48_000,
    stop: () => {
      processor.onaudioprocess = null;
      disconnect(processor, source, sink);
    },
  };
}

function disconnect(...nodes: AudioNode[]) {
  for (const node of nodes) {
    try {
      node.disconnect();
    } catch {
      // already disconnected
    }
  }
}
