import { useI18n } from '@/i18n';
import { cssEase, TIMELINE } from './transition.config';

/** Fixed glowing points on the static sphere (percent of the sphere box). */
const DOTS: [number, number, number][] = [
  [58, 30, 1], [62, 34, 0.7], [55, 36, 0.8], [66, 29, 0.6], [70, 38, 0.5], [48, 44, 0.45], [40, 58, 0.7],
  [44, 62, 0.55], [30, 52, 0.4], [72, 60, 0.5], [76, 66, 0.35], [52, 70, 0.4], [36, 40, 0.3], [64, 48, 0.4],
];

/**
 * Shown when WebGL / the globe projection is unavailable: a soft static sphere that still dives
 * into the same white flash, so the story stays identical.
 */
export function FallbackGlobe({ diving }: { diving: boolean }) {
  const { m } = useI18n();
  const t = TIMELINE.fallback.zoom;
  return (
    <div className="pointer-events-none fixed inset-0 grid place-items-center lg:pl-[44vw]" aria-hidden={false}>
      <div
        role="img"
        aria-label={m.intro.noGlobe}
        className="relative aspect-square w-[min(72vw,560px)] max-lg:-translate-y-[18vh]"
        style={{
          transform: diving ? 'scale(3.4)' : 'scale(1)',
          transition: diving ? `transform ${t.duration}ms ${cssEase(t.easing)}` : 'none',
        }}
      >
        <div
          className="absolute inset-[-8%] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(120,170,255,0.16) 52%, rgba(61,219,217,0.06) 60%, transparent 70%)' }}
        />
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              'radial-gradient(circle at 34% 28%, #1c2a48 0%, #111a2e 32%, #0a1020 58%, #05070d 80%), #0a1020',
            boxShadow: 'inset -24px -30px 60px rgba(0,0,0,0.65), inset 10px 12px 40px rgba(154,166,255,0.08), 0 0 80px rgba(80,120,200,0.18)',
          }}
        />
        {DOTS.map(([x, y, w], i) => (
          <span
            key={i}
            className="absolute rounded-full"
            style={{
              left: `${x}%`,
              top: `${y}%`,
              width: 4 + w * 6,
              height: 4 + w * 6,
              transform: 'translate(-50%, -50%)',
              background: 'var(--el-amber-soft)',
              boxShadow: `0 0 ${10 + w * 22}px ${4 + w * 6}px rgba(255, 122, 47, ${0.25 + w * 0.3})`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
