import { LOCALES, useI18n, useLocaleStore, type Locale } from '@/i18n';
import { Segmented } from '@/ui';

export function LanguageSwitch() {
  const { m } = useI18n();
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  return (
    <Segmented<Locale>
      label={m.app.language}
      value={locale}
      onChange={setLocale}
      options={LOCALES.map((l) => ({ value: l, label: l.toUpperCase() }))}
    />
  );
}
