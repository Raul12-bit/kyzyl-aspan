import { useMemo, useState } from 'react';
import {
  useHeliosAvailable,
  useHeliosLink,
  useHeliosMission,
  useHeliosStatus,
  type LinkParams,
} from '@/features/helios/api';
import { useI18n } from '@/i18n';
import { useDebounced } from '@/lib/useDebounced';
import { Card, Skeleton } from '@/ui';
import { LabeledSlider, Section } from './Section';

/* ------------------------------------------------------------------ helpers */

function Bar({
  value,
  max = 1,
  color,
  muted = false,
}: {
  value: number;
  max?: number;
  color: string;
  muted?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span className="block h-2 rounded-full bg-[rgb(255_255_255/0.06)]">
      <span
        className="block h-2 rounded-full"
        style={{ width: `${pct}%`, background: muted ? 'var(--el-ink-dim)' : color }}
      />
    </span>
  );
}

function Compare({
  label,
  ai,
  rule,
  ruleLabel,
  format,
}: {
  label: string;
  ai: number;
  rule: number;
  ruleLabel: string;
  /** How the model's own score is printed; AUCs by default, shares as percentages. */
  format?: (v: number) => string;
}) {
  const { fmt } = useI18n();
  return (
    <div>
      <div className="mb-1 flex justify-between gap-3 text-[12px] text-ink-dim">
        <span>{label}</span>
        <span className="num">
          <span className="text-amber">{format ? format(ai) : fmt.dec(ai, 3)}</span> · {ruleLabel}
        </span>
      </div>
      <div className="grid gap-1">
        <Bar value={ai} color="var(--el-grad-ember)" />
        <Bar value={rule} color="" muted />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 04 · real models */

export function ModelsSection() {
  const { m, fmt } = useI18n();
  const t = m.helios.mission.models;
  const mission = useHeliosMission();
  const status = useHeliosStatus();
  const ai1 = mission.data?.ai1;
  const ai2 = mission.data?.ai2;
  const ai3 = status.data?.models.ai3_ground?.h1?.test;
  const harm = status.data?.harmonization;
  const step = harm?.step_tests.SNPP_2012;
  return (
    <Section id="helios-models" kicker={t.kicker} title={t.title} body={t.body}>
      {mission.isPending || status.isPending ? (
        <Skeleton className="h-72 w-full !rounded-panel" />
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-4 xl:grid-cols-3">
            {ai1 ? (
              <Card className="grid content-start gap-4">
                <div>
                  <p className="eyebrow m-0 !text-kyzyl">{t.ai1}</p>
                  <p className="m-0 mt-1.5 text-[13px] leading-snug text-ink-muted">{t.ai1Desc}</p>
                </div>
                <Compare
                  label={t.real}
                  ai={ai1.p_real.roc_auc}
                  rule={ai1.p_real.baseline_confidence_only_auc}
                  ruleLabel={t.rule(fmt.dec(ai1.p_real.baseline_confidence_only_auc, 3))}
                />
                <Compare
                  label={t.grow}
                  ai={ai1.p_escalation.roc_auc}
                  rule={ai1.p_escalation.baseline_frp_only_auc}
                  ruleLabel={t.rule(fmt.dec(ai1.p_escalation.baseline_frp_only_auc, 3))}
                />
                <p className="num m-0 text-[11.5px] text-ink-dim">
                  {t.size(
                    fmt.dec(ai1.model.onnx_int8_kb ?? ai1.model.onnx_fp32_kb, 1),
                    fmt.int(ai1.model.parameters ?? 0),
                  )}
                </p>
              </Card>
            ) : null}
            {ai2 ? (
              <Card className="grid content-start gap-4">
                <div>
                  <p className="eyebrow m-0 !text-kyzyl">{t.ai2}</p>
                  <p className="m-0 mt-1.5 text-[13px] leading-snug text-ink-muted">{t.ai2Desc}</p>
                </div>
                <Compare
                  label={t.warn}
                  ai={ai2.ai.early_warning_recall_at_5pct_false_alarms}
                  rule={ai2.baseline_margin_rule.early_warning_recall_at_5pct_false_alarms}
                  format={(v) => fmt.pct(v, 0)}
                  ruleLabel={t.rule(
                    fmt.pct(ai2.baseline_margin_rule.early_warning_recall_at_5pct_false_alarms, 0),
                  )}
                />
                <Compare
                  label="ROC-AUC"
                  ai={ai2.ai.roc_auc}
                  rule={ai2.baseline_margin_rule.roc_auc}
                  ruleLabel={t.rule(fmt.dec(ai2.baseline_margin_rule.roc_auc, 3))}
                />
                <p className="num m-0 text-[11.5px] text-ink-dim">
                  {t.size(fmt.dec(ai2.model.onnx_kb, 1), fmt.int(ai2.model.parameters))}
                </p>
              </Card>
            ) : null}
            {ai3?.ai.roc_auc !== undefined && ai3.baseline_climatology.roc_auc !== undefined ? (
              <Card className="grid content-start gap-4">
                <div>
                  <p className="eyebrow m-0 !text-kyzyl">{t.ai3}</p>
                  <p className="m-0 mt-1.5 text-[13px] leading-snug text-ink-muted">{t.ai3Desc}</p>
                </div>
                <Compare
                  label={t.risk}
                  ai={ai3.ai.roc_auc}
                  rule={ai3.baseline_climatology.roc_auc}
                  ruleLabel={t.rule(fmt.dec(ai3.baseline_climatology.roc_auc, 3))}
                />
                <Compare
                  label="PR-AUC"
                  ai={ai3.ai.pr_auc ?? 0}
                  rule={ai3.baseline_climatology.pr_auc ?? 0}
                  ruleLabel={t.rule(fmt.dec(ai3.baseline_climatology.pr_auc ?? 0, 3))}
                />
              </Card>
            ) : null}
          </div>
          {mission.data?.onboard_c && mission.data.onboard_c.targets.some((x) => x.ok) ? (
            <Card className="grid gap-3">
              <div>
                <p className="eyebrow m-0 !text-kyzyl">{t.onboardTitle}</p>
                <p className="m-0 mt-1.5 text-[13px] leading-snug text-ink-muted">
                  {t.onboardBody(
                    fmt.int(mission.data.onboard_c.targets.filter((x) => x.ok).length),
                    fmt.int(mission.data.onboard_c.selftest?.vectors ?? 0),
                    fmt.int(mission.data.onboard_c.selftest?.bit_exact_mismatches ?? 0),
                  )}
                </p>
              </div>
              <ul className="m-0 grid list-none gap-1.5 p-0 text-[12.5px] sm:grid-cols-2">
                {mission.data.onboard_c.targets
                  .filter((x) => x.ok)
                  .map((x) => (
                    <li
                      key={x.target}
                      className="flex items-baseline justify-between gap-3 border-b border-line pb-1"
                    >
                      <span className="min-w-0 text-ink-muted">{x.target}</span>
                      <span className="num flex-none text-ink">
                        {t.onboardRom(fmt.dec((x.rom_bytes ?? 0) / 1024, 1))}
                      </span>
                    </li>
                  ))}
              </ul>
            </Card>
          ) : null}
          {step || harm ? (
            <Card className="grid gap-2 text-[13px] leading-relaxed text-ink-muted">
              {step ? (
                <p className="m-0">
                  {t.harmonization(
                    fmt.dec(step.raw_detections, 2),
                    fmt.dec(step.harmonized, 2),
                    fmt.dec(step.aqua_only, 2),
                  )}
                </p>
              ) : null}
              {harm ? (
                <p className="m-0">
                  {t.denial(
                    fmt.pct(harm.denial_test.total_error_pct / 100, 1),
                    fmt.dec(harm.denial_test.spearman_rho, 3),
                  )}
                </p>
              ) : null}
            </Card>
          ) : null}
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ 05 · link physics */

const flux = (pos: number) => 10 ** (-8 + (5 * pos) / 100); // A1 … X10
function flareClass(f: number): string {
  for (const [letter, base] of [
    ['X', 1e-4],
    ['M', 1e-5],
    ['C', 1e-6],
    ['B', 1e-7],
    ['A', 1e-8],
  ] as const) {
    if (f >= base) return `${letter}${(f / base).toFixed(1)}`;
  }
  return 'A1.0';
}
const logW = (pos: number) => 0.5 * 200 ** (pos / 100); // 0.5 … 100 W

function marginColor(db: number) {
  if (db > 3) return 'var(--el-trust-high)';
  if (db > 0) return 'var(--el-trust-medium)';
  return 'var(--el-kyzyl)';
}

export function PhysicsSection() {
  const { m, fmt } = useI18n();
  const t = m.helios.mission.physics;
  const [flarePos, setFlarePos] = useState(40);
  const [kp, setKp] = useState(3);
  const [rain, setRain] = useState(0);
  const [cloud, setCloud] = useState(20);
  const [elevation, setElevation] = useState(30);
  const [powerPos, setPowerPos] = useState(25);
  const params = useMemo<LinkParams>(
    () => ({
      xray_flux: flux(flarePos),
      kp,
      rain_mm_h: rain,
      cloud_frac: cloud / 100,
      elevation_deg: elevation,
      laser_power_w: logW(powerPos),
    }),
    [flarePos, kp, rain, cloud, elevation, powerPos],
  );
  const debounced = useDebounced(params, 200);
  const link = useHeliosLink(debounced);
  const d = link.data;
  const channelName = (k: string) => t.channels[k as keyof typeof t.channels] ?? k;
  const order = ['S', 'X', 'Ka', 'laser_ground', 'laser_ISL_to_GEO'];

  return (
    <Section id="helios-physics" kicker={t.kicker} title={t.title} body={t.body}>
      <Card className="grid gap-5">
        <div className="grid gap-4 md:grid-cols-2">
          <LabeledSlider
            label={t.flare}
            min={0}
            max={100}
            value={flarePos}
            onChange={setFlarePos}
            formatValue={() => flareClass(flux(flarePos))}
          />
          <LabeledSlider
            label={t.kp}
            min={0}
            max={9}
            step={0.33}
            value={kp}
            onChange={setKp}
            formatValue={(v) => fmt.dec(v, 1)}
          />
          <LabeledSlider
            label={t.rain}
            min={0}
            max={50}
            value={rain}
            onChange={setRain}
            formatValue={(v) => `${fmt.int(v)} ${t.units.mmh}`}
          />
          <LabeledSlider
            label={t.cloud}
            min={0}
            max={100}
            value={cloud}
            onChange={setCloud}
            formatValue={(v) => `${fmt.int(v)}%`}
          />
          <LabeledSlider
            label={t.elevation}
            min={5}
            max={90}
            value={elevation}
            onChange={setElevation}
            formatValue={(v) => `${fmt.int(v)}°`}
          />
          <LabeledSlider
            label={t.power}
            min={0}
            max={100}
            value={powerPos}
            onChange={setPowerPos}
            formatValue={() => `${fmt.dec(logW(powerPos), 1)} ${t.units.watt}`}
          />
        </div>
        {!d ? (
          <p className="m-0 text-[13px] text-ink-dim">
            {link.isError ? m.helios.mission.offline : t.loading}
          </p>
        ) : (
          <div className="grid gap-4" aria-live="polite">
            <div className="grid gap-2.5">
              <div className="grid grid-cols-2 gap-2 text-[11px] uppercase tracking-[0.08em] text-ink-dim sm:grid-cols-[8.5rem_1fr_1fr]">
                <span className="col-span-2 sm:col-span-1">{t.margin}</span>
                <span>{t.bulk}</span>
                <span>{t.alert}</span>
              </div>
              {order.map((k) => {
                const bulk = d.margins_db[k] ?? 0;
                const alert = d.alert_mode_margins_db[k] ?? 0;
                return (
                  <div
                    key={k}
                    className="grid grid-cols-2 items-center gap-x-2 gap-y-1 text-[12px] sm:grid-cols-[8.5rem_1fr_1fr]"
                  >
                    <span className="col-span-2 leading-tight text-ink-muted sm:col-span-1">
                      {channelName(k)}
                    </span>
                    {[bulk, alert].map((v, i) => (
                      <span key={i} className="flex items-center gap-2">
                        <span className="relative h-2 flex-1 rounded-full bg-[rgb(255_255_255/0.06)]">
                          <span
                            className="absolute inset-y-0 left-0 rounded-full"
                            style={{
                              width: `${Math.max(2, Math.min(100, ((v + 40) / 100) * 100))}%`,
                              background: marginColor(v),
                            }}
                          />
                        </span>
                        <span
                          className="num w-[4.5rem] shrink-0 whitespace-nowrap text-right"
                          style={{ color: marginColor(v) }}
                        >
                          {v > 0 ? '+' : ''}
                          {fmt.dec(v, 1)} {t.units.db}
                        </span>
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
            <div className="grid gap-1.5 rounded-[14px] border border-line bg-[rgb(255_255_255/0.02)] px-4 py-3 text-[13px]">
              <p className="m-0 font-semibold text-ink">{t.best(channelName(d.recommended_channel))}</p>
              <p className="m-0 text-ink-muted">{t.alertVia(channelName(d.alert_channel))}</p>
              <p className="m-0 text-ink-muted">
                {t.flareFact(
                  fmt.dec(d.ionosphere.absorption_db.HF_10MHz ?? 0, 1),
                  fmt.dec(d.ionosphere.absorption_db['X_8.2GHz'] ?? 0, 6),
                )}
              </p>
              <p className="m-0 text-[12px] text-ink-dim">
                {t.beam(fmt.dec(d.laser_beam.spot_radius_m, 2), fmt.dec(d.laser_beam.divergence_urad, 2))}
              </p>
            </div>
          </div>
        )}
      </Card>
    </Section>
  );
}

/* ------------------------------------------------------------------ 06 · smart delivery */

const STRATEGY_ORDER = [
  'A_today_nrt',
  'B_onboard_ai_store_forward',
  'C_plus_kz_direct_stations',
  'D1_plus_real_geo_relays',
  'D2_plus_geo_relay_76E',
] as const;

export function DeliverySection() {
  const { m, fmt } = useI18n();
  const t = m.helios.mission.delivery;
  const mission = useHeliosMission();
  const d = mission.data?.delivery;
  // Sub-minute delays keep a decimal: a relay hop is ~0.6 s, rounding it up to "1 s" would overstate it.
  const fmtDelay = (min: number) => {
    const sec = min * 60;
    if (sec < 10) return t.seconds(fmt.dec(Math.max(0.1, sec), 1));
    return min < 1 ? t.seconds(fmt.int(Math.round(sec))) : t.minutes(fmt.int(Math.round(min)));
  };
  const maxSec = d
    ? Math.max(...STRATEGY_ORDER.map((k) => (d.strategies[k]?.all.median_min ?? 0) * 60), 60)
    : 1;

  return (
    <Section
      id="helios-delivery"
      kicker={t.kicker}
      title={t.title}
      body={t.body}
      aside={<p className="m-0 text-[12px] leading-snug text-ink-dim">{t.illustrative}</p>}
    >
      {mission.isPending ? (
        <Skeleton className="h-72 w-full !rounded-panel" />
      ) : !d ? (
        <Card>
          <p className="m-0 text-ink-dim">{m.helios.mission.offline}</p>
        </Card>
      ) : (
        <div className="grid gap-4">
          <Card className="grid gap-4">
            <p className="m-0 text-[13px] text-ink-muted">{t.day(d.replay_day, fmt.int(d.alerts))}</p>
            <div className="grid gap-2.5">
              <p className="eyebrow m-0">{t.median}</p>
              {STRATEGY_ORDER.map((k) => {
                const s = d.strategies[k];
                if (!s) return null;
                const sec = s.all.median_min * 60;
                const width = (Math.log10(sec + 1) / Math.log10(maxSec + 1)) * 100;
                return (
                  <div
                    key={k}
                    className="grid grid-cols-[1fr_4.5rem] items-center gap-x-3 gap-y-1 text-[12.5px] sm:grid-cols-[minmax(0,13rem)_1fr_4.5rem]"
                  >
                    <span className="col-span-2 text-ink-muted sm:col-span-1 sm:truncate">
                      {t.strategies[k]}
                    </span>
                    <span className="block h-2.5 rounded-full bg-[rgb(255_255_255/0.06)]">
                      <span
                        className="block h-2.5 rounded-full"
                        style={{
                          width: `${Math.max(3, width)}%`,
                          background: k === 'A_today_nrt' ? 'var(--el-ink-dim)' : 'var(--el-grad-ember)',
                        }}
                      />
                    </span>
                    <span className="num text-right text-ink">{fmtDelay(s.all.median_min)}</span>
                  </div>
                );
              })}
            </div>
            {d.collaborative_network.confirmed_by_other_satellite_12h !== null &&
            d.collaborative_network.median_minutes_to_confirmation !== null ? (
              <p className="m-0 rounded-[12px] border border-[rgb(126_230_196/0.3)] bg-[rgb(126_230_196/0.06)] px-3 py-2.5 text-[12.5px] leading-snug text-ink-muted">
                {t.confirmed(
                  fmt.pct(d.collaborative_network.confirmed_by_other_satellite_12h, 0),
                  fmt.int(Math.round(d.collaborative_network.median_minutes_to_confirmation)),
                )}
              </p>
            ) : null}
          </Card>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            {mission.data?.blackouts.length ? (
              <Card className="min-w-0 overflow-x-auto">
                <h3 className="m-0 mb-3 text-[14px] font-semibold text-ink">{t.blackout}</h3>
                <table className="w-full border-collapse text-left text-[12.5px]">
                  <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-dim">
                    <tr>
                      <th className="py-1.5 font-medium" />
                      <th className="py-1.5 font-medium">{t.blackoutCols.ground}</th>
                      <th className="py-1.5 font-medium">{t.blackoutCols.relays}</th>
                      <th className="py-1.5 font-medium">{t.blackoutCols.hyp}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mission.data.blackouts.map((b) => {
                      const hyp =
                        b.minutes_without_link_with_relay_76E ?? b.minutes_without_link_with_relay_76e ?? 0;
                      return (
                        <tr key={b.satellite} className="border-t border-line">
                          <td className="py-1.5 pr-2 text-ink">{b.satellite}</td>
                          <td className="num py-1.5 text-kyzyl">
                            {fmt.dec(b.minutes_without_any_link / 60, 1)}
                          </td>
                          <td className="num py-1.5 text-trust-medium">
                            {fmt.dec((b.minutes_without_link_with_real_relays ?? 0) / 60, 1)}
                          </td>
                          <td className="num py-1.5 text-trust-high">{fmt.dec(hyp / 60, 1)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            ) : null}
            {mission.data?.delays?.length ? (
              <Card className="min-w-0">
                <h3 className="m-0 mb-3 text-[14px] font-semibold text-ink">{t.delays}</h3>
                <ul className="m-0 grid list-none gap-2 p-0 text-[12.5px]">
                  {mission.data.delays.map((x) => (
                    <li key={x.stream} className="flex items-center justify-between gap-3">
                      <span className="text-ink-muted">{x.stream.replace('_', ' ')}</span>
                      <span className="num flex items-center gap-2 text-ink">
                        {t.minutes(fmt.int(Math.round(x.median_latency_min)))}
                        <span
                          className="rounded-pill px-2 py-0.5 text-[11px]"
                          style={{
                            background:
                              x.status === 'OK' ? 'rgb(126 230 196 / 0.14)' : 'rgb(255 82 54 / 0.14)',
                            color: x.status === 'OK' ? 'var(--el-trust-high)' : 'var(--el-kyzyl)',
                          }}
                        >
                          {t.delayStatus[x.status as 'OK'] ?? x.status}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        </div>
      )}
    </Section>
  );
}

/** The HELIOS-SHIELD results on the mission page; nothing on the synthetic demo. */
export function HeliosMissionSections() {
  const available = useHeliosAvailable();
  if (!available) return null;
  return (
    <>
      <ModelsSection />
      <PhysicsSection />
      <DeliverySection />
    </>
  );
}
