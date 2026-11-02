import type { DecodePath, MediaStreamInfo, TrackType } from "@wasm-player/contracts";

export interface CodecSupport {
  webcodecs: boolean;
  wasm: boolean;
  reason?: string;
}

export interface RouteDecision {
  key: string;
  index: number;
  type: TrackType;
  path: DecodePath;
  supported: boolean;
  reason?: string;
  forced: boolean;
}

export interface RouteResult {
  playbackTracks: RouteDecision[];
  decodePaths: Record<string, DecodePath>;
  unsupported: RouteDecision[];
}

export interface RouteOptions {
  force?: Partial<Record<TrackType, "webcodecs" | "wasm">>;
}

function choosePath(
  support: CodecSupport,
  forced: "webcodecs" | "wasm" | undefined
): { path: DecodePath; supported: boolean; reason?: string; forced: boolean } {
  if (forced === "webcodecs") {
    if (support.webcodecs) return { path: "webcodecs", supported: true, forced: true };
    if (support.wasm) {
      return {
        path: "wasm",
        supported: true,
        reason: "forced WebCodecs unsupported; fell back to WASM",
        forced: true
      };
    }
    return {
      path: "wasm",
      supported: false,
      reason: support.reason ?? "neither WebCodecs nor WASM supports this codec",
      forced: true
    };
  }
  if (forced === "wasm") {
    if (support.wasm) return { path: "wasm", supported: true, forced: true };
    if (support.webcodecs) {
      return {
        path: "webcodecs",
        supported: true,
        reason: "forced WASM unavailable; fell back to WebCodecs",
        forced: true
      };
    }
    return {
      path: "wasm",
      supported: false,
      reason: support.reason ?? "neither WebCodecs nor WASM supports this codec",
      forced: true
    };
  }
  if (support.webcodecs) return { path: "webcodecs", supported: true, forced: false };
  if (support.wasm) {
    return {
      path: "wasm",
      supported: true,
      reason: support.reason ?? "WebCodecs unavailable; using WASM decoder",
      forced: false
    };
  }
  return {
    path: "wasm",
    supported: false,
    reason: support.reason ?? "no decoder available",
    forced: false
  };
}

/**
 * Route audio and video independently. Subtitles are not decoder-routed here;
 * text vs bitmap subtitle support is a capability concern.
 */
export function routeTracks(
  streams: readonly MediaStreamInfo[],
  support: Record<string, CodecSupport>,
  options: RouteOptions = {}
): RouteResult {
  const playbackTracks: RouteDecision[] = [];
  const unsupported: RouteDecision[] = [];
  const decodePaths: Record<string, DecodePath> = {};

  for (const stream of streams) {
    if (stream.type !== "video" && stream.type !== "audio") continue;
    const key = `${stream.type}:${stream.index}`;
    const codecSupport = support[key] ?? { webcodecs: false, wasm: false };
    const decision = choosePath(codecSupport, options.force?.[stream.type]);
    const route: RouteDecision = {
      key,
      index: stream.index,
      type: stream.type,
      path: decision.path,
      supported: decision.supported,
      forced: decision.forced
    };
    if (decision.reason !== undefined) route.reason = decision.reason;
    playbackTracks.push(route);
    decodePaths[key] = route.path;
    if (!route.supported) unsupported.push(route);
  }

  return { playbackTracks, decodePaths, unsupported };
}
