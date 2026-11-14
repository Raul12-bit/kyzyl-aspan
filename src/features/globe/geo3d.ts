/**
 * Coordinate conventions shared by the globe scene.
 *
 * Scene space is Y-up. A point on the unit sphere matches three.js SphereGeometry's UV layout, so an
 * equirectangular texture (u = 0 at 180°W) lines up with geography: lng 0° → +X, lng 90°E → −Z,
 * north pole → +Y. Orbit maths (src/domain/orbit.ts) uses Z-up Earth-centred frames; `fromEcef`
 * maps them into scene space with the same handedness, so the Earth's spin is a rotation about +Y.
 */
import type { Vec3 } from '@/domain/orbit';

const DEG = Math.PI / 180;

export function latLngToXYZ(lat: number, lng: number, r = 1): [number, number, number] {
  const phi = (lng + 180) * DEG;
  const theta = (90 - lat) * DEG;
  return [-r * Math.sin(theta) * Math.cos(phi), r * Math.cos(theta), r * Math.sin(theta) * Math.sin(phi)];
}

export function xyzToLatLng(x: number, y: number, z: number): { lat: number; lng: number } {
  const r = Math.hypot(x, y, z) || 1;
  const lat = Math.asin(Math.max(-1, Math.min(1, y / r))) / DEG;
  let lng = Math.atan2(z, -x) / DEG - 180;
  if (lng < -180) lng += 360;
  return { lat, lng };
}

/** Earth-centred (Z = north) → scene (Y = north). */
export function fromEcef(p: Vec3, scale: number): [number, number, number] {
  return [p.x * scale, p.z * scale, -p.y * scale];
}

/** Spin angle (rotation about +Y) that brings longitude `lng` to face +Z (the camera). */
export function spinToFace(lng: number): number {
  const [x, , z] = latLngToXYZ(0, lng);
  return -Math.atan2(x, z);
}

/** Shortest equivalent of `target` relative to `current` (both radians). */
export function nearestAngle(current: number, target: number): number {
  const twoPi = Math.PI * 2;
  let d = (target - current) % twoPi;
  if (d > Math.PI) d -= twoPi;
  if (d < -Math.PI) d += twoPi;
  return current + d;
}
