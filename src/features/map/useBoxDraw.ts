import { useEffect } from 'react';
import type { BBox } from '@/data/types';
import { bboxWidth, normalizeBBox } from '@/lib/geo';
import { setSelection } from './layers';
import { useMapStore } from './mapStore';

/** Smallest box accepted from a drag, degrees. */
const MIN_SIZE = 0.1;

/**
 * Box drawing without plugins: while `drawing` is on, pointer drags on the map draw a rectangle
 * (mouse, pen or touch). Esc cancels. The finished box is reported through `onDone`.
 */
export function useBoxDraw(onDone: (bbox: BBox) => void, current: BBox | null) {
  const map = useMapStore((s) => s.map);
  const drawing = useMapStore((s) => s.drawing);
  const setDrawing = useMapStore((s) => s.setDrawing);

  useEffect(() => {
    if (!map || !drawing) return;
    const container = map.getCanvasContainer();
    const canvas = map.getCanvas();
    let start: [number, number] | null = null;
    let pointerId: number | null = null;

    map.dragPan.disable();
    map.boxZoom.disable();
    map.doubleClickZoom.disable();
    canvas.style.cursor = 'crosshair';

    const lngLat = (e: PointerEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      const p = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
      return [p.lng, p.lat];
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      start = lngLat(e);
      pointerId = e.pointerId;
      container.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    };
    const onMove = (e: PointerEvent) => {
      if (!start || e.pointerId !== pointerId) return;
      setSelection(map, normalizeBBox(start, lngLat(e)));
    };
    const onUp = (e: PointerEvent) => {
      if (!start || e.pointerId !== pointerId) return;
      const box = normalizeBBox(start, lngLat(e));
      start = null;
      pointerId = null;
      if (container.hasPointerCapture(e.pointerId)) container.releasePointerCapture(e.pointerId);
      if (bboxWidth(box) >= MIN_SIZE && box[3] - box[1] >= MIN_SIZE) {
        setDrawing(false);
        onDone(box);
      } else {
        setSelection(map, current);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      start = null;
      setSelection(map, current);
      setDrawing(false);
    };

    container.addEventListener('pointerdown', onDown, true);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerup', onUp);
    container.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      container.removeEventListener('pointerdown', onDown, true);
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerup', onUp);
      container.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey);
      map.dragPan.enable();
      map.boxZoom.enable();
      map.doubleClickZoom.enable();
      canvas.style.cursor = '';
    };
  }, [map, drawing, setDrawing, onDone, current]);
}
