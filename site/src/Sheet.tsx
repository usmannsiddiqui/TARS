// The sheet of paper behind the page, with TARS standing on it. TARS is the film's own pencil
// renders: a short run of poses (the outer slabs opening) scrubbed by moving the pointer left and
// right, eyes drawn here so they can follow the pointer and blink, and the held pose redrawn eight
// times a second so the lines boil instead of sitting dead.
import { useEffect, useRef } from "react";
import { hatch, makePaper, makeTooth, stroke, PAPER } from "./pencil";

const POSES = ["a0", "a4", "a8", "a12", "a16", "a20", "a24", "a28"];
const REST = ["a4", "a4_2", "a4_3"]; // the same pose with three line seeds, cycled while it is held
const SENSITIVITY = 0.8; // a full sweep of the window moves 80% of the way through the poses
const BOIL_PER_SECOND = 8;
const src = (name: string) => `${import.meta.env.BASE_URL}tars/${name}.png`;

type Eyes = { eyes: [number, number][]; rx: number; ry: number; look: number; feet: number; aspect: number };

const load = (name: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src(name);
  });

export default function Sheet() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let images: Record<string, HTMLImageElement> = {};
    let eyes: Eyes | null = null;
    let paper: HTMLCanvasElement | null = null;
    let tooth: HTMLCanvasElement | null = null;
    let dpr = 1;
    let W = 0;
    let H = 0;
    let target = 1 / (POSES.length - 1); // starts at the rest pose
    let value = target;
    let prevX: number | null = null;
    let pointerX = Number.NaN;
    let last = "";
    let frame = 0;
    let alive = true;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      paper = makePaper(canvas.width, canvas.height);
      tooth = makeTooth(canvas.width, canvas.height);
      last = "";
    };

    const onMove = (e: PointerEvent) => {
      if (prevX !== null) target = Math.min(1, Math.max(0, target + ((e.clientX - prevX) / window.innerWidth) * SENSITIVITY));
      prevX = e.clientX;
      pointerX = e.clientX;
    };

    const draw = (now: number) => {
      if (!alive) return;
      frame = requestAnimationFrame(draw);
      if (!paper || !tooth) return;
      value += (target - value) * (still ? 1 : 0.18);
      const pose = Math.round(value * (POSES.length - 1));
      const boil = still ? 0 : Math.floor((now / 1000) * BOIL_PER_SECOND);
      // Wide screens: TARS stands right of centre with the words on the left. Narrow: TARS above the words.
      const wide = W >= 768;
      const h = wide ? Math.min(H * 0.76, W * 0.56) : Math.min(H * 0.46, W * 0.95);
      const cx = wide ? W * 0.72 : W * 0.5;
      const feet = wide ? H * 0.5 + h * 0.46 : H * 0.12 + h * 0.86;
      const look = Number.isNaN(pointerX) ? 0 : Math.max(-1, Math.min(1, (pointerX - cx) / (W * 0.45)));
      const blink = !still && (now / 1000 + 1.3) % 3.4 < 0.13;
      const key = [pose, boil, look.toFixed(2), blink, W, H].join("|");
      if (key === last) return; // nothing on the sheet changed
      last = key;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(paper, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (eyes) {
        // The ground line and a short hatched shadow, drawn like the film's.
        hatch(ctx, cx - h * 0.16, feet + 3, h * 0.6, 15, { angle: -0.5, gap: 6, seed: 80 + boil });
        stroke(ctx, [[cx - h * 0.46, feet], [cx + h * 0.46, feet]], { seed: 5 + boil, w: 2.2 });
        const name = pose === 1 ? REST[boil % REST.length]! : POSES[pose]!;
        const im = images[name];
        const w = h * eyes.aspect;
        const x = cx - w / 2;
        const y = feet - h * eyes.feet;
        if (im) {
          ctx.drawImage(im, x, y, w, h);
          ctx.fillStyle = PAPER;
          for (const [ex, ey] of eyes.eyes) {
            ctx.beginPath();
            ctx.ellipse(x + (ex + look * eyes.look) * w, y + ey * h, eyes.rx * w, eyes.ry * h * (blink ? 0.12 : 1), 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      // Paper tooth over everything drawn, last.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.55;
      ctx.drawImage(tooth, 0, 0);
      ctx.globalAlpha = 1;
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove);
    frame = requestAnimationFrame(draw);
    void Promise.all([fetch(`${import.meta.env.BASE_URL}tars/eyes.json`).then((r) => r.json() as Promise<Eyes>), ...[...POSES, ...REST.slice(1)].map((n) => load(n).then((im) => [n, im] as const))]).then(
      ([e, ...loaded]) => {
        eyes = e;
        images = Object.fromEntries(loaded);
        last = "";
      },
      () => undefined, // the sheet stays plain paper if the drawings cannot load; the words still work
    );
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="fixed inset-0 z-0 h-full w-full" />;
}
