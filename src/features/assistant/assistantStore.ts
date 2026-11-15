import { create } from 'zustand';

/**
 * The in-app AI guide: the conversation, whether the panel is open, and the "live facts" that pages publish
 * (what AI #2, the Temporal Bridge or the live feed show right now) so the guide can talk about the visitor's screen.
 */
export type ChatRole = 'user' | 'assistant';

export interface ChatItem {
  id: number;
  role: ChatRole;
  text: string;
  /** Who wrote an answer: Gemini on the fact sheet, or the offline FAQ. */
  source?: 'gemini' | 'facts';
  /** A "run AI #2" card instead of text. */
  kind?: 'probe';
  error?: boolean;
}

interface ChatResponse {
  source: 'gemini' | 'facts';
  text: string;
}

interface AssistantState {
  open: boolean;
  items: ChatItem[];
  pending: boolean;
  facts: Record<string, string>;
  setOpen: (open: boolean) => void;
  /** A page publishes (or withdraws, with null) one live fact. */
  setFact: (key: string, value: string | null) => void;
  clear: () => void;
  addProbe: () => void;
  send: (text: string, ctx: { locale: string; ui: string; errorText: string }) => Promise<void>;
}

let nextId = 1;

export const useAssistant = create<AssistantState>((set, get) => ({
  open: false,
  items: [],
  pending: false,
  facts: {},
  setOpen: (open) => set({ open }),
  setFact: (key, value) =>
    set((s) => {
      if ((s.facts[key] ?? null) === value) return s;
      const facts = { ...s.facts };
      if (value === null) delete facts[key];
      else facts[key] = value;
      return { facts };
    }),
  clear: () => set({ items: [], pending: false }),
  addProbe: () =>
    set((s) => ({ items: [...s.items, { id: nextId++, role: 'assistant', text: '', kind: 'probe' }] })),
  send: async (text, ctx) => {
    const q = text.trim().slice(0, 1200);
    if (!q || get().pending) return;
    const user: ChatItem = { id: nextId++, role: 'user', text: q };
    set((s) => ({ items: [...s.items, user], pending: true }));
    // The last ten text turns (cards and failed answers are not part of the conversation the model sees).
    const messages = get()
      .items.filter((i) => !i.kind && !i.error)
      .slice(-10)
      .map((i) => ({ role: i.role, text: i.text.slice(0, 1200) }));
    while (messages.length && messages[0]!.role !== 'user') messages.shift();
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages,
          locale: ctx.locale,
          page: `${window.location.pathname}${window.location.hash}`.slice(0, 80),
          facts: Object.values(get().facts).slice(0, 8),
          ui: ctx.ui.slice(0, 600),
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ChatResponse;
      set((s) => ({
        items: [...s.items, { id: nextId++, role: 'assistant', text: data.text, source: data.source }],
        pending: false,
      }));
    } catch {
      set((s) => ({
        items: [...s.items, { id: nextId++, role: 'assistant', text: ctx.errorText, error: true }],
        pending: false,
      }));
    }
  },
}));

/** Publishes a live fact while the calling component is mounted (withdrawn on unmount). */
export function publishFact(key: string, value: string | null) {
  useAssistant.getState().setFact(key, value);
}
