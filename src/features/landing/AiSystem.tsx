import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type { AiId } from '@/domain/ai/registry';
import { useAiServerStatus } from '@/features/ai-lab/serverStatus';
import { SystemDiagram } from '@/features/ai-lab/SystemDiagram';
import { useHeliosAvailable } from '@/features/helios/api';
import { useI18n } from '@/i18n';
import { ButtonLink, Icon, SensorMark } from '@/ui';
import { Accent } from './Accent';

const IDS: AiId[] = ['ai1', 'ai2', 'ai3'];

function Status({ tone, children }: { tone: 'on' | 'off' | 'wait'; children: string }) {
  return (
    <li className="lp-status" data-tone={tone}>
      <span className="lp-status__dot" aria-hidden />
      {children}
    </li>
  );
}

/**
 * What actually runs on this site, checked live — so the section never reads as "already in orbit":
 * AI #1 and AI #2 are onboard/communications simulations in the browser, AI #3 answers from the ground
 * server (or falls back to the browser), and the HELIOS real-data mode is on or off.
 */
function SiteStatus() {
  const { m } = useI18n();
  const s = m.ai.lab.status;
  const server = useAiServerStatus();
  const helios = useHeliosAvailable();
  return (
    <ul
      className="lp-ai__status"
      aria-label={m.ai.landing.statusLabel}
      data-rv
      style={{ ['--d' as string]: 3 } as CSSProperties}
    >
      <Status tone="on">{s.browser}</Status>
      {server.isPending ? (
        <Status tone="wait">{s.checking}</Status>
      ) : server.data?.online ? (
        <Status tone="on">{s.server}</Status>
      ) : (
        <Status tone="off">{s.fallback}</Status>
      )}
      <Status tone={helios ? 'on' : 'off'}>{helios ? s.helios : s.heliosOff}</Status>
    </ul>
  );
}

/**
 * Landing section, near the bottom: how the three AIs work together and how MODIS and VIIRS are combined.
 * Each card deep-links into the AI lab tab where that AI can be run.
 */
export function AiSystem() {
  const { m } = useI18n();
  const l = m.ai.landing;
  return (
    <section className="lp-section" aria-labelledby="lp-ai">
      <div className="lp-wrap">
        <header className="lp-head">
          <p className="lp-eyebrow" data-rv>
            {l.eyebrow}
          </p>
          <h2 id="lp-ai" className="lp-h2" data-rv style={{ ['--d' as string]: 1 } as CSSProperties}>
            <Accent text={l.title} accent={l.accent} />
          </h2>
          <p className="lp-lead" data-rv style={{ ['--d' as string]: 2 } as CSSProperties}>
            {l.lead}
          </p>
          <SiteStatus />
        </header>

        <figure className="lp-ai__diagram" data-rv>
          <SystemDiagram />
        </figure>

        <ol className="lp-ai__cards">
          {IDS.map((id, i) => {
            const a = m.ai.systems[id];
            return (
              <li key={id} className="lp-ai__card" data-rv style={{ ['--d' as string]: i } as CSSProperties}>
                <div className="lp-ai__top">
                  <span className="lp-ai__badge">{a.name}</span>
                  <span className="lp-ai__where">{a.where}</span>
                </div>
                <p className="lp-ai__role">{a.role}</p>
                <h3 className="lp-ai__title">{a.title}</h3>
                <p className="lp-ai__body">{a.body}</p>
                <ul className="lp-ai__does">
                  {a.does.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
                <p className="lp-ai__foot">{a.footprint}</p>
                <Link to={{ pathname: '/ai', hash: `#${id}` }} className="lp-link mt-1 self-start">
                  {l.test(String(i + 1))}
                  <Icon name="arrowRight" size={16} />
                </Link>
              </li>
            );
          })}
        </ol>

        <div className="lp-ai__fusion" data-rv>
          <h3 className="lp-ai__fusionTitle">
            <span className="lp-ai__sensors" aria-hidden>
              <SensorMark kind="MODIS" size={12} />
              <SensorMark kind="VIIRS" size={12} />
            </span>
            {l.fusionTitle}
          </h3>
          <ol className="lp-ai__steps">
            {l.fusion.map((step, i) => (
              <li key={step.title}>
                <span className="lp-ai__n">{String(i + 1).padStart(2, '0')}</span>
                <b>{step.title}</b>
                <span>{step.body}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="mt-12" data-rv>
          <ButtonLink to="/ai" variant="primary" iconRight="arrowRight">
            {l.cta}
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
