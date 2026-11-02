import DefaultLibAV from "@libav.js/variant-webcodecs";

export type LibAVWrapper = typeof DefaultLibAV;

export interface LibAVLoadOptions {
  base?: string;
  variant?: string;
}

/**
 * Loads either the locked prebuilt variant or a project-built variant from the
 * same-origin libav directory. The custom variant is intentionally loaded by
 * URL so its ABI and manifest remain replaceable without rebuilding the worker.
 */
export async function loadLibAV(options: LibAVLoadOptions = {}): Promise<LibAVWrapper> {
  if (!options.variant) return DefaultLibAV;
  const base = options.base ?? "/libav/";
  const module = (await import(
    /* @vite-ignore */ `${base}libav-${options.variant}.mjs`
  )) as { default?: LibAVWrapper };
  if (!module.default) {
    throw new Error(`libav variant ${options.variant} did not export a default wrapper`);
  }
  return module.default;
}
