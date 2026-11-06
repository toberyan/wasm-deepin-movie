import { describe, expect, it } from "vitest";
import type { ColorInfo } from "@wasm-player/contracts";
import { avFrameToRgba, resolveYuvConversion } from "../src/index";

type Frame = Parameters<typeof avFrameToRgba>[0];

/** Build a YUV420P frame with flat planes so each conversion path is testable. */
function yuvFrame(
  width: number,
  height: number,
  y: number,
  u: number,
  v: number,
  format = 0
): Frame {
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const ySize = width * height;
  const chromaSize = chromaWidth * chromaHeight;
  const data = new Uint8Array(ySize + chromaSize * 2);
  data.fill(y, 0, ySize);
  data.fill(u, ySize, ySize + chromaSize);
  data.fill(v, ySize + chromaSize);
  return {
    width,
    height,
    format,
    data,
    layout: [
      { offset: 0, stride: width },
      { offset: ySize, stride: chromaWidth },
      { offset: ySize + chromaSize, stride: chromaWidth }
    ],
    crop: { top: 0, bottom: 0, left: 0, right: 0 }
  } as unknown as Frame;
}

function pixel(frame: Frame, color?: ColorInfo): [number, number, number] {
  const image = avFrameToRgba(frame, color);
  if (!image) throw new Error("conversion returned null");
  const bytes = new Uint8Array(image.data);
  return [bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0];
}

describe("YUV to RGBA conversion", () => {
  it("maps limited-range black and white to 0 and 255", () => {
    expect(pixel(yuvFrame(2, 2, 16, 128, 128), { range: "tv" })).toEqual([0, 0, 0]);
    expect(pixel(yuvFrame(2, 2, 235, 128, 128), { range: "tv" })).toEqual([255, 255, 255]);
  });

  it("uses the full range for YUVJ420P and for pc streams", () => {
    expect(pixel(yuvFrame(2, 2, 0, 128, 128, 12))).toEqual([0, 0, 0]);
    expect(pixel(yuvFrame(2, 2, 255, 128, 128, 12))).toEqual([255, 255, 255]);
    expect(pixel(yuvFrame(2, 2, 0, 128, 128), { range: "pc" })).toEqual([0, 0, 0]);
    // 235 is not white in full range.
    expect(pixel(yuvFrame(2, 2, 235, 128, 128), { range: "pc" })[0]).toBe(235);
  });

  it("applies the probed matrix instead of fixed BT.601 coefficients", () => {
    const frame = yuvFrame(2, 2, 100, 100, 200);
    const [r601, , b601] = pixel(frame, { matrix: "bt601", range: "tv" });
    const [r709, , b709] = pixel(frame, { matrix: "bt709", range: "tv" });
    const [r2020] = pixel(frame, { matrix: "bt2020nc", range: "tv" });
    expect(r709).toBeGreaterThan(r601);
    expect(b709).toBeLessThan(b601);
    expect(r2020).toBeGreaterThan(r601);
    // BT.601 reference value for this sample.
    expect(r601).toBe(229);
    expect(b601).toBe(34);
  });

  it("converts YCgCo chroma with its own inverse", () => {
    const gray = pixel(yuvFrame(2, 2, 128, 128, 128), { matrix: "ycgco", range: "tv" });
    expect(gray[0]).toBe(gray[1]);
    expect(gray[1]).toBe(gray[2]);
    const tinted = pixel(yuvFrame(2, 2, 128, 128, 200), { matrix: "ycgco", range: "tv" });
    expect(tinted[0]).toBeGreaterThan(tinted[1]);
  });

  it("falls back to a height-based matrix when the container omits it", () => {
    expect(resolveYuvConversion(undefined, 480, 0)).toEqual({ matrix: "bt601", range: "tv" });
    expect(resolveYuvConversion(undefined, 1080, 0)).toEqual({ matrix: "bt709", range: "tv" });
    expect(resolveYuvConversion({ range: "pc" }, 720, 0)).toEqual({
      matrix: "bt709",
      range: "pc"
    });
  });
});
