import { PlayerError } from "@wasm-player/contracts";
import type {
  EngineMediaSource,
  FrameSampler,
  FrameSamplerFactory,
  FrameSamplerInfo,
  StoryboardSampleRequest
} from "@wasm-player/media-engine";
import { BrowserMediaEngine } from "./browser-media-engine";

export interface BrowserFrameSamplerOptions {
  libavBase?: string;
  libavVariant?: string;
  libavThreads?: "st" | "mt";
  /** Longest edge of the sampling canvas; tiles are downscaled from this. */
  maxCanvasWidth?: number;
  maxCanvasHeight?: number;
}

function abortError(): DOMException {
  return new DOMException("sampling cancelled", "AbortError");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function formatTimestamp(timeUs: number): string {
  const total = Math.max(0, Math.floor(timeUs / 1_000_000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/**
 * Independent frame sampler. It owns a sampling-only engine (no audio output,
 * no attachments, no embedded subtitle work) and an offscreen canvas host, so
 * seeking and decoding for thumbnails never touch the playing engine.
 */
class BrowserFrameSampler implements FrameSampler {
  readonly info: FrameSamplerInfo;
  private readonly engine: BrowserMediaEngine;
  private readonly host: HTMLDivElement;

  constructor(engine: BrowserMediaEngine, info: FrameSamplerInfo, host: HTMLDivElement) {
    this.engine = engine;
    this.info = info;
    this.host = host;
  }

  async storyboard(
    request: StoryboardSampleRequest
  ): Promise<{ blob: Blob; width: number; height: number }> {
    const { positionsUs, signal } = request;
    const columns = Math.max(1, Math.min(request.columns, positionsUs.length));
    const rows = Math.ceil(positionsUs.length / columns);
    const board = document.createElement("canvas");
    board.width = columns * request.tileWidth;
    board.height = rows * request.tileHeight;
    const context = board.getContext("2d");
    if (!context) throw new PlayerError("INTERNAL", "2D canvas is unavailable");

    try {
      context.fillStyle = "#000";
      context.fillRect(0, 0, board.width, board.height);
      let completed = 0;
      for (const [index, positionUs] of positionsUs.entries()) {
        if (signal.aborted) throw abortError();
        const before = this.engine.getSnapshot().stats.renderedFrames;
        await this.engine.seek(positionUs);
        await this.waitForFrame(before, 5_000, signal);
        const shot = await this.engine.capture({
          format: "png",
          includeSubtitles: false,
          includeOsd: false
        });
        const bitmap = await createImageBitmap(shot.blob);
        const x = (index % columns) * request.tileWidth;
        const y = Math.floor(index / columns) * request.tileHeight;
        const scale = Math.max(
          request.tileWidth / bitmap.width,
          request.tileHeight / bitmap.height
        );
        const width = bitmap.width * scale;
        const height = bitmap.height * scale;
        context.drawImage(
          bitmap,
          x + (request.tileWidth - width) / 2,
          y + (request.tileHeight - height) / 2,
          width,
          height
        );
        bitmap.close();
        context.fillStyle = "rgba(0, 0, 0, 0.62)";
        context.fillRect(x, y + request.tileHeight - 18, request.tileWidth, 18);
        context.fillStyle = "#fff";
        context.font = "11px sans-serif";
        context.fillText(formatTimestamp(positionUs), x + 6, y + request.tileHeight - 5);
        completed += 1;
        request.onProgress?.(completed, positionsUs.length);
      }
      const blob = await new Promise<Blob>((resolve, reject) => {
        board.toBlob(
          (result) => (result ? resolve(result) : reject(new Error("failed to encode storyboard"))),
          "image/png",
          request.quality
        );
      });
      if (signal.aborted) throw abortError();
      return { blob, width: board.width, height: board.height };
    } finally {
      board.width = 1;
      board.height = 1;
    }
  }

  async close(): Promise<void> {
    await this.engine.dispose().catch(() => undefined);
    this.host.remove();
  }

  private async waitForFrame(
    after: number,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (signal.aborted) throw abortError();
      if (this.engine.getSnapshot().stats.renderedFrames > after) return;
      if (performance.now() >= deadline) {
        throw new PlayerError("TIMEOUT", "sampled frame did not render in time", {
          recoverable: true
        });
      }
      await delay(20, signal);
    }
  }
}

/**
 * Builds samplers that decode the source independently of the player. The host
 * element is laid out off-screen so the renderer has a real drawing size, which
 * keeps capture resolution bounded by `maxCanvasWidth`/`maxCanvasHeight` instead
 * of the video resolution.
 */
export function createBrowserFrameSampler(
  options: BrowserFrameSamplerOptions = {}
): FrameSamplerFactory {
  const maxWidth = options.maxCanvasWidth ?? 640;
  const maxHeight = options.maxCanvasHeight ?? 360;
  return async (
    source: EngineMediaSource,
    samplerOptions: { trackIndex?: number }
  ): Promise<FrameSampler> => {
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-10000px";
    host.style.top = "0";
    host.style.width = `${maxWidth}px`;
    host.style.height = `${maxHeight}px`;
    host.style.pointerEvents = "none";
    host.setAttribute("aria-hidden", "true");
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);
    const overlay = document.createElement("div");
    host.appendChild(overlay);
    document.body.appendChild(host);

    const engine = new BrowserMediaEngine({
      canvas,
      overlayContainer: overlay,
      sampling: true,
      ...(options.libavBase !== undefined ? { libavBase: options.libavBase } : {}),
      ...(options.libavVariant !== undefined ? { libavVariant: options.libavVariant } : {}),
      ...(options.libavThreads !== undefined ? { libavThreads: options.libavThreads } : {})
    });
    try {
      const opened = await engine.open({
        source,
        ...(samplerOptions.trackIndex !== undefined
          ? { preferredTracks: { video: samplerOptions.trackIndex } }
          : {})
      });
      const video = opened.media.streams.find((stream) => stream.type === "video");
      if (!video) {
        throw new PlayerError("UNSUPPORTED", "storyboard needs a video track");
      }
      const info: FrameSamplerInfo = {
        durationUs: opened.media.durationUs,
        width: video.width ?? 0,
        height: video.height ?? 0,
        trackIndex: video.index
      };
      return new BrowserFrameSampler(engine, info, host);
    } catch (error) {
      await engine.dispose().catch(() => undefined);
      host.remove();
      throw error;
    }
  };
}
