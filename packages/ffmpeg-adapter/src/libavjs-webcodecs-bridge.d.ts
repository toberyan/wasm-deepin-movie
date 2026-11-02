/**
 * Local type shim for libavjs-webcodecs-bridge 0.3.2.
 *
 * The published package points `types` at its TypeScript sources, which are
 * checked with newer lib/WebCodecs typings than the package supports. We only
 * use the two config converters here; packet conversion is implemented in this
 * adapter so 64-bit negative PTS values are handled correctly.
 */
declare module "libavjs-webcodecs-bridge" {
  import type * as LibAVJS from "@libav.js/types";

  export interface BridgeVideoConfig {
    codec: string;
    codedWidth?: number;
    codedHeight?: number;
    description?: BufferSource;
  }

  export interface BridgeAudioConfig {
    codec: string;
    sampleRate?: number;
    numberOfChannels?: number;
    description?: BufferSource;
  }

  export function videoStreamToConfig(
    libav: LibAVJS.LibAV,
    stream: LibAVJS.Stream | LibAVJS.CodecParameters
  ): Promise<BridgeVideoConfig | null>;

  export function audioStreamToConfig(
    libav: LibAVJS.LibAV,
    stream: LibAVJS.Stream | LibAVJS.CodecParameters
  ): Promise<BridgeAudioConfig | null>;
}
