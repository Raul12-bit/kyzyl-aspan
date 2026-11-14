import type { BBox } from '@/data/types';
import { TARGET_BOUNDS } from '@/features/intro/transition.config';
import { prefersReducedMotion } from '@/features/intro/introStore';
import { uiPadding } from './map.config';
import { useMapStore } from './mapStore';

/** Fly the shared map to a box, leaving room for the floating panels. */
export function flyToArea(bbox: BBox | null) {
  const map = useMapStore.getState().map;
  if (!map) return;
  const b = bbox ?? TARGET_BOUNDS;
  const east = b[0] <= b[2] ? b[2] : b[2] + 360;
  map.fitBounds(
    [
      [b[0], b[1]],
      [east, b[3]],
    ],
    { padding: uiPadding(), maxZoom: 8, duration: prefersReducedMotion() ? 0 : 1100, essential: false },
  );
}

export function zoomBy(delta: number) {
  const map = useMapStore.getState().map;
  if (!map) return;
  map.easeTo({ zoom: map.getZoom() + delta, duration: prefersReducedMotion() ? 0 : 260 });
}
