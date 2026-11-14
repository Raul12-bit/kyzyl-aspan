import { create } from 'zustand';
import { useAppParams } from '@/app/useAppParams';

/**
 * While the user drags the time slider or playback runs, the window lives here (fast, local).
 * It is committed to the URL when the interaction ends, so links stay shareable without
 * rewriting history ten times per second.
 */
interface TimeStore {
  live: [number, number] | null;
  playing: boolean;
  setLive: (range: [number, number] | null) => void;
  setPlaying: (playing: boolean) => void;
}

export const useTimeStore = create<TimeStore>((set) => ({
  live: null,
  playing: false,
  setLive: (live) => set({ live }),
  setPlaying: (playing) => set({ playing }),
}));

export function useEffectiveRange(): [number, number] {
  const { range } = useAppParams();
  const live = useTimeStore((s) => s.live);
  return live ?? range;
}
