import { useId } from 'react';
import { useI18n } from '@/i18n';
import { rampColors } from '@/styles/tokens';
import { Chip, Icon, Segmented, Switch, type IconName } from '@/ui';
import { useHeliosAvailable, useHeliosScenarios, useHeliosStatus } from './api';
import { BURNED_COLOR, PRIORITY_COLOR, STATIC_COLOR } from './heliosLayers';
import { useHeliosStore, type HeliosLayer, type Horizon } from './heliosStore';

const ICONS: Record<HeliosLayer, IconName> = {
  risk: 'sparkles',
  alerts: 'alert',
  static: 'flame',
  blind: 'layers',
  spread: 'crosshair',
  satellites: 'globe',
};

function LayerRow({ layer }: { layer: HeliosLayer }) {
  const { m } = useI18n();
  const id = useId();
  const on = useHeliosStore((s) => s.layers[layer]);
  const setLayer = useHeliosStore((s) => s.setLayer);
  const t = m.helios.layers;
  const label = t[layer];
  const desc = t[`${layer}Desc` as const];
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className="mt-0.5 grid h-8 w-8 flex-none place-items-center rounded-[10px] border border-line bg-[rgb(255_255_255/0.03)] text-amber">
        <Icon name={ICONS[layer]} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p id={`${id}-label`} className="m-0 text-[13.5px] font-semibold text-ink">
          {label}
        </p>
        <p id={`${id}-desc`} className="m-0 text-[12px] leading-snug text-ink-dim">
          {desc}
        </p>
      </div>
      <Switch
        checked={on}
        onChange={(v) => setLayer(layer, v)}
        labelledBy={`${id}-label`}
        describedBy={`${id}-desc`}
        color="var(--el-amber)"
      />
    </div>
  );
}

function RiskControls() {
  const { m, fmt } = useI18n();
  const horizon = useHeliosStore((s) => s.horizon);
  const scenario = useHeliosStore((s) => s.scenario);
  const setHorizon = useHeliosStore((s) => s.setHorizon);
  const setScenario = useHeliosStore((s) => s.setScenario);
  const scenarios = useHeliosScenarios();
  const status = useHeliosStatus();
  const tm = scenarios.data?.scenarios.find((s) => s.as_of === scenario);
  const metrics = tm?.horizons[`h${horizon}`];
  const latest = status.data?.models.ai3_ground?.[`h${horizon}`]?.test;
  const shortDate = (iso: string) => fmt.yearMonth(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)));

  return (
    <div className="mb-1 ml-11 grid gap-2.5 rounded-[12px] border border-line bg-[rgb(255_255_255/0.02)] p-3">
      <div>
        <p className="eyebrow m-0 mb-1.5">{m.helios.horizon}</p>
        <Segmented<string>
          label={m.helios.horizon}
          value={String(horizon)}
          onChange={(v) => setHorizon(Number(v) as Horizon)}
          className="w-full [&>button]:flex-1"
          options={['1', '2', '3', '4'].map((v) => ({ value: v, label: v }))}
        />
      </div>
      <div>
        <p className="eyebrow m-0 mb-1.5">{m.helios.scenario}</p>
        <div className="flex flex-wrap gap-1.5">
          <Chip pressed={scenario === 'latest'} onClick={() => setScenario('latest')}>
            {m.helios.latest}
            {scenarios.data?.latest
              ? ` · ${fmt.yearMonth(Number(scenarios.data.latest.slice(0, 4)), Number(scenarios.data.latest.slice(5, 7)))}`
              : ''}
          </Chip>
          {(scenarios.data?.scenarios ?? []).map((s) => (
            <Chip
              key={s.as_of}
              pressed={scenario === s.as_of}
              onClick={() => setScenario(s.as_of)}
              title={s.as_of}
            >
              {shortDate(s.as_of)}
            </Chip>
          ))}
        </div>
      </div>
      {scenario !== 'latest' ? (
        <>
          <p className="m-0 text-[11.5px] leading-snug text-ink-dim">{m.helios.timeMachineHint}</p>
          {metrics?.ai.pr_auc !== undefined && metrics.baseline.pr_auc !== undefined ? (
            <p className="num m-0 text-[12px] text-mint">
              {m.helios.quality(fmt.dec(metrics.ai.pr_auc, 2), fmt.dec(metrics.baseline.pr_auc, 2))}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {latest?.ai.roc_auc !== undefined &&
          latest.ai.pr_auc !== undefined &&
          latest.baseline_climatology.pr_auc !== undefined ? (
            <p className="num m-0 text-[11.5px] text-ink-dim">
              {m.helios.qualityLatest(
                fmt.dec(latest.ai.roc_auc, 3),
                fmt.dec(latest.ai.pr_auc, 2),
                fmt.dec(latest.baseline_climatology.pr_auc, 2),
              )}
            </p>
          ) : null}
          {scenarios.data?.history_gap ? (
            <p className="m-0 text-[11.5px] leading-snug text-trust-medium">{m.helios.historyGap}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Legend() {
  const { m } = useI18n();
  const ramp = rampColors();
  const t = m.helios.legend;
  return (
    <div className="mt-2 grid gap-2 text-[12px] text-ink-muted">
      <div>
        <div
          className="h-2 w-full rounded-full"
          style={{
            background: `linear-gradient(90deg, ${ramp[1]}, ${ramp[3]}, ${ramp[4]}, ${ramp[5]}, ${ramp[6]})`,
          }}
        />
        <div className="mt-1 flex justify-between text-[11px] text-ink-dim">
          <span>{t.lowRisk}</span>
          <span>{m.helios.tooltip.risk}</span>
          <span>{t.highRisk}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px] border-2" style={{ borderColor: BURNED_COLOR }} />
          {t.burned}
        </span>
        {(['CRITICAL', 'HIGH', 'ROUTINE'] as const).map((p) => (
          <span key={p} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: PRIORITY_COLOR[p]() }} />
            {m.helios.priorities[p]}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATIC_COLOR }} />
          {t.static}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-4 rounded-[2px]"
            style={{
              background:
                'repeating-linear-gradient(45deg, rgb(170 182 206 / 0.7) 0 2px, transparent 2px 6px)',
            }}
          />
          {t.blind}
        </span>
      </div>
    </div>
  );
}

/** "HELIOS · AI layers" block of the layers panel. Hidden on the synthetic demo (no HELIOS backend). */
export function HeliosLayersSection() {
  const { m } = useI18n();
  const available = useHeliosAvailable();
  const riskOn = useHeliosStore((s) => s.layers.risk);
  if (!available) return null;
  return (
    <section aria-labelledby="helios-layers-title">
      <h3 id="helios-layers-title" className="eyebrow mb-1 mt-5 flex items-center gap-2">
        {m.helios.layers.title}
        <span className="rounded-pill border border-[rgb(255_181_71/0.4)] px-1.5 py-px text-[9.5px] tracking-[0.1em] text-amber">
          {m.helios.badge}
        </span>
      </h3>
      <p className="m-0 text-[11.5px] leading-snug text-ink-dim">{m.helios.layers.hint}</p>
      <div className="divide-y divide-[var(--el-line)]">
        <LayerRow layer="risk" />
        {riskOn ? <RiskControls /> : null}
        <LayerRow layer="alerts" />
        <LayerRow layer="static" />
        <LayerRow layer="blind" />
        <LayerRow layer="spread" />
        <LayerRow layer="satellites" />
      </div>
      <Legend />
    </section>
  );
}
