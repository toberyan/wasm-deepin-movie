/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies are forbidden.",
      from: {},
      to: { circular: true }
    },
    {
      name: "contracts-is-leaf",
      severity: "error",
      comment: "@wasm-player/contracts must not depend on runtime/UI packages.",
      from: { path: "^packages/contracts/" },
      to: {
        path: "^packages/(?!contracts/)",
        pathNot: "^packages/contracts/"
      }
    },
    {
      name: "core-no-concrete-adapters",
      severity: "error",
      comment:
        "player-core owns control state and must not import concrete media adapters.",
      from: { path: "^packages/player-core/" },
      to: {
        path: "^packages/(ffmpeg-adapter|webcodecs-adapter|renderer|audio|subtitles|storage|host|source-readers)/"
      }
    },
    {
      name: "media-engine-no-ui",
      severity: "error",
      comment: "media-engine is framework agnostic.",
      from: { path: "^packages/media-engine/" },
      to: { path: "^apps/web/|react|react-dom" }
    },
    {
      name: "adapters-no-core",
      severity: "error",
      comment: "Media adapters must not depend on player-core or the UI.",
      from: { path: "^packages/(ffmpeg-adapter|webcodecs-adapter|renderer|audio|source-readers)/" },
      to: { path: "^packages/player-core/|^apps/web/" }
    },
    {
      name: "web-no-media-internals",
      severity: "error",
      comment:
        "The web app composes public adapter APIs; it must not import libav.js or WebCodecs bridge internals directly.",
      from: { path: "^apps/web/" },
      to: { path: "node_modules/(libav\\.js|@libav\\.js|libavjs-webcodecs-bridge)/" }
    },
    {
      name: "no-orphans",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "\\.(test|spec)\\.ts$",
          "(^|/)index\\.ts$",
          "(^|/)main\\.tsx$",
          "(^|/).*\\.worker\\.ts$",
          "\\.d\\.ts$",
          "(^|/)vite\\.config\\.ts$",
          "(^|/)vitest\\.config\\.ts$",
          "(^|/)playwright\\.config\\.ts$",
          "(^|/)tsup\\.config\\.ts$",
          "(^|/)scripts/"
        ]
      },
      to: {}
    }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^(apps/web/(dist|public)|node_modules)/" },
    tsConfig: { fileName: "tsconfig.base.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"]
    },
    reporterOptions: {
      text: { highlightFocused: true }
    }
  }
};
