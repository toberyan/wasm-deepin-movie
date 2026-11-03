export type FitMode = "contain" | "cover" | "fill" | "original";
export type ScaleMode = "nearest" | "bilinear" | "high-quality";
export type RotationDeg = 0 | 90 | 180 | 270;

export interface CropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RenderSettings {
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  hueDeg: number;
  rotationDeg: RotationDeg;
  crop: CropRect;
  sharpness: number;
  scaleMode: ScaleMode;
  fit: FitMode;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  gamma: 1,
  hueDeg: 0,
  rotationDeg: 0,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
  sharpness: 0,
  scaleMode: "high-quality",
  fit: "contain"
};

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
uniform vec2 uScale;
out vec2 vUv;
void main() {
  gl_Position = vec4(aPos * uScale, 0.0, 1.0);
  vUv = vec2((aPos.x + 1.0) * 0.5, 1.0 - (aPos.y + 1.0) * 0.5);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uGamma;
uniform float uHue;
uniform vec4 uCrop;
uniform int uRotation;
uniform float uSharpness;
uniform vec2 uTexel;
out vec4 outColor;

vec3 hueShift(vec3 color, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  mat3 m = mat3(
    0.213 + c * 0.787 - s * 0.213,
    0.213 - c * 0.213 + s * 0.143,
    0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 - s * 0.715,
    0.715 + c * 0.285 + s * 0.140,
    0.715 - c * 0.715 + s * 0.715,
    0.072 - c * 0.072 + s * 0.928,
    0.072 - c * 0.072 - s * 0.283,
    0.072 + c * 0.928 + s * 0.072
  );
  return m * color;
}

void main() {
  vec2 uv = vec2(
    uCrop.x + vUv.x * (1.0 - uCrop.x - uCrop.z),
    uCrop.y + vUv.y * (1.0 - uCrop.y - uCrop.w)
  );
  if (uRotation == 90) {
    uv = vec2(uv.y, 1.0 - uv.x);
  } else if (uRotation == 180) {
    uv = 1.0 - uv;
  } else if (uRotation == 270) {
    uv = vec2(1.0 - uv.y, uv.x);
  }
  vec4 tex = texture(uTexture, uv);
  vec3 color = tex.rgb;
  if (uSharpness > 0.0) {
    vec3 blur = (
      texture(uTexture, uv + vec2(uTexel.x, 0.0)).rgb +
      texture(uTexture, uv - vec2(uTexel.x, 0.0)).rgb +
      texture(uTexture, uv + vec2(0.0, uTexel.y)).rgb +
      texture(uTexture, uv - vec2(0.0, uTexel.y)).rgb
    ) * 0.25;
    color += (color - blur) * uSharpness * 2.0;
  }
  color = (color - 0.5) * uContrast + 0.5;
  color += uBrightness;
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, uSaturation);
  color = hueShift(color, radians(uHue));
  color = pow(max(color, vec3(0.0)), vec3(1.0 / max(uGamma, 0.0001)));
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("failed to create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failed: ${log ?? "unknown error"}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("failed to create WebGL program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${log ?? "unknown error"}`);
  }
  return program;
}

function fitScale(
  mode: FitMode,
  canvasWidth: number,
  canvasHeight: number,
  videoWidth: number,
  videoHeight: number
): [number, number] {
  if (mode === "fill") return [1, 1];
  if (mode === "original") {
    return [videoWidth / canvasWidth, videoHeight / canvasHeight];
  }
  const canvasAspect = canvasWidth / canvasHeight;
  const videoAspect = videoWidth / videoHeight;
  if (mode === "cover") {
    if (canvasAspect > videoAspect) return [1, canvasAspect / videoAspect];
    return [videoAspect / canvasAspect, 1];
  }
  if (canvasAspect > videoAspect) return [videoAspect / canvasAspect, 1];
  return [1, canvasAspect / videoAspect];
}

export class WebGL2Renderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private texture: WebGLTexture | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private textureWidth = 0;
  private textureHeight = 0;
  private readonly frameCanvas = document.createElement("canvas");
  private readonly frameContext = this.frameCanvas.getContext("2d", { alpha: false });
  private lost = false;
  private settings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
    this.init();
  }

  setSettings(settings: Partial<RenderSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  getSettings(): RenderSettings {
    return { ...this.settings };
  }

  resize(width: number, height: number, dpr = 1): void {
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
  }

  render(frame: VideoFrame): void {
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    let source: TexImageSource = frame;
    if (
      this.frameContext &&
      (frame.codedWidth !== width || frame.codedHeight !== height)
    ) {
      if (this.frameCanvas.width !== width) this.frameCanvas.width = width;
      if (this.frameCanvas.height !== height) this.frameCanvas.height = height;
      this.frameContext.drawImage(frame, 0, 0, width, height);
      source = this.frameContext.getImageData(0, 0, width, height);
    }
    this.drawSource(source, width, height);
  }

  renderImage(image: ImageData): void {
    this.drawSource(image, image.width, image.height);
  }

  private drawSource(source: TexImageSource, width: number, height: number): void {
    const gl = this.gl;
    if (!gl || this.lost) return;
    const program = this.program;
    if (!program) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (width !== this.textureWidth || height !== this.textureHeight) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.textureWidth = width;
      this.textureHeight = height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    const crop = this.settings.crop;
    const visibleWidth = width * (1 - crop.left - crop.right);
    const visibleHeight = height * (1 - crop.top - crop.bottom);
    const swapped = this.settings.rotationDeg === 90 || this.settings.rotationDeg === 270;
    const fitWidth = swapped ? visibleHeight : visibleWidth;
    const fitHeight = swapped ? visibleWidth : visibleHeight;
    const [scaleX, scaleY] = fitScale(
      this.settings.fit,
      this.canvas.width,
      this.canvas.height,
      fitWidth,
      fitHeight
    );
    const filter = this.settings.scaleMode === "nearest" ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.uniform2f(this.uniforms.uScale ?? null, scaleX, scaleY);
    gl.uniform1f(this.uniforms.uBrightness ?? null, this.settings.brightness);
    gl.uniform1f(this.uniforms.uContrast ?? null, this.settings.contrast);
    gl.uniform1f(this.uniforms.uSaturation ?? null, this.settings.saturation);
    gl.uniform1f(this.uniforms.uGamma ?? null, this.settings.gamma);
    gl.uniform1f(this.uniforms.uHue ?? null, this.settings.hueDeg);
    gl.uniform4f(
      this.uniforms.uCrop ?? null,
      crop.left,
      crop.top,
      crop.right,
      crop.bottom
    );
    gl.uniform1i(this.uniforms.uRotation ?? null, this.settings.rotationDeg);
    gl.uniform1f(this.uniforms.uSharpness ?? null, this.settings.sharpness);
    gl.uniform2f(
      this.uniforms.uTexel ?? null,
      width > 0 ? 1 / width : 0,
      height > 0 ? 1 / height : 0
    );
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  async capture(format: "png" | "jpeg" = "png", quality?: number): Promise<Blob> {
    const gl = this.gl;
    if (!gl) throw new Error("WebGL context is unavailable");
    const width = this.canvas.width;
    const height = this.canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const source = document.createElement("canvas");
    source.width = width;
    source.height = height;
    const context = source.getContext("2d");
    if (!context) throw new Error("2D canvas is unavailable for capture");
    const image = context.createImageData(width, height);
    for (let y = 0; y < height; y += 1) {
      const sourceRow = (height - 1 - y) * width * 4;
      const targetRow = y * width * 4;
      image.data.set(pixels.subarray(sourceRow, sourceRow + width * 4), targetRow);
    }
    context.putImageData(image, 0, 0);
    return new Promise<Blob>((resolve, reject) => {
      source.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("failed to encode screenshot"));
        },
        format === "jpeg" ? "image/jpeg" : "image/png",
        quality
      );
    });
  }

  destroy(): void {
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.disposeResources();
    this.gl = null;
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
    this.disposeResources();
  };

  private readonly handleContextRestored = (): void => {
    this.lost = false;
    this.init();
  };

  private init(): void {
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      desynchronized: true
    });
    if (!gl) throw new Error("WebGL2 is unavailable");
    this.gl = gl;
    this.program = createProgram(gl);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("failed to create WebGL vertex array");
    this.vao = vao;
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    const location = gl.getAttribLocation(this.program, "aPos");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const texture = gl.createTexture();
    if (!texture) throw new Error("failed to create WebGL texture");
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTexture"), 0);
    this.uniforms = {
      uScale: gl.getUniformLocation(this.program, "uScale"),
      uBrightness: gl.getUniformLocation(this.program, "uBrightness"),
      uContrast: gl.getUniformLocation(this.program, "uContrast"),
      uSaturation: gl.getUniformLocation(this.program, "uSaturation"),
      uGamma: gl.getUniformLocation(this.program, "uGamma"),
      uHue: gl.getUniformLocation(this.program, "uHue"),
      uCrop: gl.getUniformLocation(this.program, "uCrop"),
      uRotation: gl.getUniformLocation(this.program, "uRotation"),
      uSharpness: gl.getUniformLocation(this.program, "uSharpness"),
      uTexel: gl.getUniformLocation(this.program, "uTexel")
    };
    this.textureWidth = 0;
    this.textureHeight = 0;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private disposeResources(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.texture = null;
    this.vao = null;
    this.program = null;
    this.uniforms = {};
    this.textureWidth = 0;
    this.textureHeight = 0;
  }
}
