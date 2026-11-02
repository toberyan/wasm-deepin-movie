import type {
  VideoDecoderRequest,
  VideoDecoderResponse
} from "./protocol";
import { toVideoDecoderConfig } from "./protocol";

interface WorkerScope {
  onmessage: ((event: MessageEvent<VideoDecoderRequest>) => void) | null;
  postMessage(message: VideoDecoderResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let decoder: VideoDecoder | null = null;
let epoch = 0;
let configured = false;
let lastConfig: VideoDecoderConfig | null = null;

function post(message: VideoDecoderResponse, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer);
}

function fail(error: unknown, responseEpoch?: number, requestId?: number): void {
  const response: VideoDecoderResponse = {
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

function ensureDecoder(): VideoDecoder {
  if (decoder) return decoder;
  const instance = new VideoDecoder({
    output(frame) {
      post({ type: "frame", epoch, frame }, [frame]);
    },
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
          const init = toVideoDecoderConfig(request.config);
          if (typeof VideoDecoder === "undefined") {
            post({
              type: "configured",
              requestId: request.requestId,
              supported: false,
              reason: "WebCodecs VideoDecoder is unavailable"
            });
            return;
          }
          const support = await VideoDecoder.isConfigSupported(init);
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
          if (!decoder || !configured || request.epoch !== epoch) {
            // The frame is from an older pipeline generation; dropping it is the
            // required behavior after seek/track changes.
            return;
          }
          const chunk = new EncodedVideoChunk({
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
