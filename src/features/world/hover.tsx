import type { CSSProperties } from 'react';
import { LOCALE_INFO, useI18n } from '@/i18n';
import { SensorMark } from '@/ui';
import type { WorldHoverInfo } from './hoverInfo';

function Rows({ rows }: { rows: { k: string; v: string; tone?: string }[] }) {
  return (
    <dl className="m-0 mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
      {rows.map((r) => (
        <div key={r.k} className="contents">
          <dt className="text-ink-dim">{r.k}</dt>
          <dd className="num m-0 text-ink-muted" style={r.tone ? { color: r.tone } : undefined}>
            {r.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function WorldTooltip({ info, style }: { info: WorldHoverInfo; style: CSSProperties }) {
  const { m, fmt, locale } = useI18n();
  const t = m.world.tooltip;
  const box = 'glass pointer-events-none fixed min-w-[200px] max-w-[290px] px-3.5 py-2.5 text-[13px]';
  if (info.kind === 'foot') {
    const when = info.date
      ? `${new Intl.DateTimeFormat(LOCALE_INFO[locale].tag, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(new Date(`${info.date}T00:00:00Z`))} · ${info.time.slice(0, 2)}:${info.time.slice(2)} UTC`
      : '';
    return (
      <div role="status" className={box} style={style}>
        <div className="flex items-center gap-2 font-medium text-ink">
          <SensorMark kind={info.sensor} size={9} />
          {info.sensor} · {info.satellite}
        </div>
        <Rows
          rows={[
            { k: t.when, v: when },
            { k: m.map.tooltip.frp, v: `${fmt.dec(info.frp, 1)} MW` },
            { k: m.map.tooltip.confidence, v: m.map.tooltip.conf[info.confidence] },
            { k: t.pixel, v: t.pixelSize(fmt.dec(info.scan * 1000, 0), fmt.dec(info.track * 1000, 0)) },
          ]}
        />
        {info.truth !== 'fire' ? (
          <p className="m-0 mt-1.5 text-[11.5px] text-trust-low">
            {info.truth === 'static' ? m.map.noise.static : m.map.noise.lowConf}
          </p>
        ) : null}
      </div>
    );
  }
  const title = info.kind === 'region' ? info.name : fmt.country(info.iso2, info.iso2);
  return (
    <div role="status" className={box} style={style}>
      <div className="flex items-center gap-2 font-medium text-ink">
        <span aria-hidden className="h-3 w-3 rounded-[3px]" style={{ background: 'var(--el-ramp-4)' }} />
        {title}
      </div>
      {info.hexdays > 0 ? (
        <Rows
          rows={[
            { k: t.hexdays, v: fmt.int(info.hexdays) },
            { k: t.detections, v: fmt.int(info.detections) },
            ...(info.density !== null
              ? [{ k: t.density, v: fmt.pct(Math.min(info.density, 99), info.density < 0.1 ? 2 : 1) }]
              : []),
          ]}
        />
      ) : (
        <p className="m-0 mt-1 text-[12px] text-ink-dim">{t.none}</p>
      )}
      <p className="m-0 mt-1.5 text-[11.5px] text-ink-dim">
        {info.kind === 'region' ? t.clickRegion : m.map.tooltip.clickCountry}
      </p>
    </div>
  );
}
