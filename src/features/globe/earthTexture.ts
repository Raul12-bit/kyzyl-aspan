import type { CountryShape } from '@/domain/countries';

/**
 * Paints the planet as an equirectangular canvas: deep-night ocean, land as a dot matrix (the
 * signature look of the brand globe), faint country borders and a warm terminator-free palette.
 * Dots are spaced by true ground distance (x step grows with 1/cos(lat)), so they stay round and
 * evenly spread once wrapped on the sphere instead of bunching up at the poles.
 */
export interface TexturePalette {
  ocean: [string, string];
  land: string;
  dot: string;
  border: string;
}

export const PALETTE: TexturePalette = {
  ocean: ['#081022', '#04070f'],
  land: '#0f182c',
  dot: '#5a6f9c',
  border: 'rgba(170, 190, 230, 0.22)',
};

function tracePolys(ctx: CanvasRenderingContext2D, polys: CountryShape['polys'], w: number, h: number, shift: number) {
  const sx = w / 360;
  const sy = h / 180;
  for (const rings of polys) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const x = (ring[i]! + 180 + shift) * sx;
        const y = (90 - ring[i + 1]!) * sy;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
  }
}

/** Draws every country twice (lng and lng − 360) so outlines unwrapped past 180° still land on the canvas. */
function traceAll(ctx: CanvasRenderingContext2D, countries: readonly CountryShape[], w: number, h: number) {
  ctx.beginPath();
  for (const c of countries) {
    tracePolys(ctx, c.polys, w, h, 0);
    tracePolys(ctx, c.polys, w, h, -360);
  }
}

export function paintEarth(countries: readonly CountryShape[], width: number): HTMLCanvasElement {
  const w = width;
  const h = width / 2;

  // 1) Land mask at a lower resolution — only used to decide where the dots go.
  const maskW = Math.min(1024, w);
  const maskH = maskW / 2;
  const mask = document.createElement('canvas');
  mask.width = maskW;
  mask.height = maskH;
  const mctx = mask.getContext('2d', { willReadFrequently: true })!;
  mctx.fillStyle = '#000';
  mctx.fillRect(0, 0, maskW, maskH);
  mctx.fillStyle = '#fff';
  traceAll(mctx, countries, maskW, maskH);
  mctx.fill('evenodd');
  const data = mctx.getImageData(0, 0, maskW, maskH).data;
  const isLand = (u: number, v: number) => {
    const x = Math.min(maskW - 1, Math.max(0, Math.floor(u * maskW)));
    const y = Math.min(maskH - 1, Math.max(0, Math.floor(v * maskH)));
    return data[(y * maskW + x) * 4]! > 127;
  };

  // 2) The texture itself.
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const ocean = ctx.createLinearGradient(0, 0, 0, h);
  ocean.addColorStop(0, PALETTE.ocean[1]);
  ocean.addColorStop(0.5, PALETTE.ocean[0]);
  ocean.addColorStop(1, PALETTE.ocean[1]);
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = PALETTE.land;
  traceAll(ctx, countries, w, h);
  ctx.fill('evenodd');

  // Dot matrix over land.
  // Rows every ≈1.2° (large texture) or ≈1.8° (small texture) of latitude.
  const step = w / (w >= 2048 ? 300 : 200);
  const radius = step * 0.3;
  ctx.fillStyle = PALETTE.dot;
  for (let row = 0, y = step / 2; y < h; row++, y += step) {
    const lat = 90 - (y / h) * 180;
    const stretch = 1 / Math.max(0.12, Math.cos((lat * Math.PI) / 180));
    const dx = step * stretch;
    const offset = row % 2 ? dx / 2 : 0;
    for (let x = offset; x < w; x += dx) {
      if (!isLand(x / w, y / h)) continue;
      ctx.beginPath();
      ctx.ellipse(x, y, radius * stretch, radius, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Borders last, hairline.
  ctx.strokeStyle = PALETTE.border;
  ctx.lineWidth = Math.max(1, w / 2048);
  traceAll(ctx, countries, w, h);
  ctx.stroke();
  return canvas;
}

/** Plain ocean with a faint graticule — shown until the country outlines arrive. */
export function paintPlaceholder(width: number): HTMLCanvasElement {
  const w = width;
  const h = width / 2;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = PALETTE.ocean[0];
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(170,190,230,0.08)';
  ctx.lineWidth = 1;
  for (let lng = -180; lng <= 180; lng += 30) {
    const x = ((lng + 180) / 360) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  return canvas;
}
