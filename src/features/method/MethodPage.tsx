import { useEffect } from 'react';
import { Logo } from '@/app/Logo';
import { useI18n } from '@/i18n';
import { ButtonLink, Icon, type IconName } from '@/ui';

const STEP_ICONS: IconName[] = ['shield', 'layers', 'compare', 'sparkles'];

/** Step 2 illustrated: one MODIS pixel, a 3×3 patch of VIIRS pixels, and the hexagon both fall into. */
function PixelsToHexagon() {
  const hex = (cx: number, cy: number, r: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
  return (
    <svg viewBox="0 0 320 120" className="block h-auto w-full" aria-hidden>
      {/* MODIS: one coarse pixel */}
      <rect x="18" y="26" width="68" height="68" rx="3" fill="color-mix(in srgb, var(--el-modis) 14%, transparent)" stroke="var(--el-modis)" strokeWidth="1.5" />
      <text x="52" y="112" textAnchor="middle" fontSize="10" fill="var(--el-modis)" fontFamily="var(--el-font-mono)">
        MODIS 1 km
      </text>
      {/* VIIRS: small pixels, six of them hot */}
      {Array.from({ length: 9 }, (_, i) => {
        const x = 118 + (i % 3) * 23;
        const y = 26 + Math.floor(i / 3) * 23;
        const hot = [0, 1, 3, 4, 5, 7].includes(i);
        return (
          <rect key={i} x={x} y={y} width="20" height="20" rx="2" fill={hot ? 'color-mix(in srgb, var(--el-viirs) 32%, transparent)' : 'transparent'} stroke="var(--el-viirs)" strokeOpacity={hot ? 1 : 0.35} />
        );
      })}
      <text x="152" y="112" textAnchor="middle" fontSize="10" fill="var(--el-viirs)" fontFamily="var(--el-font-mono)">
        VIIRS 375 m
      </text>
      <path d="M200 60h22m-6-5 6 5-6 5" stroke="var(--el-ink-dim)" fill="none" strokeWidth="1.5" strokeLinecap="round" />
      {/* the hexagon: one burning hexagon-day for both */}
      <polygon points={hex(268, 60, 40)} fill="color-mix(in srgb, var(--el-orange) 22%, transparent)" stroke="var(--el-orange)" strokeWidth="1.8" />
      <text x="268" y="58" textAnchor="middle" fontSize="18" fill="var(--el-amber-soft)" fontFamily="var(--el-font-mono)">
        1
      </text>
      <text x="268" y="74" textAnchor="middle" fontSize="8.5" fill="var(--el-ink-muted)" fontFamily="var(--el-font-mono)">
        H3
      </text>
    </svg>
  );
}

/** /method — how the pipeline works, its rules and its limits. */
export function MethodPage() {
  const { m } = useI18n();
  useEffect(() => {
    document.title = `${m.app.nav.method} — ${m.app.name}`;
  }, [m]);

  return (
    <main id="main" className="page">
      <div className="page-inner">
        <header className="max-w-[780px]" style={{ animation: 'el-float-in 700ms var(--el-ease-emphasized) both' }}>
          <p className="eyebrow m-0">{m.method.eyebrow}</p>
          <h1 className="display m-0 mt-4 text-[clamp(2rem,3.4vw+0.8rem,3.6rem)] text-ink">{m.method.title}</h1>
          <div className="orbit-rule mt-6 w-24" aria-hidden />
          <p className="m-0 mt-5 max-w-[62ch] text-[16px] leading-relaxed text-ink-muted md:text-[17px]">{m.method.lead}</p>
        </header>

        <ol className="m-0 mt-12 grid list-none gap-4 p-0 md:grid-cols-2">
          {m.method.steps.map((step, i) => (
            <li
              key={step.title}
              className="card relative overflow-hidden p-6 md:p-7"
              style={{ animation: `el-float-in 700ms var(--el-ease-emphasized) ${120 + i * 90}ms both` }}
            >
              <span aria-hidden className="display pointer-events-none absolute -right-2 -top-6 text-[110px] text-[rgb(255_255_255/0.035)]">
                {i + 1}
              </span>
              <span className="grid h-10 w-10 place-items-center rounded-[12px] border border-[rgb(255_82_54/0.35)] bg-[rgb(255_82_54/0.08)] text-kyzyl">
                <Icon name={STEP_ICONS[i] ?? 'info'} size={20} />
              </span>
              <h2 className="m-0 mt-4 text-[19px] font-semibold tracking-[-0.01em] text-ink">
                <span className="num mr-2 text-[13px] text-kyzyl">0{i + 1}</span>
                {step.title}
              </h2>
              <p className="m-0 mt-2.5 text-[14.5px] leading-relaxed text-ink-muted">{step.body}</p>
              {i === 1 ? (
                <div className="mt-5 rounded-[14px] border border-line bg-[var(--el-inset)] p-3">
                  <PixelsToHexagon />
                </div>
              ) : null}
            </li>
          ))}
        </ol>

        <section className="mt-16" aria-labelledby="principles">
          <h2 id="principles" className="display m-0 text-[clamp(1.3rem,1.2vw+0.9rem,1.8rem)] text-ink">
            {m.method.principles.title}
          </h2>
          <ul className="m-0 mt-6 grid list-none gap-4 p-0 md:grid-cols-3">
            {m.method.principles.items.map((p) => (
              <li key={p.title} className="border-t-2 border-[var(--el-kyzyl)] pt-4">
                <h3 className="m-0 text-[16px] font-semibold text-ink">{p.title}</h3>
                <p className="m-0 mt-2 text-[14px] leading-relaxed text-ink-muted">{p.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <div className="mt-16 grid gap-10 md:grid-cols-2">
          <section aria-labelledby="limits">
            <h2 id="limits" className="m-0 text-[18px] font-semibold text-ink">
              {m.method.limits.title}
            </h2>
            <ul className="m-0 mt-4 grid list-none gap-3 p-0">
              {m.method.limits.items.map((l) => (
                <li key={l} className="flex gap-3 text-[14px] leading-relaxed text-ink-muted">
                  <Icon name="alert" size={16} className="mt-1 flex-none text-trust-medium" />
                  {l}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="sources">
            <h2 id="sources" className="m-0 text-[18px] font-semibold text-ink">
              {m.method.sources.title}
            </h2>
            <ul className="m-0 mt-4 grid list-none gap-3 p-0">
              {m.method.sources.items.map((s) => (
                <li key={s.name} className="rounded-[14px] border border-line px-4 py-3">
                  <p className="m-0 text-[14px] font-medium text-ink">{s.name}</p>
                  <p className="m-0 mt-0.5 text-[12.5px] text-ink-dim">{s.note}</p>
                </li>
              ))}
            </ul>
            <a
              href="https://firms.modaps.eosdis.nasa.gov/"
              target="_blank"
              rel="noreferrer noopener"
              className="mt-4 inline-flex items-center gap-1.5 text-[13.5px] font-medium text-amber underline-offset-4 hover:underline"
            >
              {m.method.sources.link}
              <Icon name="arrowRight" size={14} />
            </a>
          </section>
        </div>

        <div className="mt-16 flex flex-col items-start justify-between gap-6 rounded-panel border border-line bg-[var(--el-tint-1)] p-6 md:flex-row md:items-center md:p-8">
          <span role="img" aria-label={m.app.name}>
            <Logo size={64} />
          </span>
          <ButtonLink to="/map" variant="primary" size="lg" iconRight="arrowRight">
            {m.method.cta}
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}
