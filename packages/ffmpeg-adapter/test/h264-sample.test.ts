import { describe, expect, it } from "vitest";
import { isLengthPrefixedSample, toWebCodecsH264Sample } from "../src/index";

/** Build a 4-byte length-prefixed (AVCC) sample from raw NAL units. */
function avccSample(...nals: Uint8Array[]): Uint8Array {
  const size = nals.reduce((sum, nal) => sum + 4 + nal.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const nal of nals) {
    output[offset] = (nal.length >>> 24) & 0xff;
    output[offset + 1] = (nal.length >>> 16) & 0xff;
    output[offset + 2] = (nal.length >>> 8) & 0xff;
    output[offset + 3] = nal.length & 0xff;
    output.set(nal, offset + 4);
    offset += 4 + nal.length;
  }
  return output;
}

/** Build an Annex B sample (3- or 4-byte start codes) from raw NAL units. */
function annexBSample(prefix: number[], ...nals: Uint8Array[]): Uint8Array {
  const size = nals.reduce((sum, nal) => sum + prefix.length + nal.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const nal of nals) {
    output.set(prefix, offset);
    offset += prefix.length;
    output.set(nal, offset);
    offset += nal.length;
  }
  return output;
}

function payload(type: number, length: number, seed: number): Uint8Array {
  const nal = new Uint8Array(length);
  nal[0] = 0x60 | (type & 0x1f);
  for (let index = 1; index < length; index += 1) {
    // Never emit 00 00 01, which would look like a start code inside a NAL.
    nal[index] = ((index + seed) % 251) + 1;
  }
  return nal;
}

describe("toWebCodecsH264Sample", () => {
  it("keeps an AVCC sample whose length prefix looks like a start code", () => {
    // A 441 byte NAL is prefixed 00 00 01 B9: an Annex B start code followed by
    // the NAL header byte. Treating it as Annex B inflated the sample by one
    // byte and made Chrome's decoder fail mid-playback.
    const sample = avccSample(payload(1, 441, 0));
    expect(sample[0]).toBe(0);
    expect(sample[1]).toBe(0);
    expect(sample[2]).toBe(1);
    expect(isLengthPrefixedSample(sample)).toBe(true);
    expect(toWebCodecsH264Sample(sample)).toBe(sample);
  });

  it("keeps a multi-NAL AVCC sample intact", () => {
    const sample = avccSample(payload(7, 32, 3), payload(1, 300, 7));
    expect(toWebCodecsH264Sample(sample)).toBe(sample);
  });

  it("converts a 4-byte start code Annex B sample to length-prefixed NALs", () => {
    const sps = payload(7, 24, 1);
    const pps = payload(8, 5, 2);
    const slice = payload(5, 40, 3);
    const converted = toWebCodecsH264Sample(
      annexBSample([0, 0, 0, 1], sps, pps, slice)
    );
    expect(converted).not.toBe(sps);
    expect(isLengthPrefixedSample(converted)).toBe(true);
    expect(Array.from(converted)).toEqual(
      Array.from(avccSample(sps, pps, slice))
    );
  });

  it("converts a 3-byte start code Annex B sample to length-prefixed NALs", () => {
    const slice = payload(1, 33, 4);
    const converted = toWebCodecsH264Sample(annexBSample([0, 0, 1], slice));
    expect(isLengthPrefixedSample(converted)).toBe(true);
    expect(Array.from(converted)).toEqual(Array.from(avccSample(slice)));
  });

  it("leaves samples that do not start with zero bytes untouched", () => {
    const sample = Uint8Array.from([0x41, 0x9a, 0x00, 0x00, 0x01, 0x02]);
    expect(toWebCodecsH264Sample(sample)).toBe(sample);
  });
});

describe("isLengthPrefixedSample", () => {
  it("rejects Annex B samples and truncated lengths", () => {
    expect(isLengthPrefixedSample(annexBSample([0, 0, 0, 1], payload(1, 20, 1)))).toBe(
      false
    );
    expect(isLengthPrefixedSample(Uint8Array.from([0, 0, 0, 9, 1, 2, 3]))).toBe(false);
    expect(isLengthPrefixedSample(Uint8Array.from([0, 0, 0, 0]))).toBe(false);
  });
});
