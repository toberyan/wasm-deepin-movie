declare module "jassub" {
  export interface JassubManualRenderData {
    expectedDisplayTime: number;
    width: number;
    height: number;
    mediaTime: number;
  }

  export interface JassubOptions {
    canvas: HTMLCanvasElement;
    subContent: string;
    workerUrl?: string;
    wasmUrl?: string;
    modernWasmUrl?: string;
    fonts?: Array<string | Uint8Array>;
    availableFonts?: Record<string, string | Uint8Array>;
    defaultFont?: string;
    queryFonts?: "local" | "localandremote" | false;
    debug?: boolean;
    prescaleFactor?: number;
    timeOffset?: number;
  }

  export default class JASSUB {
    constructor(options: JassubOptions);
    ready: Promise<void>;
    manualRender(data: JassubManualRenderData, repaint?: boolean): Promise<void>;
    destroy(): Promise<void>;
  }
}
