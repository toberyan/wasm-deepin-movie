/// <reference types="vite/client" />

import type { PlayerController } from "@wasm-player/player-core";

declare global {
  interface Window {
    __player?: PlayerController;
  }
}
