import { describe, expect, it } from "vitest";
import {
  ACTION_IDS,
  CORE_ACTIONS,
  DEFAULT_SETTINGS,
  PLAYER_ERROR_CODES,
  SETTING_DEFINITIONS,
  SETTING_IDS,
  createCoreRegistry,
  describeSettings,
  flattenSettingsPatch,
  nestSettings,
  settingsPatchSchema,
  settingValueSchemas
} from "../src/index";

describe("action registry", () => {
  const registry = createCoreRegistry();

  it("registers every core action exactly once", () => {
    expect(registry.list()).toHaveLength(CORE_ACTIONS.length);
    const ids = registry.list().map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(ACTION_IDS.mediaOpen);
    expect(ids).toContain(ACTION_IDS.settingsApply);
    expect(ids).toContain(ACTION_IDS.captureCreate);
  });

  it("publishes stable schemas and MCP tool names", () => {
    const descriptors = registry.describe();
    expect(descriptors).toHaveLength(CORE_ACTIONS.length);
    for (const descriptor of descriptors) {
      expect(descriptor.inputSchema).toHaveProperty("type");
      expect(descriptor.outputSchema).toHaveProperty("type");
      expect(descriptor.title.zh.length).toBeGreaterThan(0);
      expect(descriptor.description.en.length).toBeGreaterThan(0);
    }
    const toolNames = registry.mcpTools().map((entry) => entry.toolName);
    expect(new Set(toolNames).size).toBe(toolNames.length);
    for (const toolName of toolNames) {
      expect(toolName).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("rejects duplicate action registration", () => {
    const action = registry.list()[0]!;
    expect(() => registry.register(action)).toThrow(/duplicate action id/);
  });

  it("validates action input and rejects unknown fields", () => {
    expect(() => registry.validateInput(ACTION_IDS.playbackSeek, { positionUs: 10 })).not.toThrow();
    expect(() =>
      registry.validateInput(ACTION_IDS.playbackSeek, { positionUs: -1 })
    ).toThrow();
    expect(() =>
      registry.validateInput(ACTION_IDS.playbackSeek, { positionUs: 1, extra: true })
    ).toThrow();
  });

  it("requires a source payload matching the declared kind", () => {
    expect(() =>
      registry.validateInput(ACTION_IDS.mediaOpen, {
        source: { kind: "file", file: "opaque" }
      })
    ).not.toThrow();
    expect(() =>
      registry.validateInput(ACTION_IDS.mediaOpen, {
        source: { kind: "url" }
      })
    ).toThrow();
    expect(() =>
      registry.validateInput(ACTION_IDS.mediaOpen, {
        source: { kind: "url", url: "https://example.com/a.mp4" }
      })
    ).not.toThrow();
  });
});

describe("settings contract", () => {
  it("keeps defaults valid against each schema", () => {
    for (const id of SETTING_IDS) {
      expect(() => settingValueSchemas[id].parse(DEFAULT_SETTINGS[id])).not.toThrow();
    }
  });

  it("flattens and nests patches without losing information", () => {
    const patch = settingsPatchSchema.parse({
      video: { brightness: 0.1, crop: { left: 0.1, top: 0, right: 0.1, bottom: 0 } },
      audio: { volume: 0.5, muted: true },
      subtitle: { delayMs: 500 },
      playback: { rate: 1.25 },
      app: { theme: "dark" }
    });
    const flat = flattenSettingsPatch(patch);
    expect(flat["video.brightness"]).toBe(0.1);
    expect(flat["audio.muted"]).toBe(true);
    expect(flat["subtitle.delayMs"]).toBe(500);
    const roundTrip = settingsPatchSchema.parse(nestSettings(flat));
    expect(roundTrip).toEqual(patch);
  });

  it("rejects settings outside the documented range", () => {
    expect(() => settingsPatchSchema.parse({ video: { brightness: 2 } })).toThrow();
    expect(() => settingsPatchSchema.parse({ playback: { rate: 8 } })).toThrow();
    expect(() => settingsPatchSchema.parse({ audio: { volume: -0.1 } })).toThrow();
  });

  it("rejects crops that remove the whole frame", () => {
    expect(() =>
      settingsPatchSchema.parse({
        video: { crop: { left: 0.5, right: 0.5, top: 0, bottom: 0 } }
      })
    ).toThrow();
    expect(() =>
      settingsPatchSchema.parse({
        video: { crop: { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 } }
      })
    ).not.toThrow();
  });

  it("describes every setting with UI metadata", () => {
    const descriptors = describeSettings();
    expect(descriptors).toHaveLength(SETTING_IDS.length);
    for (const descriptor of descriptors) {
      const definition = SETTING_DEFINITIONS[descriptor.id];
      expect(descriptor.group).toBe(definition.group);
      expect(descriptor.schema).toBeTypeOf("object");
      expect(descriptor.title.zh).not.toBe("");
      expect(descriptor.unit).not.toBe("");
    }
  });
});

describe("errors", () => {
  it("keeps the published error code set stable", () => {
    expect(PLAYER_ERROR_CODES).toContain("REVISION_CONFLICT");
    expect(PLAYER_ERROR_CODES).toContain("NEEDS_USER_GESTURE");
    expect(PLAYER_ERROR_CODES).toContain("SOURCE_CHANGED");
    expect(new Set(PLAYER_ERROR_CODES).size).toBe(PLAYER_ERROR_CODES.length);
  });
});
