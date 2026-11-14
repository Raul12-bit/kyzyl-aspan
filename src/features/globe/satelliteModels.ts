import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type BufferGeometry,
  type Material,
} from 'three';

/**
 * Procedural satellite models, built from a few dozen primitives and two tiny canvas textures.
 * Shapes follow the real platforms closely enough to read at 30–60 px on screen:
 *   - `eos`: Terra / Aqua (MODIS) — a long gold-foil bus, an instrument deck on the nadir face,
 *     one large solar wing on a boom and a high-gain antenna.
 *   - `jpss`: Suomi NPP / NOAA-20 (VIIRS) — a compact silver bus, the boxy VIIRS instrument, one
 *     long three-panel wing.
 * A downloaded glTF of the same objects would be 2–10 MB; these cost nothing over the network.
 *
 * Local frame: −Z points at the Earth (nadir), +Y along the track, X across it. Unit: bus length ≈ 1.
 */
export type SatelliteKind = 'eos' | 'jpss';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** Crinkled multi-layer insulation: patches of lighter and darker foil. */
function foilTexture(base: string, light: string, dark: string): CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 128, 128);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    ctx.fillStyle = rnd() > 0.5 ? light : dark;
    ctx.globalAlpha = 0.18 + rnd() * 0.3;
    ctx.beginPath();
    const x = rnd() * 128;
    const y = rnd() * 128;
    ctx.moveTo(x, y);
    for (let k = 0; k < 4; k++) ctx.lineTo(x + (rnd() - 0.5) * 44, y + (rnd() - 0.5) * 44);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

/** Solar cells: deep blue tiles with hairline silver busbars. */
function cellTexture(cols: number, rows: number): CanvasTexture {
  const [c, ctx] = canvas(cols * 24, rows * 24);
  ctx.fillStyle = '#c9ccd2';
  ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const g = ctx.createLinearGradient(i * 24, j * 24, i * 24 + 24, j * 24 + 24);
      g.addColorStop(0, '#1d2f63');
      g.addColorStop(1, '#0c1634');
      ctx.fillStyle = g;
      ctx.fillRect(i * 24 + 1, j * 24 + 1, 22, 22);
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

interface Kit {
  gold: MeshStandardMaterial;
  silver: MeshStandardMaterial;
  white: MeshStandardMaterial;
  dark: MeshStandardMaterial;
  panel: MeshStandardMaterial;
  frame: MeshStandardMaterial;
}

function kit(): Kit {
  return {
    gold: new MeshStandardMaterial({ map: foilTexture('#b98a34', '#f2cf7c', '#7a5418'), metalness: 0.75, roughness: 0.36 }),
    silver: new MeshStandardMaterial({ map: foilTexture('#b9bcc2', '#f1f2f4', '#7d8189'), metalness: 0.7, roughness: 0.4 }),
    white: new MeshStandardMaterial({ color: '#eceae4', metalness: 0.05, roughness: 0.6 }),
    dark: new MeshStandardMaterial({ color: '#1c1d21', metalness: 0.3, roughness: 0.55 }),
    panel: new MeshStandardMaterial({ map: cellTexture(8, 3), metalness: 0.55, roughness: 0.28, side: DoubleSide }),
    frame: new MeshStandardMaterial({ color: '#9a9ca2', metalness: 0.85, roughness: 0.35 }),
  };
}

function box(w: number, h: number, d: number, mat: Material, x = 0, y = 0, z = 0): Mesh {
  const m = new Mesh(new BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function rod(length: number, radius: number, mat: Material): Mesh<BufferGeometry, Material> {
  return new Mesh(new CylinderGeometry(radius, radius, length, 8), mat);
}

/** Parabolic-looking dish from an open cone, rim facing +Z. */
function dish(radius: number, mat: Material): Mesh {
  const m = new Mesh(new CylinderGeometry(radius, radius * 0.18, radius * 0.45, 24, 1, true), mat);
  m.rotation.x = Math.PI / 2;
  return m;
}

function buildEos(k: Kit): Group {
  const g = new Group();
  // Bus: long gold box with a white instrument deck facing the Earth.
  g.add(box(0.5, 1.0, 0.46, k.gold));
  g.add(box(0.52, 0.94, 0.05, k.white, 0, 0, -0.25));
  // Instruments on the nadir deck (MODIS scan cavity, ASTER/MISR-like boxes).
  g.add(box(0.2, 0.22, 0.14, k.white, -0.12, 0.26, -0.33));
  g.add(box(0.16, 0.18, 0.12, k.silver, 0.13, 0.3, -0.32));
  g.add(box(0.24, 0.2, 0.1, k.white, 0.06, -0.12, -0.31));
  const scan = new Mesh(new CylinderGeometry(0.06, 0.06, 0.2, 16), k.dark);
  scan.rotation.z = Math.PI / 2;
  scan.position.set(-0.1, -0.3, -0.32);
  g.add(scan);
  // Solar wing on a boom, trailing the bus and tilted towards the sky.
  const boom = rod(0.5, 0.012, k.frame);
  boom.rotation.z = Math.PI / 2;
  boom.position.set(0.48, -0.32, 0.05);
  g.add(boom);
  const wing = new Group();
  wing.position.set(1.32, -0.32, 0.05);
  wing.rotation.x = -0.35;
  wing.add(box(1.36, 0.56, 0.012, k.panel));
  wing.add(box(1.4, 0.02, 0.02, k.frame, 0, 0.29, 0));
  wing.add(box(1.4, 0.02, 0.02, k.frame, 0, -0.29, 0));
  g.add(wing);
  // High-gain antenna on a mast.
  const mast = rod(0.32, 0.012, k.frame);
  mast.rotation.x = Math.PI / 2;
  mast.position.set(-0.18, 0.42, 0.38);
  g.add(mast);
  const hga = dish(0.13, k.white);
  hga.position.set(-0.18, 0.42, 0.56);
  g.add(hga);
  // Star trackers.
  const st = rod(0.08, 0.03, k.dark);
  st.position.set(0.2, 0.52, 0.12);
  g.add(st);
  return g;
}

function buildJpss(k: Kit): Group {
  const g = new Group();
  // Bus: compact silver box, black radiator on one side.
  g.add(box(0.56, 0.62, 0.62, k.silver));
  g.add(box(0.02, 0.5, 0.5, k.dark, -0.29, 0, 0));
  // VIIRS: the boxy imager hanging under the bus, with its white rotating telescope housing.
  g.add(box(0.34, 0.3, 0.24, k.white, 0.04, 0.08, -0.43));
  const tele = new Mesh(new CylinderGeometry(0.08, 0.08, 0.3, 20), k.dark);
  tele.rotation.z = Math.PI / 2;
  tele.position.set(0.04, -0.1, -0.47);
  g.add(tele);
  g.add(box(0.18, 0.16, 0.14, k.gold, -0.14, 0.2, -0.36));
  // One long wing of three panels on a boom.
  const boom = rod(0.36, 0.012, k.frame);
  boom.rotation.z = Math.PI / 2;
  boom.position.set(0.46, 0, 0.12);
  g.add(boom);
  const wing = new Group();
  wing.position.set(1.36, 0, 0.12);
  wing.rotation.x = 0.25;
  for (let i = 0; i < 3; i++) wing.add(box(0.5, 0.46, 0.012, k.panel, -0.52 + i * 0.52, 0, 0));
  wing.add(box(1.58, 0.018, 0.018, k.frame, 0, 0.24, 0));
  wing.add(box(1.58, 0.018, 0.018, k.frame, 0, -0.24, 0));
  g.add(wing);
  // Omni / X-band antennas.
  const ant = dish(0.09, k.white);
  ant.position.set(-0.12, -0.2, 0.36);
  g.add(ant);
  const omni = rod(0.18, 0.01, k.frame);
  omni.rotation.x = Math.PI / 2;
  omni.position.set(0.18, 0.24, 0.4);
  g.add(omni);
  return g;
}

let shared: Kit | null = null;

/** Builds one satellite. Materials and textures are shared between instances. */
export function buildSatellite(kind: SatelliteKind): Group {
  shared ??= kit();
  const model = kind === 'eos' ? buildEos(shared) : buildJpss(shared);
  // Centre the wing-heavy model on its bus so it orbits around the body, not the panel.
  return model;
}

/** Releases the shared materials and textures (call once, when the scene is disposed). */
export function disposeSatelliteKit() {
  if (!shared) return;
  for (const m of Object.values(shared)) {
    m.map?.dispose();
    m.dispose();
  }
  shared = null;
}
