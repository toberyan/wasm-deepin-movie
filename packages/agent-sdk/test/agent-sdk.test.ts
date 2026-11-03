import { describe, expect, it } from "vitest";
import type { InvokeRequest, InvokeResult, PlayerSnapshot } from "@wasm-player/contracts";
import { AgentSdk, type AgentInvoker } from "../src/index";

function fakePlayer(): { player: AgentInvoker; requests: InvokeRequest<unknown>[] } {
  const requests: InvokeRequest<unknown>[] = [];
  const player: AgentInvoker = {
    sessionId: "session-test",
    async invoke<I = unknown, O = unknown>(request: InvokeRequest<I>): Promise<InvokeResult<O>> {
      requests.push(request as InvokeRequest<unknown>);
      return {
        requestId: request.requestId,
        sessionId: request.sessionId,
        status: "applied",
        revision: 1
      } as InvokeResult<O>;
    },
    getState() {
      return { sessionId: "session-test", revision: 1 } as PlayerSnapshot;
    }
  };
  return { player, requests };
}

describe("AgentSdk", () => {
  it("creates unique request IDs and forwards typed actions", async () => {
    const { player, requests } = fakePlayer();
    const sdk = new AgentSdk(player);
    await sdk.play();
    await sdk.seek(1_000_000);
    await sdk.selectTrack("audio", 2);
    expect(requests.map((request) => request.action)).toEqual([
      "playback.play",
      "playback.seek",
      "tracks.select"
    ]);
    expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
    expect(requests[1]?.params).toEqual({ positionUs: 1_000_000 });
    expect(requests[2]?.params).toEqual({ type: "audio", index: 2 });
  });

  it("forwards an expected revision when supplied", async () => {
    const { player, requests } = fakePlayer();
    const sdk = new AgentSdk(player);
    await sdk.call("state.get", {}, 7);
    expect(requests[0]?.expectedRevision).toBe(7);
  });
});
