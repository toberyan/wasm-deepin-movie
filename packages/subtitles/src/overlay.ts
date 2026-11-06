export interface SubtitleOverlayOptions {
  fontSizePct: number;
  fontFamily: string;
  visible: boolean;
}

const DEFAULT_OPTIONS: SubtitleOverlayOptions = {
  fontSizePct: 100,
  fontFamily: "",
  visible: true
};

/**
 * DOM overlay for parsed subtitle text. It deliberately uses textContent, never
 * HTML, because subtitle files are untrusted input.
 */
export class SubtitleOverlay {
  private readonly element: HTMLDivElement;
  private options: SubtitleOverlayOptions = { ...DEFAULT_OPTIONS };

  constructor(container: HTMLElement) {
    this.element = document.createElement("div");
    this.element.className = "subtitle-overlay";
    this.element.setAttribute("aria-live", "off");
    this.applyStyles();
    container.appendChild(this.element);
  }

  setOptions(options: Partial<SubtitleOverlayOptions>): void {
    this.options = { ...this.options, ...options };
    this.applyStyles();
  }

  update(cues: readonly { text: string }[]): void {
    if (!this.options.visible || cues.length === 0) {
      this.element.textContent = "";
      return;
    }
    this.element.textContent = cues.map((cue) => cue.text).join("\n");
  }

  clear(): void {
    this.element.textContent = "";
  }

  destroy(): void {
    this.element.remove();
  }

  private applyStyles(): void {
    this.element.style.display = this.options.visible ? "block" : "none";
    this.element.style.fontSize = `${Math.max(50, Math.min(250, this.options.fontSizePct))}%`;
    this.element.style.fontFamily = this.options.fontFamily;
  }
}
