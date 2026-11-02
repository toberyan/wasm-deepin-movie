import { mkdtemp, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MediaBroker } from "../src/broker";
import { tokenMatches } from "../src/token";
import { parseArgs } from "../src/args";

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "wasm-player-broker-"));
  outside = await mkdtemp(join(tmpdir(), "wasm-player-outside-"));
  await mkdir(join(root, "media"));
  await writeFile(join(root, "media", "sample.mp4"), new Uint8Array([0, 1, 2, 3]));
  await writeFile(join(root, "notes.txt"), "not media");
  await writeFile(join(outside, "secret.mp4"), new Uint8Array([9, 9, 9]));
  await symlink(join(outside, "secret.mp4"), join(root, "escape.mp4"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("companion token", () => {
  it("compares tokens without accepting prefixes", () => {
    expect(tokenMatches("abcdef", "abcdef")).toBe(true);
    expect(tokenMatches("abcdef", "abcde")).toBe(false);
    expect(tokenMatches("abcdef", "abcdeg")).toBe(false);
    expect(tokenMatches("abcdef", undefined)).toBe(false);
  });
});

describe("companion args", () => {
  it("defaults to loopback and parses repeated roots", () => {
    const args = parseArgs(["--allow-root", "tests/a", "--allow-root", "tests/b", "--port", "0"]);
    expect(args.host).toBe("127.0.0.1");
    expect(args.port).toBe(0);
    expect(args.allowRoots).toHaveLength(2);
    expect(args.stdio).toBe(false);
  });

  it("rejects non-loopback binding", () => {
    expect(() => parseArgs(["--host", "0.0.0.0"])).toThrow(/loopback/);
  });
});

describe("media broker", () => {
  it("lists only media under authorized roots", async () => {
    const broker = new MediaBroker([root]);
    await broker.init();
    const sources = await broker.list("http://127.0.0.1:1234");
    expect(sources.map((source) => source.sourceId)).toEqual(["media/sample.mp4"]);
    expect(sources[0]?.url).toContain("/broker/media?path=media%2Fsample.mp4");
  });

  it("rejects traversal, absolute paths and symlink escapes", async () => {
    const broker = new MediaBroker([root]);
    await broker.init();
    expect(await broker.resolve("../notes.txt")).toBeNull();
    expect(await broker.resolve("/etc/passwd")).toBeNull();
    expect(await broker.resolve("escape.mp4")).toBeNull();
    expect(await broker.resolve("notes.txt")).toBeNull();
    expect(await broker.resolve("media/../notes.txt")).toBeNull();
    expect(await broker.resolve("media/sample.mp4")).toMatchObject({
      name: "sample.mp4",
      mimeType: "video/mp4"
    });
  });
});
