import { useEffect, useRef } from 'react';

/** Deterministic star field behind the transparent globe canvas. Drawn once per resize. */
export function Starfield({ visible }: { visible: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Two faint nebula washes: cool (instruments) low-left, warm (fire) high-right.
      const cool = ctx.createRadialGradient(w * 0.08, h * 0.95, 0, w * 0.08, h * 0.95, Math.max(w, h) * 0.6);
      cool.addColorStop(0, 'rgba(61, 219, 217, 0.05)');
      cool.addColorStop(1, 'rgba(61, 219, 217, 0)');
      ctx.fillStyle = cool;
      ctx.fillRect(0, 0, w, h);
      const warm = ctx.createRadialGradient(w * 0.82, h * 0.1, 0, w * 0.82, h * 0.1, Math.max(w, h) * 0.5);
      warm.addColorStop(0, 'rgba(255, 138, 61, 0.035)');
      warm.addColorStop(1, 'rgba(255, 138, 61, 0)');
      ctx.fillStyle = warm;
      ctx.fillRect(0, 0, w, h);

      let seed = 1337;
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const count = Math.round((w * h) / 2400);
      for (let i = 0; i < count; i++) {
        const x = rnd() * w;
        const y = rnd() * h;
        const r = rnd() ** 3 * 1.25 + 0.25;
        const a = 0.18 + rnd() * 0.62;
        const tint = rnd();
        ctx.fillStyle = tint > 0.92 ? `rgba(190, 200, 255, ${a})` : tint < 0.04 ? `rgba(255, 214, 170, ${a})` : `rgba(232, 236, 244, ${a})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (r > 1.15) {
          ctx.fillStyle = `rgba(232, 236, 244, ${a * 0.12})`;
          ctx.beginPath();
          ctx.arc(x, y, r * 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: -1, opacity: visible ? 1 : 0, transition: 'opacity 600ms var(--el-ease-standard)' }}
    />
  );
}
