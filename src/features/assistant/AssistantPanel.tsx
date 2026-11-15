import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ModelText } from '@/features/ai/ModelText';
import { useI18n } from '@/i18n';
import { Icon, IconButton } from '@/ui';
import { useAssistant } from './assistantStore';
import { LinkProbe } from './LinkProbe';
import './assistant.css';

/**
 * The AI guide panel: ask how the three AIs work and get answers grounded in the project's model reports (Gemini,
 * or the offline FAQ), with live facts from the page you are on — plus a card that runs the trained AI #2 network.
 */
export default function AssistantPanel() {
  const { m, locale } = useI18n();
  const t = m.assistant;
  const open = useAssistant((s) => s.open);
  const items = useAssistant((s) => s.items);
  const pending = useAssistant((s) => s.pending);
  const { setOpen, send, addProbe, clear } = useAssistant.getState();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Names of the site's tabs and cards in the visitor's language, so answers point at what they can click.
  const ui = useMemo(() => {
    const tabs = m.ai.lab.tabs;
    return [
      `Pages: ${m.app.nav.map}; ${m.app.nav.ai}; ${m.app.nav.method}.`,
      `AI lab tabs: ${[tabs.system, tabs.bridge, tabs.ai1, tabs.ai2, tabs.ai3, tabs.fusion].join('; ')}.`,
      `Card in this chat: "${t.probe.open}". Map layer: "${m.map.live.label}".`,
    ].join(' ');
  }, [m, t.probe.open]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items.length, pending]);

  if (!open) return null;

  const ask = (text: string) => {
    void send(text, { locale, ui, errorText: t.error });
    setDraft('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (draft.trim()) ask(draft);
    }
  };
  const asked = new Set(items.filter((i) => i.role === 'user').map((i) => i.text));
  const fresh = items.length === 0;

  return (
    <aside className="chat" role="dialog" aria-modal="false" aria-label={t.title}>
      <header className="chat__head">
        <span className="chat__mark" aria-hidden>
          <Icon name="sparkles" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="chat__title">{t.title}</p>
          <p className="chat__sub">{t.subtitle}</p>
        </div>
        {items.length ? <IconButton icon="refresh" size="sm" ghost label={t.clear} onClick={clear} /> : null}
        <IconButton icon="close" size="sm" ghost label={t.close} onClick={() => setOpen(false)} />
      </header>

      <div ref={listRef} className="chat__list" aria-live="polite">
        <div className="chat__msg" data-role="assistant">
          <p className="m-0">{t.greeting}</p>
        </div>
        {items.map((i) =>
          i.kind === 'probe' ? (
            <LinkProbe key={i.id} />
          ) : (
            <div key={i.id} className="chat__msg" data-role={i.role} data-error={i.error ? 'true' : 'false'}>
              {i.role === 'assistant' && !i.error ? (
                <ModelText text={i.text} />
              ) : (
                <p className="m-0">{i.text}</p>
              )}
              {i.role === 'assistant' && i.source ? (
                <span className="chat__source">{i.source === 'gemini' ? t.sourceGemini : t.sourceFacts}</span>
              ) : null}
            </div>
          ),
        )}
        {pending ? (
          <div className="chat__msg chat__typing" data-role="assistant" role="status">
            <span />
            <span />
            <span />
            <span className="sr-only">{t.thinking}</span>
          </div>
        ) : null}
      </div>

      <div className="chat__suggest">
        <button type="button" className="chat__chip chat__chip--probe" onClick={addProbe}>
          <Icon name="satellite" size={14} />
          {t.probe.open}
        </button>
        {(fresh ? t.suggestions : t.suggestions.filter((s) => !asked.has(s)).slice(0, 2)).map((s) => (
          <button key={s} type="button" className="chat__chip" disabled={pending} onClick={() => ask(s)}>
            {s}
          </button>
        ))}
      </div>

      <form
        className="chat__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) ask(draft);
        }}
      >
        <textarea
          ref={inputRef}
          className="chat__input"
          rows={1}
          maxLength={1200}
          value={draft}
          placeholder={t.placeholder}
          aria-label={t.placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          className="chat__send"
          disabled={!draft.trim() || pending}
          aria-label={t.send}
          title={t.send}
        >
          <Icon name="arrowRight" size={16} />
        </button>
      </form>
    </aside>
  );
}
