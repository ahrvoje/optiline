/** Canvas 2D renderer for the shared ordered display list. */
import { applyAffine, worldToScreenMatrix } from "@/renderer/camera";
import { BACKGROUND_COLOR, buildDisplayList } from "@/renderer/display-list";
import { TessellationCache } from "@/renderer/ph-tessellate";
import type { RenderScene, TrackRenderer } from "@/renderer/scene";

export class Canvas2DRenderer implements TrackRenderer {
  readonly kind = "canvas2d" as const;
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #cache = new TessellationCache();

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.#canvas = canvas;
    this.#ctx = ctx;
  }

  render(scene: RenderScene): void {
    const rect = this.#canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    const pixelW = Math.round(width * dpr), pixelH = Math.round(height * dpr);
    if (this.#canvas.width !== pixelW || this.#canvas.height !== pixelH) {
      this.#canvas.width = pixelW; this.#canvas.height = pixelH;
    }
    const ctx = this.#ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BACKGROUND_COLOR; ctx.fillRect(0, 0, width, height);
    const m = worldToScreenMatrix(scene.camera, width, height);
    for (const primitive of buildDisplayList(scene, width, height, this.#cache)) {
      if (primitive.kind === "line") {
        if (primitive.pts.length < 4) continue;
        ctx.beginPath();
        for (let i = 0; i + 1 < primitive.pts.length; i += 2) {
          const p = applyAffine(m, primitive.pts[i]!, primitive.pts[i + 1]!);
          if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        }
        ctx.strokeStyle = primitive.color; ctx.lineWidth = primitive.widthPx;
        ctx.setLineDash(primitive.dash ?? []); ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
      } else {
        ctx.fillStyle = primitive.color; ctx.setLineDash([]);
        for (let i = 0; i + 5 < primitive.tris.length; i += 6) {
          const a = applyAffine(m, primitive.tris[i]!, primitive.tris[i + 1]!);
          const b = applyAffine(m, primitive.tris[i + 2]!, primitive.tris[i + 3]!);
          const c = applyAffine(m, primitive.tris[i + 4]!, primitive.tris[i + 5]!);
          ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.lineTo(c[0],c[1]);ctx.closePath();ctx.fill();
        }
      }
    }
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.font="700 12px system-ui";ctx.textBaseline="middle";
    for (const label of scene.labels) {const p=applyAffine(m,label.x,label.y),x=p[0]+10,y=p[1]-13,w=ctx.measureText(label.text).width;ctx.fillStyle="#0c1015dd";ctx.fillRect(x-4,y-9,w+8,18);ctx.fillStyle="#f6f8fa";ctx.fillText(label.text,x,y);}
  }

  dispose(): void { /* no retained GPU resources */ }
}
