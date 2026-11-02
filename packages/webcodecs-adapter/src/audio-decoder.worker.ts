import type {
  AudioDecoderRequest,
  AudioDecoderResponse
} from "./protocol";
import { toAudioDecoderConfig } from "./protocol";

interface WorkerScope {
  onmessage: ((event: MessageEvent<AudioDecoderRequest>) => void) | null;
  postMessage(message: AudioDecoderResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let decoder: AudioDecoder | null = null;
let epoch = 0;
let configured = false;
let lastConfig: AudioDecoderConfig | null = null;

function post(message: AudioDecoderResponse, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer);
}

function fail(error: unknown, responseEpoch?: number, requestId?: number): void {
  const response: AudioDecoderResponse = {
    type: "error",
    error: {
      code: "DECODE_FAILED",
      message: error instanceof Error ? error.message : String(error)
    },
    epoch: responseEpoch
  };
  if (requestId !== undefined) response.requestId = requestId;
  post(response);
}

function outputAudio(data: AudioData): void {
  try {
    if (!configured) {
      data.close();
      return;
    }
    const channels: ArrayBuffer[] = [];
    for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
      const plane = new Float32Array(data.numberOfFrames);
      data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
      channels.push(plane.buffer as ArrayBuffer);
    }
    post(
      {
        type: "pcm",
        epoch,
        timestampUs: data.timestamp,
        sampleRate: data.sampleRate,
        numberOfFrames: data.numberOfFrames,
        channels
      },
      channels
    );
  } finally {
    data.close();
  }
}

function ensureDecoder(): AudioDecoder {
  if (decoder) return decoder;
  const instance = new AudioDecoder({
    output: outputAudio,
    error(error) {
      configured = false;
      fail(error, epoch);
    }
  });
  decoder = instance;
  return instance;
}

scope.onmessage = (event) => {
  const request = event.data;
  void (async () => {
    try {
      switch (request.type) {
        case "configure": {
          if (decoder) {
            decoder.close();
            decoder = null;
          }
          configured = false;
          epoch = request.epoch;
          if (typeof AudioDecoder === "undefined") {
            post({
              type: "configured",
              requestId: request.requestId,
              supported: false,
              reason: "WebCodecs AudioDecoder is unavailable"
            });
            return;
          }
          const init = toAudioDecoderConfig(request.config);
          const support = await AudioDecoder.isConfigSupported(init);
          if (!support.supported) {
            post({
              type: "configured",
              requestId: request.requestId,
              supported: false,
              reason: `WebCodecs does not support ${request.config.codec}`
            });
            return;
          }
          const instance = ensureDecoder();
          instance.configure(init);
          lastConfig = init;
          configured = true;
          post({ type: "configured", requestId: request.requestId, supported: true });
          return;
        }
        case "decode": {
          if (!decoder || !configured || request.epoch !== epoch) return;
          const chunk = new EncodedAudioChunk({
            type: request.chunk.type,
            timestamp: request.chunk.timestamp,
            duration: request.chunk.duration,
            data: request.chunk.data
          });
          decoder.decode(chunk);
          return;
        }
        case "flush": {
          if (decoder) await decoder.flush();
          post({ type: "flushed", requestId: request.requestId, epoch });
          return;
        }
        case "reset": {
          const previous = epoch;
          epoch = request.epoch;
          if (decoder) {
            decoder.reset();
            if (lastConfig) decoder.configure(lastConfig);
          }
          post({ type: "reset", requestId: request.requestId, epoch: previous });
          return;
        }
        case "close": {
          if (decoder) {
            decoder.close();
            decoder = null;
          }
          configured = false;
          post({ type: "closed", requestId: request.requestId });
          return;
        }
      }
    } catch (error) {
      fail(error, epoch, "requestId" in request ? request.requestId : undefined);
    }
  })();
};
