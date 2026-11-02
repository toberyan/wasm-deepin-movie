import type { ActionId, InvokeResult } from "@wasm-player/contracts";
import type { PlayerController } from "@wasm-player/player-core";

export interface CompanionBootstrap {
  wsUrl: string;
  token: string;
  sessionId: string;
  brokerUrl: string;
}

interface PageRequest {
  type: "request";
  id: string;
  action: ActionId;
  params: unknown;
  expectedRevision?: number;
}

/**
 * Browser side of the Companion control bridge. The page is the media owner;
 * Companion only relays typed commands and results.
 */
export class CompanionClient {
  private readonly bootstrap: CompanionBootstrap;
  private readonly controller: PlayerController;
  private readonly onStatus: (connected: boolean) => void;
  private socket: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    bootstrap: CompanionBootstrap,
    controller: PlayerController,
    onStatus: (connected: boolean) => void
  ) {
    this.bootstrap = bootstrap;
    this.controller = controller;
    this.onStatus = onStatus;
  }

  connect(): void {
    if (this.closed || this.socket) return;
    const url = new URL(this.bootstrap.wsUrl);
    url.searchParams.set("token", this.bootstrap.token);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      const state = this.controller.getState();
      socket.send(
        JSON.stringify({
          type: "hello",
          sessionId: this.bootstrap.sessionId,
          state: {
            phase: state.phase,
            media: state.media ? { name: state.media.name } : null
          }
        })
      );
      this.onStatus(true);
    };
    socket.onmessage = (event) => {
      void this.handleMessage(event.data);
    };
    socket.onclose = () => {
      this.socket = null;
      this.onStatus(false);
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, 1000);
      }
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.onStatus(false);
  }

  private async handleMessage(data: unknown): Promise<void> {
    let message: PageRequest;
    try {
      message = JSON.parse(String(data)) as PageRequest;
    } catch {
      return;
    }
    if (message.type !== "request" || typeof message.id !== "string") return;
    let result: InvokeResult;
    try {
      result = await this.controller.invoke({
        requestId: message.id,
        sessionId: this.bootstrap.sessionId,
        action: message.action,
        params: message.params,
        expectedRevision: message.expectedRevision
      });
    } catch (error) {
      result = {
        requestId: message.id,
        sessionId: this.bootstrap.sessionId,
        status: "rejected",
        revision: this.controller.getState().revision,
        error: {
          code: "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
          recoverable: false
        }
      };
    }
    this.socket?.send(JSON.stringify({ type: "response", id: message.id, result }));
  }
}
