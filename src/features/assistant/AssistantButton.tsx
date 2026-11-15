import { useI18n } from '@/i18n';
import { Icon } from '@/ui';
import { useAssistant } from './assistantStore';

/** Header button that opens the AI guide (text on wide screens, the sparkle alone on phones). */
export function AssistantButton() {
  const { m } = useI18n();
  const open = useAssistant((s) => s.open);
  const setOpen = useAssistant((s) => s.setOpen);
  return (
    <button
      type="button"
      className="ask-ai"
      aria-pressed={open}
      aria-label={m.assistant.open}
      title={m.assistant.subtitle}
      onClick={() => setOpen(!open)}
    >
      <Icon name="sparkles" size={15} />
      <span className="ask-ai__text">{m.assistant.open}</span>
    </button>
  );
}
