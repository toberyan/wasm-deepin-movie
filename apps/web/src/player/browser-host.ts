import { PlayerError } from "@wasm-player/contracts";
import type { PlayerHost } from "@wasm-player/player-core";

export const browserHost: PlayerHost = {
  async fullscreen(enabled: boolean): Promise<void> {
    if (enabled) {
      if (!document.fullscreenEnabled) {
        throw new PlayerError("UNSUPPORTED", "Fullscreen is unavailable");
      }
      await document.documentElement.requestFullscreen();
      return;
    }
    if (document.fullscreenElement) await document.exitFullscreen();
  },
  async pictureInPicture(): Promise<void> {
    throw new PlayerError(
      "UNSUPPORTED",
      "Picture-in-Picture requires an HTMLVideoElement; the WebGL pipeline does not provide one"
    );
  },
  async pickFiles(): Promise<File[]> {
    throw new PlayerError("NEEDS_USER_GESTURE", "Use the visible Open button to pick files");
  },
  async saveFile(): Promise<void> {
    throw new PlayerError("UNSUPPORTED", "Save-file broker is not available in the browser host");
  }
};
