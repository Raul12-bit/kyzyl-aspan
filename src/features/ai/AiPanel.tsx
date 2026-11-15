import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ruleFindings, type AreaSummary, type Finding } from '@/domain/summary';
import { useI18n, type Formatters, type Messages } from '@/i18n';
import { Button, cn, Icon, Spinner } from '@/ui';
import { AiOfflineError, requestAnalysis, type AnalysisResult } from './aiClient';

/* ------------------------------------------------------------------ text rendering */

/**
 * Renders the model's small markdown subset (## headings, - bullets, **bold**, paragraphs) as React
 * elements. Nothing is injected as HTML, so model output can never become markup or script.
 */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  );
}

export function ModelText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {list.map((li, i) => (
            <li key={i}>{inline(li)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      flush();
      blocks.push(<h4 key={`h-${blocks.length}`}>{line.replace(/^#{1,4}\s+/, '')}</h4>);
    } else if (/^[-*•]\s/.test(line)) {
      list.push(line.replace(/^[-*•]\s+/, ''));
    } else {
      flush();
      blocks.push(<p key={`p-${blocks.length}`}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className="ai-text text-[13.5px] leading-relaxed text-ink-muted">{blocks}</div>;
}

function monthsText(months: number[], fmt: Formatters) {
  return fmt.list(months.map((mo) => fmt.month(mo, 'long')));
}

function ymText(ym: string, fmt: Formatters) {
  const [y, mo] = ym.split('-').map(Number);
  return fmt.yearMonth(y!, mo!);
}

function findingText(f: Finding, m: Messages, fmt: Formatters): string {
  const t = m.map.ai.findings;
  switch (f.kind) {
    case 'demo':
      return t.demo;
    case 'risk':
      return t.risk(m.map.ai.levels[f.level], monthsText(f.months, fmt));
    case 'season':
      return t.season(monthsText(f.months, fmt));
    case 'trend': {
      const years = f.fromYear === f.toYear ? String(f.fromYear) : `${f.fromYear}–${f.toYear}`;
      if (Math.abs(f.pctPerYear) < 0.5) return t.trendFlat(years);
      return f.pctPerYear > 0 ? t.trendUp(fmt.pct(f.pctPerYear / 100, 1), years) : t.trendDown(fmt.pct(-f.pctPerYear / 100, 1), years);
    }
    case 'limits':
      return f.noSeason ? t.noSeason(fmt.int(f.months)) : t.noTrend;
    case 'recent':
      if (f.ratio >= 1.15) return t.recentHigh(`×${fmt.dec(f.ratio, 1)}`);
      if (f.ratio <= 0.85) return t.recentLow(`×${fmt.dec(f.ratio, 1)}`);
      return t.recentTypical;
    case 'anomalies':
      return t.anomalies(fmt.list(f.months.map((x) => ymText(x, fmt))));
    case 'noise':
      return t.noise(fmt.pct(f.removedShare, 0), fmt.int(f.staticCells));
    case 'sensors':
      return t.sensors(f.raw === null ? '—' : fmt.dec(f.raw, 1), fmt.dec(f.hex, 1));
    case 'uncertainty':
      return t.uncertainty(fmt.dec(f.value, 1), fmt.dec(f.lo, 1), fmt.dec(f.hi, 1), fmt.pct(f.interval ?? 0.9, 0));
    case 'forecast':
      return t.forecast(fmt.pct(f.max, f.max < 0.1 ? 1 : 0), fmt.pct(f.mean, 1), fmt.pct(f.typical, 1));
  }
}

const LEVEL_COLOR = { low: 'var(--el-trust-high)', moderate: 'var(--el-trust-medium)', elevated: 'var(--el-orange)', high: 'var(--el-kyzyl)' };

function Findings({ findings }: { findings: Finding[] }) {
  const { m, fmt } = useI18n();
  // The lead line: the risk level on real data, or the "synthetic demo — not a forecast" line on the demo.
  const lead = findings.find((f): f is Extract<Finding, { kind: 'risk' | 'demo' }> => f.kind === 'risk' || f.kind === 'demo');
  const pill = lead?.kind === 'risk' ? { text: m.map.ai.levels[lead.level], color: LEVEL_COLOR[lead.level] } : { text: m.map.ai.demoPill, color: 'var(--el-amber)' };
  return (
    <div className="text-[13.5px] leading-relaxed text-ink-muted">
      {lead ? (
        <p className="m-0 mb-3 flex items-start gap-2.5 text-ink">
          <span
            className="mt-0.5 inline-flex flex-none items-center rounded-pill px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: pill.color, background: 'var(--el-tint-2)', border: '1px solid currentColor' }}
          >
            {pill.text}
          </span>
          <span>{findingText(lead, m, fmt)}</span>
        </p>
      ) : null}
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {findings
          .filter((f) => f.kind !== 'risk' && f.kind !== 'demo')
          .map((f, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className="mt-[9px] h-1 w-1 flex-none rounded-full bg-ink-dim" />
              {findingText(f, m, fmt)}
            </li>
          ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; result: AnalysisResult }
  | { kind: 'error'; message: string };

/**
 * The AI brief — sends the statistics of the selected area AND period (not the map) to Gemini through the
 * backend. On synthetic data it is a "Demo briefing" that explains the numbers and never forecasts; on real
 * data it is the risk analysis.
 */
export function AiPanel({ summary }: { summary: AreaSummary | null }) {
  const { m, locale, fmt } = useI18n();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [showPayload, setShowPayload] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const key = summary
    ? `${summary.area.name}|${summary.area.bbox.join(',')}|${summary.period.from}|${summary.period.to}|${locale}`
    : '';

  // A new area, period or language invalidates the previous briefing.
  useEffect(() => {
    abortRef.current?.abort();
    setState({ kind: 'idle' });
  }, [key]);

  // The server's verdict wins once it answered (it forces the demo where only demo data exists).
  const answered = state.kind === 'done' ? state.result : null;
  const demo = answered?.mode ? answered.mode === 'demo' : (summary?.synthetic ?? false);
  const period = answered?.period ?? summary?.period ?? null;
  const periodText = period ? m.map.stats.period(ymText(period.from, fmt), ymText(period.to, fmt)) : null;

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    if (!summary) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ kind: 'loading' });
    try {
      const result = await requestAnalysis(summary, locale, ctrl.signal);
      if (!ctrl.signal.aborted) setState({ kind: 'done', result });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (err instanceof AiOfflineError) {
        // No backend (e.g. a static deployment): still useful, clearly labelled.
        setState({
          kind: 'done',
          result: { source: 'rules', mode: summary.synthetic ? 'demo' : 'risk', period: summary.period, findings: ruleFindings(summary), reason: 'offline' },
        });
      } else {
        setState({ kind: 'error', message: (err as Error).message });
      }
    }
  };

  return (
    <section aria-labelledby="ai-title" className="rounded-[16px] border border-[rgb(255_82_54/0.28)] bg-[linear-gradient(160deg,rgb(255_82_54/0.08),rgb(255_178_74/0.02)_60%,transparent)] p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 flex-none place-items-center rounded-[11px] bg-[rgb(255_82_54/0.14)] text-kyzyl">
          <Icon name="sparkles" size={18} />
        </span>
        <div className="min-w-0">
          <h3 id="ai-title" className="m-0 text-[15px] font-semibold text-ink">
            {demo ? m.map.ai.demoTitle : m.map.ai.title}
          </h3>
          <p className="m-0 mt-0.5 text-[12.5px] leading-snug text-ink-dim">{demo ? m.map.ai.demoSubtitle : m.map.ai.subtitle}</p>
        </div>
      </div>

      {periodText ? (
        <p className="m-0 mt-3 flex items-center gap-2 text-[12px] text-ink-muted" data-ai-period>
          <Icon name="calendar" size={14} className="flex-none text-ink-dim" />
          <span>
            {m.map.ai.periodLabel} <span className="num text-ink">{periodText}</span>
          </span>
        </p>
      ) : null}

      <div className="mt-3.5" aria-live="polite">
        {state.kind === 'loading' ? (
          <div className="grid gap-2" role="status">
            <p className="m-0 flex items-center gap-2 text-[13px] text-ink-muted">
              <Spinner size={14} />
              {m.map.ai.loading}
            </p>
            {[92, 78, 85].map((w) => (
              <span
                key={w}
                className="block h-2.5 rounded"
                style={{
                  width: `${w}%`,
                  background: 'linear-gradient(90deg, var(--el-tint-1), var(--el-tint-3), var(--el-tint-1))',
                  backgroundSize: '200% 100%',
                  animation: 'el-shimmer 1.4s linear infinite',
                }}
              />
            ))}
          </div>
        ) : state.kind === 'done' ? (
          <div style={{ animation: 'el-rise-in 380ms var(--el-ease-emphasized) both' }}>
            {state.result.source === 'gemini' ? <ModelText text={state.result.text} /> : <Findings findings={state.result.findings} />}
            <p className="m-0 mt-3 flex items-start gap-1.5 text-[11.5px] leading-snug text-ink-dim">
              <Icon name="info" size={13} className="mt-px flex-none" />
              {state.result.source === 'gemini'
                ? m.map.ai.sourceGemini(state.result.model)
                : state.result.reason === 'offline'
                  ? m.map.ai.offline
                  : state.result.reason === 'model-error'
                    ? m.map.ai.sourceRulesError
                    : m.map.ai.sourceRules}
            </p>
          </div>
        ) : state.kind === 'error' ? (
          <p className="m-0 text-[13px] text-danger">
            {m.map.ai.error} <span className="text-ink-dim">({state.message})</span>
          </p>
        ) : null}
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Button
          variant={state.kind === 'done' ? 'secondary' : 'primary'}
          size="sm"
          icon={state.kind === 'done' ? 'refresh' : 'sparkles'}
          onClick={() => void run()}
          disabled={!summary || state.kind === 'loading'}
        >
          {state.kind === 'done' || state.kind === 'error' ? m.map.ai.rerun : m.map.ai.run}
        </Button>
        {summary ? (
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent px-1 text-[12px] text-ink-dim underline-offset-2 hover:text-ink hover:underline"
            aria-expanded={showPayload}
            onClick={() => setShowPayload((v) => !v)}
          >
            {showPayload ? m.map.ai.hidePayload : m.map.ai.showPayload}
          </button>
        ) : null}
      </div>
      {showPayload && summary ? (
        <pre className={cn('num m-0 mt-2.5 max-h-56 overflow-auto rounded-[10px] border border-line bg-[var(--el-inset)] p-2.5 text-[10.5px] leading-snug text-ink-dim')}>
          {JSON.stringify(summary, null, 1)}
        </pre>
      ) : null}
      <p className="m-0 mt-3 text-[11px] leading-snug text-ink-dim">{demo ? m.map.ai.demoDisclaimer : m.map.ai.disclaimer}</p>
    </section>
  );
}
