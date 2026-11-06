declare module "jassub" {
  export interface JassubManualRenderData {
    expectedDisplayTime: number;
    width: number;
    height: number;
    mediaTime: number;
  }

  /** libass style record used by the selective style override. */
  export interface JassubStyle {
    Name: string;
    FontName: string;
    FontSize: number;
    PrimaryColour: number;
    SecondaryColour: number;
    OutlineColour: number;
    BackColour: number;
    Bold: number;
    Italic: number;
    Underline: number;
    StrikeOut: number;
    ScaleX: number;
    ScaleY: number;
    Spacing: number;
    Angle: number;
    BorderStyle: number;
    Outline: number;
    Shadow: number;
    Alignment: number;
    MarginL: number;
    MarginR: number;
    MarginV: number;
    Encoding: number;
    treat_fontname_as_pattern: number;
    Blur: number;
    Justify: number;
  }

  export interface JassubRemoteRenderer {
    styleOverride(style: JassubStyle): Promise<void>;
    disableStyleOverride(): Promise<void>;
  }

  export interface JassubOptions {
    canvas: HTMLCanvasElement;
    subUrl?: string;
    subContent?: string;
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
    /** Remote proxy to the libass worker; method calls resolve asynchronously. */
    renderer: JassubRemoteRenderer;
    manualRender(data: JassubManualRenderData, repaint?: boolean): Promise<void>;
    destroy(): Promise<void>;
  }
}
