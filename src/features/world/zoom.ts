/* Zoom rules of the world map (kept apart from components for fast refresh). */

/** From this zoom the "detections" view shows every pixel; below it, server hexagons. */
export const POINTS_ZOOM = 7;
/** From this zoom the country under the map centre shows its regions (admin-1). */
export const REGION_ZOOM = 4.5;

const HEX_WIDTH_KM: Record<number, number> = { 2: 366, 3: 138, 4: 52, 5: 19.7, 6: 7.4, 7: 2.8 };

/** Finest H3 level whose cells are still ≥ 7 px wide at this zoom (512-px tiles: 78.3 km/px at z0). */
export function serverResForZoom(zoom: number): number {
  let res = 2;
  for (const r of [3, 4, 5, 6, 7]) if ((HEX_WIDTH_KM[r]! * 2 ** zoom) / 78.3 >= 7) res = r;
  return res;
}
