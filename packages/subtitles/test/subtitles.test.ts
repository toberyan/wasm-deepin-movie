import { describe, expect, it } from "vitest";
import {
  SubtitleTrack,
  decodeSubtitleBytes,
  parseSubtitles
} from "../src/index";

describe("subtitle parsing", () => {
  it("parses SRT cues and sorts them", () => {
    const parsed = parseSubtitles(
      `2
00:00:02,000 --> 00:00:03,000
Second

1
00:00:00,500 --> 00:00:01,500
<b>First</b> line
with two lines
`
    );
    expect(parsed.format).toBe("srt");
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0]).toEqual({
      startUs: 500_000,
      endUs: 1_500_000,
      text: "First line\nwith two lines"
    });
    expect(parsed.cues[1]?.startUs).toBe(2_000_000);
  });

  it("parses WebVTT with settings after the timestamp", () => {
    const parsed = parseSubtitles(
      `WEBVTT

00:01.000 --> 00:02.500 align:start position:10%
Hello VTT

00:00:03.000 --> 00:00:04.000
Second
`
    );
    expect(parsed.format).toBe("vtt");
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0]).toMatchObject({ startUs: 1_000_000, endUs: 2_500_000, text: "Hello VTT" });
  });

  it("extracts text from ASS dialogue events", () => {
    const parsed = parseSubtitles(
      `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.20,0:00:01.80,Default,,0,0,0,,{\\i1}Hello, ASS{\\i0}\\NSecond line
Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,Plain
`
    );
    expect(parsed.format).toBe("ass");
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0]).toMatchObject({
      startUs: 200_000,
      endUs: 1_800_000,
      text: "Hello, ASS\nSecond line"
    });
  });

  it("reports malformed cues without throwing", () => {
    const parsed = parseSubtitles(
      `1
not a timestamp
Text

2
00:00:01,000 --> 00:00:02,000
Valid
`
    );
    expect(parsed.cues).toHaveLength(1);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it("decodes UTF-16 BOM and falls back to GB18030", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect(decodeSubtitleBytes(utf16)).toMatchObject({ text: "Hi", encoding: "utf-16le" });

    const gb = new TextEncoder().encode("not actually gb18030");
    const decoded = decodeSubtitleBytes(gb);
    expect(decoded.text.length).toBeGreaterThan(0);
  });
});

describe("SubtitleTrack", () => {
  const track = new SubtitleTrack({
    format: "srt",
    cues: [
      { startUs: 1_000_000, endUs: 2_000_000, text: "A" },
      { startUs: 2_000_000, endUs: 3_000_000, text: "B" },
      { startUs: 5_000_000, endUs: 6_000_000, text: "C" }
    ],
    warnings: []
  });

  it("returns all cues covering the query time", () => {
    expect(track.getActive(2_500_000).map((cue) => cue.text)).toEqual(["B"]);
    expect(track.getActive(2_000_000).map((cue) => cue.text)).toEqual(["B"]);
    expect(track.getActive(4_000_000)).toEqual([]);
  });

  it("applies positive subtitle delay by querying earlier media time", () => {
    expect(track.getActive(1_500_000, 0).map((cue) => cue.text)).toEqual(["A"]);
    expect(track.getActive(1_500_000, 1000).map((cue) => cue.text)).toEqual([]);
    expect(track.getActive(2_500_000, 1000).map((cue) => cue.text)).toEqual(["A"]);
  });
});
