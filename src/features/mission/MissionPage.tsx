import { useEffect } from 'react';
import { useI18n } from '@/i18n';
import { CueSection } from './CueSection';
import { DownlinkSection } from './DownlinkSection';
import { HeliosMissionSections } from './HeliosSections';
import { OnboardSection } from './OnboardSection';

/** /mission — the space-segment concepts (ideas 4–6), each a live simulation with its assumptions stated. */
export function MissionPage() {
  const { m } = useI18n();
  useEffect(() => {
    document.title = `${m.app.nav.mission} — ${m.app.name}`;
  }, [m]);
  return (
    <main id="main" className="page">
      <div className="page-inner">
        <header className="max-w-[760px]" style={{ animation: 'el-float-in 700ms var(--el-ease-emphasized) both' }}>
          <p className="eyebrow m-0">{m.mission.eyebrow}</p>
          <h1 className="display m-0 mt-4 text-[clamp(2rem,3.4vw+0.8rem,3.6rem)] text-ink">{m.mission.title}</h1>
          <div className="orbit-rule mt-6 w-24" aria-hidden />
          <p className="m-0 mt-5 max-w-[60ch] text-[16px] leading-relaxed text-ink-muted md:text-[17px]">{m.mission.lead}</p>
          <p className="chip mt-5 inline-flex">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-trust-medium" />
            {m.mission.badge}
          </p>
        </header>
        <div className="mt-12 grid gap-14 md:mt-16">
          <OnboardSection />
          <DownlinkSection />
          <CueSection />
          <HeliosMissionSections />
        </div>
      </div>
    </main>
  );
}
