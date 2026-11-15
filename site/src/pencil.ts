// The pencil-on-paper kit from the TARS film, trimmed to what this page draws: the sheet, the paper
// tooth, a wobbly graphite stroke and hatching. Every mark is a pure function of its seed.
export const PAPER = "#F2F0EB";
export const GRAPHITE = "#3A3936";

type Pt = [number, number];

function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (i: number, seed = 0) => rng((i * 2654435761) ^ (seed * 40503))();
function noise1(x: number, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash(i, seed);
  return (a + (hash(i + 1, seed) - a) * u) * 2 - 1;
}

const sheet = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!] as const;
};

/** The sheet: flat paper with faint brightness noise and a few hundred fibres. Made once per size. */
export function makePaper(w: number, h: number) {
  const [c, g] = sheet(w, h);
  g.fillStyle = PAPER;
  g.fillRect(0, 0, w, h);
  const im = g.getImageData(0, 0, w, h);
  const r = rng(11);
  for (let i = 0; i < im.data.length; i += 4) {
    const v = (r() + r() - 1) * 5;
    im.data[i]! += v;
    im.data[i + 1]! += v;
    im.data[i + 2]! += v;
  }
  g.putImageData(im, 0, 0);
  g.strokeStyle = "rgba(120,108,90,0.035)";
  g.lineWidth = 1;
  for (let i = 0; i < 500; i++) {
    const x = r() * w;
    const y = r() * h;
    const a = r() * Math.PI;
    const l = 6 + r() * 22;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + (r() - 0.5) * 6, y + Math.sin(a) * l * 0.5 + (r() - 0.5) * 6, x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  return c;
}

/** Paper-coloured specks drawn over pencil marks so graphite breaks up like it does on a real sheet. */
export function makeTooth(w: number, h: number) {
  const [c, g] = sheet(w, h);
  const im = g.createImageData(w, h);
  const r = rng(29);
  for (let i = 0; i < im.data.length; i += 4) {
    if (r() > 0.17) continue;
    im.data[i] = 242;
    im.data[i + 1] = 240;
    im.data[i + 2] = 235;
    im.data[i + 3] = 70 + r() * 110;
  }
  g.putImageData(im, 0, 0);
  return c;
}

function resample(pts: Pt[], step: number) {
  const out: [number, number, number, number, number][] = [];
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[i + 1]!;
    const d = Math.hypot(bx - ax, by - ay);
    if (d < 1e-6) continue;
    const nx = -(by - ay) / d;
    const ny = (bx - ax) / d;
    const n = Math.max(1, Math.round(d / step));
    for (let k = i ? 1 : 0; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, nx, ny, s + (d * k) / n]);
    s += d;
  }
  return out;
}

type StrokeOpts = { seed?: number; w?: number; color?: string; alpha?: number; wob?: number };

/** One pencil line: a firm pass and a lighter second pass that misses it slightly. */
export function stroke(ctx: CanvasRenderingContext2D, pts: Pt[], { seed = 1, w = 2.6, color = GRAPHITE, alpha = 0.92, wob = 1.2 }: StrokeOpts = {}) {
  const P = resample(pts, 7);
  if (P.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [k, a, lw, amp] of [
    [0, alpha, w, wob],
    [1, alpha * 0.38, w * 0.55, wob * 2.3],
  ] as const) {
    ctx.beginPath();
    P.forEach(([x, y, nx, ny, s], i) => {
      const o = (noise1(s / 36, seed * 13 + k * 101) + 0.7 * noise1(s / 150, seed * 7 + k * 53)) * amp;
      if (i) ctx.lineTo(x + nx * o, y + ny * o);
      else ctx.moveTo(x + nx * o, y + ny * o);
    });
    ctx.globalAlpha = a;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
  ctx.restore();
}

/** Parallel pencil strokes filling a box. */
export function hatch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, { angle = -0.9, gap = 7, seed = 1 } = {}) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const R = Math.hypot(w, h) / 2;
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  for (let d = -R, i = 0; d <= R; d += gap, i++) {
    const j = (hash(i, seed) - 0.5) * gap * 0.5;
    const l = R * (0.9 + hash(i, seed + 3) * 0.2);
    const px = cx - s * (d + j);
    const py = cy + c * (d + j);
    stroke(ctx, [[px - c * l, py - s * l], [px + c * l, py + s * l]], { seed: seed + i, w: 1.5, alpha: 0.6, wob: 0.8 });
  }
  ctx.restore();
}
