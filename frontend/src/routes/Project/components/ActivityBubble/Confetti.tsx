import { useEffect, useRef } from 'react';

const PARTICLES = 40;
const DURATION_MS = 900;
const GRAVITY = 0.0009; // px per ms²
const COLORS = ['#22c55e', '#3b82f6', '#eab308', '#ec4899', '#a855f7', '#14b8a6'];
const SIZE = 160;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  spin: number;
  color: string;
}

function burst(): Particle[] {
  return Array.from({ length: PARTICLES }, (_, i) => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
    const speed = 0.18 + Math.random() * 0.22;
    return {
      x: SIZE / 2,
      y: SIZE * 0.7,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.02,
      color: COLORS[i % COLORS.length],
    };
  });
}

/**
 * A small one-shot confetti burst over the bubble when something succeeds. Canvas, no
 * dependency; the caller unmounts it after the burst and skips it under prefers-reduced-motion.
 */
export function Confetti() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const particles = burst();
    const start = performance.now();
    let frame = 0;
    const draw = (t: number) => {
      const elapsed = t - start;
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.globalAlpha = Math.max(0, 1 - elapsed / DURATION_MS);
      particles.forEach((p) => {
        const x = p.x + p.vx * elapsed;
        const y = p.y + p.vy * elapsed + GRAVITY * elapsed * elapsed;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.rotation + p.spin * elapsed);
        ctx.fillStyle = p.color;
        ctx.fillRect(-3, -1.5, 6, 3);
        ctx.restore();
      });
      if (elapsed < DURATION_MS) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      aria-hidden
      className="absolute pointer-events-none"
      style={{ width: SIZE, height: SIZE, right: -SIZE / 2 + 20, bottom: -20 }}
    />
  );
}
