import type { CSSProperties } from 'react';
import { LOCALE_INFO, useI18n } from '@/i18n';
import { PRIORITY_COLOR, STATIC_COLOR } from './heliosLayers';
import type { HeliosHoverInfo } from './hoverInfo';

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <>
      <dt className="text-ink-dim">{k}</dt>
      <dd className="num m-0 text-ink-muted" style={tone ? { color: tone } : undefined}>
        {v}
      </dd>
    </>
  );
}

export function HeliosTooltip({ info, style }: { info: HeliosHoverInfo; style: CSSProperties }) {
  const { m, fmt, locale } = useI18n();
  const t = m.helios.tooltip;
  let title = '';
  let dot = 'var(--el-amber)';
  let rows: { k: string; v: string; tone?: string }[] = [];
  let note: string | null = null;
  if (info.kind === 'risk') {
    title = `H3 · ${t.risk}: ${fmt.pct(info.p, info.p < 0.1 ? 1 : 0)}`;
    rows = [{ k: t.climatology, v: fmt.pct(info.clim, 1) }];
    if (info.actual >= 0)
      rows.push({
        k: '',
        v: info.actual === 1 ? t.burned : t.notBurned,
        tone: info.actual === 1 ? 'var(--el-mint)' : undefined,
      });
  } else if (info.kind === 'alert') {
    dot = PRIORITY_COLOR[info.priority]();
    title = t.alert(m.helios.priorities[info.priority]);
    const when = info.acq
      ? new Intl.DateTimeFormat(LOCALE_INFO[locale].tag, {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'UTC',
        }).format(new Date(info.acq))
      : '';
    rows = [
      { k: t.real, v: fmt.pct(info.pr, 0) },
      { k: t.grow, v: fmt.pct(info.pe, 0), tone: info.pe >= 0.5 ? 'var(--el-kyzyl)' : undefined },
      { k: 'FRP', v: `${fmt.dec(info.frp, 1)} MW` },
      { k: t.pixels, v: fmt.int(info.pixels) },
    ];
    note = `${info.stream.replace('VIIRS_', 'VIIRS ').replace('MODIS_', 'MODIS ')} · ${when} UTC`;
  } else if (info.kind === 'static') {
    dot = STATIC_COLOR;
    title = t.static;
    rows = [
      { k: t.detections, v: fmt.int(info.n) },
      { k: t.night, v: fmt.pct(info.night, 0) },
    ];
    note = t.active(String(info.first), String(info.last));
  } else if (info.kind === 'blind') {
    dot = '#aab6ce';
    title = m.helios.layers.blind;
    rows = [
      { k: t.cloud, v: fmt.pct(info.cloud, 0) },
      { k: t.risk, v: fmt.pct(info.expected, 1) },
    ];
    if (info.flag) note = t.blind;
  } else {
    dot = '#e8ecf4';
    title = info.name;
    rows = [{ k: t.altitude, v: `${fmt.int(info.alt)} km` }];
  }
  return (
    <div
      role="status"
      className="glass pointer-events-none fixed min-w-[200px] max-w-[280px] px-3.5 py-2.5 text-[13px]"
      style={style}
    >
      <div className="flex items-center gap-2 font-medium text-ink">
        <span aria-hidden className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: dot }} />
        {title}
      </div>
      {rows.length ? (
        <dl className="m-0 mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
          {rows.map((r, i) => (
            <Row key={i} k={r.k} v={r.v} tone={r.tone} />
          ))}
        </dl>
      ) : null}
      {note ? <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-ink-dim">{note}</p> : null}
      <p className="m-0 mt-1 text-[10px] uppercase tracking-[0.1em] text-amber">{m.helios.badge}</p>
    </div>
  );
}
