import { useEffect } from 'react';
import { useI18n, useLocaleStore } from '@/i18n';
import { Button, Icon, IconButton, Spinner } from '@/ui';
import { geolocationSupported, syncGeoPermission, useGeoStore } from './geoStore';

/**
 * Entry consent card + result toast. The native browser prompt is only triggered by the visitor's
 * click on "Use location": browsers quiet or block prompts that fire on page load, and a denied
 * native prompt can never be asked again.
 */
export function LocationPrompt({ placement = 'intro' }: { placement?: 'intro' | 'page' }) {
  const { m, fmt } = useI18n();
  const consent = useGeoStore((s) => s.consent);
  const status = useGeoStore((s) => s.status);
  const notice = useGeoStore((s) => s.notice);
  const locate = useGeoStore((s) => s.locate);
  const decline = useGeoStore((s) => s.decline);
  const dismiss = useGeoStore((s) => s.dismissNotice);

  useEffect(() => {
    void syncGeoPermission();
  }, []);

  // Toasts leave on their own.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(dismiss, notice.switchedTo ? 9000 : 6000);
    return () => window.clearTimeout(id);
  }, [notice, dismiss]);

  const position =
    placement === 'intro'
      ? 'right-[var(--el-gutter)] bottom-[calc(env(safe-area-inset-bottom)+16px)] md:right-12 md:bottom-10 lg:right-16'
      : 'right-[var(--el-gutter)] bottom-6';

  const showAsk = consent === 'unknown' && geolocationSupported();
  if (!showAsk && !notice) return null;

  return (
    <div
      className={`pointer-events-auto fixed ${position} w-[min(380px,calc(100vw-2*var(--el-gutter)))]`}
      style={{ zIndex: 'var(--el-z-popover)' as unknown as number, animation: 'el-float-in 520ms var(--el-ease-emphasized) both' }}
      role={showAsk ? 'dialog' : 'status'}
      aria-live="polite"
      aria-labelledby={showAsk ? 'geo-title' : undefined}
    >
      {showAsk ? (
        <div className="glass p-4 md:p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 flex-none place-items-center rounded-[12px] border border-[rgb(255_82_54/0.35)] bg-[rgb(255_82_54/0.1)] text-kyzyl">
              <Icon name="pin" size={20} />
            </span>
            <div className="min-w-0">
              <h2 id="geo-title" className="m-0 text-[15px] font-semibold leading-snug text-ink">
                {m.geo.title}
              </h2>
              <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-ink-muted">{m.geo.body}</p>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" size="sm" className="flex-1" disabled={status === 'locating'} onClick={() => void locate()}>
              {status === 'locating' ? (
                <>
                  <Spinner size={14} label={m.geo.locating} />
                  {m.geo.locating}
                </>
              ) : (
                m.geo.allow
              )}
            </Button>
            <Button variant="quiet" size="sm" onClick={decline} disabled={status === 'locating'}>
              {m.geo.deny}
            </Button>
          </div>
        </div>
      ) : notice ? (
        <div className="glass flex items-start gap-3 p-3.5 pr-2">
          <span className="mt-0.5 flex-none text-kyzyl">
            <Icon name={notice.kind === 'found' ? 'pin' : 'globe'} size={18} />
          </span>
          <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
            {notice.kind === 'found' && notice.country ? (
              <>
                <p className="m-0 font-semibold text-ink">{m.geo.found(fmt.country(notice.country))}</p>
                {notice.switchedTo ? (
                  <p className="m-0 text-ink-muted">
                    {m.geo.switched(fmt.language(notice.switchedTo))}{' '}
                    <button
                      type="button"
                      className="cursor-pointer border-0 bg-transparent p-0 font-semibold text-amber underline-offset-2 hover:underline"
                      onClick={() => {
                        if (notice.previous) void useLocaleStore.getState().setLocale(notice.previous, 'manual');
                        dismiss();
                      }}
                    >
                      {m.geo.undo}
                    </button>
                  </p>
                ) : null}
              </>
            ) : (
              <p className="m-0 text-ink-muted">
                {notice.kind === 'denied' ? m.geo.denied : notice.kind === 'outside' ? m.geo.outside : m.geo.error}
              </p>
            )}
          </div>
          <IconButton icon="close" size="sm" label={m.common.close} onClick={dismiss} />
        </div>
      ) : null}
    </div>
  );
}
