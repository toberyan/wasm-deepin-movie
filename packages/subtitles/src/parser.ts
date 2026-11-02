export interface SubtitleCue {
  startUs: number;
  endUs: number;
  text: string;
}

export type SubtitleFormat = "srt" | "vtt" | "ass" | "ssa";

export interface ParsedSubtitles {
  format: SubtitleFormat;
  cues: SubtitleCue[];
  warnings: string[];
}

function parseTimestamp(value: string, dots = false): number {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length < 2 || parts.length > 3) throw new Error(`invalid subtitle timestamp: ${value}`);
  const secondsPart = parts.pop()!;
  const minutes = Number(parts.pop()!);
  const hours = parts.length > 0 ? Number(parts[0]) : 0;
  const seconds = Number(secondsPart);
  if (![hours, minutes, seconds].every(Number.isFinite)) {
    throw new Error(`invalid subtitle timestamp: ${value}`);
  }
  void dots;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1_000_000);
}

function cleanText(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "")
    .trim();
}

function parseSrtLike(text: string, format: "srt" | "vtt"): ParsedSubtitles {
  const warnings: string[] = [];
  const cues: SubtitleCue[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;
    if (format === "vtt" && lines[0]?.trim().startsWith("WEBVTT")) continue;
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) {
      if (lines.length > 1) warnings.push(`ignored block without a timestamp: ${lines[0]}`);
      continue;
    }
    const timeLine = lines[timeIndex]!;
    const [startRaw, endRaw] = timeLine.split("-->").map((part) => part.trim());
    if (!startRaw || !endRaw) {
      warnings.push(`ignored malformed cue: ${timeLine}`);
      continue;
    }
    try {
      const startUs = parseTimestamp(startRaw.split(/\s+/)[0]!);
      const endUs = parseTimestamp(endRaw.split(/\s+/)[0]!);
      const cueText = cleanText(lines.slice(timeIndex + 1).join("\n"));
      if (cueText.length > 0 && endUs > startUs) {
        cues.push({ startUs, endUs, text: cueText });
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  cues.sort((a, b) => a.startUs - b.startUs);
  return { format, cues, warnings };
}

function parseAssLike(text: string, format: "ass" | "ssa"): ParsedSubtitles {
  const warnings: string[] = [];
  const cues: SubtitleCue[] = [];
  let inEvents = false;
  let fields: string[] = [];
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inEvents = line.toLowerCase() === "[events]";
      continue;
    }
    if (!inEvents) continue;
    if (line.toLowerCase().startsWith("format:")) {
      fields = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((field) => field.trim().toLowerCase());
      continue;
    }
    if (!line.toLowerCase().startsWith("dialogue:")) continue;
    const body = line.slice(line.indexOf(":") + 1).trim();
    const parts = body.split(",");
    if (parts.length < 10 && fields.length === 0) {
      warnings.push(`ignored malformed ASS dialogue: ${line.slice(0, 40)}`);
      continue;
    }
    const useFields =
      fields.length > 0
        ? fields
        : [
            "layer",
            "start",
            "end",
            "style",
            "name",
            "marginl",
            "marginr",
            "marginv",
            "effect",
            "text"
          ];
    const values: string[] = [];
    for (let i = 0; i < useFields.length - 1; i += 1) values.push(parts[i] ?? "");
    values.push(parts.slice(useFields.length - 1).join(","));
    const startIndex = useFields.indexOf("start");
    const endIndex = useFields.indexOf("end");
    const textIndex = useFields.indexOf("text");
    if (startIndex < 0 || endIndex < 0 || textIndex < 0) continue;
    try {
      const startUs = parseTimestamp(values[startIndex]!, true);
      const endUs = parseTimestamp(values[endIndex]!, true);
      const cueText = cleanText(values[textIndex] ?? "");
      if (cueText.length > 0 && endUs > startUs) {
        cues.push({ startUs, endUs, text: cueText });
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  cues.sort((a, b) => a.startUs - b.startUs);
  return { format, cues, warnings };
}

export function parseSubtitles(
  text: string,
  format: SubtitleFormat | "auto" = "auto"
): ParsedSubtitles {
  const normalized = text.replace(/^\uFEFF/, "");
  const detected: SubtitleFormat =
    format !== "auto"
      ? format
      : /^\s*WEBVTT/i.test(normalized)
        ? "vtt"
        : /\[Script Info\]|\[Events\]/i.test(normalized)
          ? "ass"
          : "srt";
  if (detected === "vtt" || detected === "srt") return parseSrtLike(normalized, detected);
  return parseAssLike(normalized, detected);
}

export function decodeSubtitleBytes(
  data: Uint8Array,
  encoding?: string
): { text: string; encoding: string; warnings: string[] } {
  const warnings: string[] = [];
  if (encoding) {
    return {
      text: new TextDecoder(encoding).decode(data),
      encoding,
      warnings
    };
  }
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(data.subarray(2)), encoding: "utf-16le", warnings };
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(data.subarray(2)), encoding: "utf-16be", warnings };
  }
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (!utf8.includes("\uFFFD")) {
    return { text: utf8, encoding: "utf-8", warnings };
  }
  try {
    const gb = new TextDecoder("gb18030").decode(data);
    warnings.push("UTF-8 decode produced replacement characters; used GB18030");
    return { text: gb, encoding: "gb18030", warnings };
  } catch {
    warnings.push("subtitle encoding could not be detected; kept UTF-8 replacement characters");
    return { text: utf8, encoding: "utf-8", warnings };
  }
}

export class SubtitleTrack {
  readonly cues: readonly SubtitleCue[];
  readonly format: SubtitleFormat;
  readonly warnings: readonly string[];

  constructor(parsed: ParsedSubtitles) {
    this.cues = [...parsed.cues].sort((a, b) => a.startUs - b.startUs);
    this.format = parsed.format;
    this.warnings = parsed.warnings;
  }

  getActive(timeUs: number, delayMs = 0): SubtitleCue[] {
    const query = timeUs - delayMs * 1000;
    const active: SubtitleCue[] = [];
    for (const cue of this.cues) {
      if (cue.startUs > query) break;
      if (cue.endUs > query) active.push(cue);
    }
    return active;
  }
}
