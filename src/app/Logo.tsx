import { useI18n } from '@/i18n';

export function Logo({ compact = false }: { compact?: boolean }) {
  const { m } = useI18n();
  return (
    <span className="flex items-center gap-2.5">
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden className="flex-none">
        <defs>
          <linearGradient id="logo-ember" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#FFC061" />
            <stop offset=".55" stopColor="#FF8A3D" />
            <stop offset="1" stopColor="#F0532F" />
          </linearGradient>
        </defs>
        <circle cx="16" cy="16" r="11.5" fill="none" stroke="var(--el-teal)" strokeOpacity=".5" strokeWidth="1.2" />
        <path d="M5 19.5c3.4-1.1 6.2-5 11-5s7.6 3.9 11 5" fill="none" stroke="url(#logo-ember)" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="16" cy="14.5" r="2.4" fill="var(--el-amber-soft)" />
      </svg>
      {!compact ? <span className="text-[17px] font-semibold tracking-[-0.02em] text-ink">{m.app.name}</span> : null}
    </span>
  );
}
