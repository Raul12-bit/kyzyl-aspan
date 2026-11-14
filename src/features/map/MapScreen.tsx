import { introSelectors } from '@/features/intro/introMachine';
import { useIntroStore } from '@/features/intro/introStore';
import { useReveal } from '@/features/intro/useReveal';

/** Map screen UI (stage 2 placeholder: verifies the reveal choreography). */
export function MapScreen() {
  const mounted = useIntroStore(introSelectors.uiMounted);
  const a = useReveal(1);
  const b = useReveal(2);
  const c = useReveal(3);
  if (!mounted) return null;
  return (
    <main id="main" className="pointer-events-none fixed inset-0 z-10">
      <div {...a} className={`${a.className} glass pointer-events-auto absolute left-6 top-24 h-[420px] w-[360px]`} />
      <div {...b} className={`${b.className} glass pointer-events-auto absolute right-6 top-24 h-[260px] w-[288px]`} />
      <div {...c} className={`${c.className} glass pointer-events-auto absolute bottom-6 left-6 right-6 h-[96px]`} />
    </main>
  );
}
