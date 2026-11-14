import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Raycaster,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  BoxGeometry,
  type Texture,
} from 'three';
import type { CountryShape } from '@/domain/countries';
import { EARTH_RADIUS_KM, EARTH_ROTATION, FLEET, periodSec, positionEci, type Satellite } from '@/domain/orbit';
import { paintEarth, paintPlaceholder } from './earthTexture';
import { fromEcef, latLngToXYZ, nearestAngle, spinToFace, xyzToLatLng } from './geo3d';

export type Quality = 'high' | 'low';

export interface EarthSceneOptions {
  quality: Quality;
  reducedMotion: boolean;
  /** Screen-space label elements that follow the two satellites (MODIS, VIIRS). */
  labels?: Partial<Record<'MODIS' | 'VIIRS', HTMLElement>>;
  onHoverEarth?: (over: boolean) => void;
  /** Click (not drag) on the planet. */
  onPick?: (lat: number, lng: number, screen: { x: number; y: number }) => void;
}

const SENSOR_COLOR = { MODIS: new Color('#3ddbd9'), VIIRS: new Color('#9aa6ff') } as const;
/** Satellites drawn: one representative platform per sensor. */
const SHOWN: Record<'MODIS' | 'VIIRS', Satellite> = {
  MODIS: FLEET.find((s) => s.id === 'terra')!,
  VIIRS: FLEET.find((s) => s.id === 'snpp')!,
};
/** Orbit altitude is exaggerated ×2.6 so the satellites read at a glance. */
const ALTITUDE_EXAGGERATION = 2.6;
/** Simulation speed: one Terra orbit takes ~25 s on screen. */
const TIME_WARP = 240;
/** Base angular speed of the idle spin, rad/s (on top of the simulated Earth rotation). */
const IDLE_SPIN = 0.045;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeInQuart = (t: number) => t * t * t * t;

const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDirW = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const earthFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSunDir;
  uniform vec3 uRim;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    vec3 base = texture2D(uMap, vUv).rgb;
    float sun = dot(normalize(vNormalW), uSunDir);
    float light = 0.42 + 0.9 * smoothstep(-0.25, 0.75, sun);
    float fres = pow(1.0 - max(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0), 2.6);
    vec3 col = base * light + uRim * fres * 0.32;
    gl_FragColor = vec4(col, uOpacity);
  }
`;

const atmosphereFragment = /* glsl */ `
  uniform vec3 uInner;
  uniform vec3 uOuter;
  uniform float uIntensity;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    float d = dot(normalize(vNormalW), normalize(vViewDirW));
    float glow = pow(clamp(1.0 + d * 1.6, 0.0, 1.0), 4.0);
    vec3 col = mix(uOuter, uInner, glow);
    gl_FragColor = vec4(col, glow * uIntensity);
  }
`;

const atmosphereVertex = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDirW = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fireVertex = /* glsl */ `
  attribute float aWeight;
  attribute float aPhase;
  uniform float uTime;
  uniform float uScale;
  uniform float uFade;
  varying float vWeight;
  varying float vFlicker;
  void main() {
    vWeight = aWeight;
    vFlicker = 0.72 + 0.28 * sin(uTime * (2.2 + aPhase) + aPhase * 6.2831);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = (3.0 + aWeight * 13.0) * uScale * uFade / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const fireFragment = /* glsl */ `
  varying float vWeight;
  varying float vFlicker;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    vec3 hot = mix(vec3(1.0, 0.32, 0.21), vec3(1.0, 0.82, 0.55), smoothstep(0.25, 0.0, d));
    gl_FragColor = vec4(hot * vFlicker, a * (0.35 + 0.65 * vWeight));
  }
`;

interface SatVisual {
  sat: Satellite;
  group: Group;
  trail: Line;
  trailPositions: Float32Array;
  cone: Mesh;
  orbit: LineLoop<BufferGeometry, LineBasicMaterial>;
  label?: HTMLElement;
  sensor: 'MODIS' | 'VIIRS';
}

/**
 * The intro planet. Imperative three.js, mounted once by GlobeCanvas, disposed when the dive ends.
 * Draw calls: Earth, atmosphere, fire points, two satellites (body + panels + cone), two orbits and
 * two trails — about a dozen, cheap enough for phones.
 */
export class EarthScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly tilt = new Group();
  private readonly spin = new Group();
  private readonly earth: Mesh<SphereGeometry, ShaderMaterial>;
  private readonly atmosphere: Mesh<SphereGeometry, ShaderMaterial>;
  private fires: Points<BufferGeometry, ShaderMaterial> | null = null;
  private readonly sats: SatVisual[] = [];
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private texture: Texture;
  private raf = 0;
  private running = false;
  private last = 0;
  private simTime = 0;
  private spinAngle = 0;
  private spinVelocity = 0;
  private tiltAngle = 0.32;
  private cameraDistance = 3.4;
  private drag: { x: number; y: number; t: number; moved: number; lastX: number; lastY: number; lastT: number } | null = null;
  private hoverDirty = false;
  private overEarth = false;
  private dive: {
    start: number;
    duration: number;
    from: { spin: number; tilt: number; dist: number };
    to: { spin: number; tilt: number; dist: number };
    resolve: () => void;
  } | null = null;
  private readonly opts: EarthSceneOptions;
  private readonly host: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly onVisibility = () => (document.hidden ? this.pause() : this.resume());
  private disposed = false;
  /** Where the planet sits: centre offset as a share of the viewport, radius as a share of the short side. */
  private frameSpec = { x: 0, y: 0, size: 0.8 };
  private baseDistance = 4.4;
  /** 1 = framed beside the copy, 0 = centred (the dive slides it to the middle). */
  private offsetBlend = 1;

  constructor(host: HTMLElement, opts: EarthSceneOptions) {
    this.host = host;
    this.opts = opts;
    const low = opts.quality === 'low';
    this.renderer = new WebGLRenderer({ antialias: !low, alpha: true, powerPreference: low ? 'low-power' : 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, low ? 1.5 : 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;display:block';
    host.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(32, 1, 0.01, 100);
    this.camera.position.set(0, 0, this.cameraDistance);

    this.scene.add(this.tilt);
    this.tilt.add(this.spin);
    this.tilt.rotation.x = this.tiltAngle;

    const segments = low ? [48, 32] : [96, 64];
    this.texture = this.makeTexture(paintPlaceholder(low ? 1024 : 2048));
    this.earth = new Mesh(
      new SphereGeometry(1, segments[0], segments[1]),
      new ShaderMaterial({
        vertexShader: earthVertex,
        fragmentShader: earthFragment,
        uniforms: {
          uMap: { value: this.texture },
          uSunDir: { value: new Vector3(-0.55, 0.45, 0.7).normalize() },
          uRim: { value: new Color('#ff5a3a') },
          uOpacity: { value: 1 },
        },
      }),
    );
    this.spin.add(this.earth);

    this.atmosphere = new Mesh(
      new SphereGeometry(1.1, segments[0], segments[1]),
      new ShaderMaterial({
        vertexShader: atmosphereVertex,
        fragmentShader: atmosphereFragment,
        uniforms: {
          // “Kyzyl Aspan” — the red sky: a warm limb glow fading into night blue.
          uInner: { value: new Color('#ff6a3d') },
          uOuter: { value: new Color('#2b3f8f') },
          uIntensity: { value: 0.75 },
        },
        side: BackSide,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    this.tilt.add(this.atmosphere);

    this.buildSatellites();
    this.bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
  }

  /* ------------------------------------------------------------------ content */

  private makeTexture(canvas: HTMLCanvasElement): Texture {
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    return t;
  }

  setCountries(countries: readonly CountryShape[]) {
    if (this.disposed) return;
    const next = this.makeTexture(paintEarth(countries, this.opts.quality === 'low' ? 1024 : 2048));
    this.earth.material.uniforms.uMap!.value = next;
    this.texture.dispose();
    this.texture = next;
  }

  setFires(points: readonly [number, number, number][]) {
    if (this.disposed) return;
    const n = points.length;
    const pos = new Float32Array(n * 3);
    const weight = new Float32Array(n);
    const phase = new Float32Array(n);
    points.forEach(([lng, lat, w], i) => {
      const [x, y, z] = latLngToXYZ(lat, lng, 1.004);
      pos.set([x, y, z], i * 3);
      weight[i] = w;
      phase[i] = ((i * 2654435761) % 1000) / 1000;
    });
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('aWeight', new BufferAttribute(weight, 1));
    geo.setAttribute('aPhase', new BufferAttribute(phase, 1));
    const mat = new ShaderMaterial({
      vertexShader: fireVertex,
      fragmentShader: fireFragment,
      uniforms: { uTime: { value: 0 }, uScale: { value: 300 }, uFade: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    if (this.fires) {
      this.spin.remove(this.fires);
      this.fires.geometry.dispose();
      this.fires.material.dispose();
    }
    this.fires = new Points(geo, mat);
    this.fires.renderOrder = 2;
    this.spin.add(this.fires);
    this.resize();
  }

  private buildSatellites() {
    const body = new BoxGeometry(0.028, 0.028, 0.044);
    const panel = new PlaneGeometry(0.085, 0.026);
    for (const sensor of ['MODIS', 'VIIRS'] as const) {
      const sat = SHOWN[sensor];
      const color = SENSOR_COLOR[sensor];
      const group = new Group();
      group.add(new Mesh(body, new MeshBasicMaterial({ color: '#e8ecf4' })));
      const panelMat = new MeshBasicMaterial({ color, side: 2, transparent: true, opacity: 0.95 });
      const left = new Mesh(panel, panelMat);
      left.position.x = -0.062;
      const right = new Mesh(panel, panelMat);
      right.position.x = 0.062;
      group.add(left, right);

      // Swath cone: apex at the satellite, base on the ground, width = sensor swath.
      const r = this.orbitRadius(sat);
      const height = r - 0.995;
      const swath = sat.swathKm / EARTH_RADIUS_KM / 2;
      const cone = new Mesh(
        new ConeGeometry(Math.sin(swath), height, 32, 1, true),
        new MeshBasicMaterial({ color, transparent: true, opacity: 0.09, depthWrite: false, blending: AdditiveBlending, side: 2 }),
      );
      cone.position.y = -height / 2;
      group.add(cone);
      this.tilt.add(group);

      // Orbit ring in the satellite's (inertial) plane.
      const ringPts = new Float32Array(257 * 3);
      const period = periodSec(sat);
      for (let i = 0; i <= 256; i++) {
        const p = fromEcef(positionEci(sat, (i / 256) * period), 1 / EARTH_RADIUS_KM);
        const k = r / Math.hypot(p[0], p[1], p[2]);
        ringPts.set([p[0] * k, p[1] * k, p[2] * k], i * 3);
      }
      const ringGeo = new BufferGeometry();
      ringGeo.setAttribute('position', new BufferAttribute(ringPts, 3));
      const orbit = new LineLoop(ringGeo, new LineBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }));
      this.tilt.add(orbit);

      // Trail: a short bright arc behind the satellite (vertex colours fade to black under additive blending).
      const TRAIL = 48;
      const trailPositions = new Float32Array(TRAIL * 3);
      const colors = new Float32Array(TRAIL * 3);
      for (let i = 0; i < TRAIL; i++) {
        const f = (1 - i / (TRAIL - 1)) ** 1.6;
        colors.set([color.r * f, color.g * f, color.b * f], i * 3);
      }
      const trailGeo = new BufferGeometry();
      trailGeo.setAttribute('position', new BufferAttribute(trailPositions, 3));
      trailGeo.setAttribute('color', new BufferAttribute(colors, 3));
      const trail = new Line(trailGeo, new LineBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false }));
      this.tilt.add(trail);

      this.sats.push({ sat, group, trail, trailPositions, cone, orbit, label: this.opts.labels?.[sensor], sensor });
    }
  }

  private orbitRadius(sat: Satellite): number {
    return 1 + (sat.altitudeKm / EARTH_RADIUS_KM) * ALTITUDE_EXAGGERATION;
  }

  private satPosition(sat: Satellite, t: number, out: Vector3): Vector3 {
    const p = fromEcef(positionEci(sat, t), 1 / EARTH_RADIUS_KM);
    const k = this.orbitRadius(sat) / Math.hypot(p[0], p[1], p[2]);
    return out.set(p[0] * k, p[1] * k, p[2] * k);
  }

  /* ------------------------------------------------------------------ interaction */

  private bindPointer() {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancel);
    el.addEventListener('pointerleave', this.onLeave);
  }

  private setPointer(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private hitEarth(): Vector3 | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.earth, false)[0];
    return hit ? hit.point : null;
  }

  private onDown = (e: PointerEvent) => {
    if (this.dive) return;
    this.setPointer(e);
    if (!this.hitEarth()) return;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    const now = performance.now();
    this.drag = { x: e.clientX, y: e.clientY, t: now, moved: 0, lastX: e.clientX, lastY: e.clientY, lastT: now };
    this.spinVelocity = 0;
  };

  private onMove = (e: PointerEvent) => {
    this.setPointer(e);
    if (!this.drag) {
      this.hoverDirty = true;
      return;
    }
    const d = this.drag;
    const now = performance.now();
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    const size = Math.min(this.host.clientWidth, this.host.clientHeight) || 1;
    const k = 3.2 / size;
    this.spinAngle += dx * k;
    this.tiltAngle = Math.max(-0.9, Math.min(0.9, this.tiltAngle + dy * k));
    const dt = Math.max(1, now - d.lastT);
    this.spinVelocity = ((dx * k) / dt) * 1000;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.lastT = now;
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const quick = performance.now() - d.t < 450;
    if (d.moved < 7 && quick) {
      this.spinVelocity = 0;
      this.setPointer(e);
      const p = this.hitEarth();
      if (p) {
        const local = this.earth.worldToLocal(p.clone());
        const { lat, lng } = xyzToLatLng(local.x, local.y, local.z);
        this.opts.onPick?.(lat, lng, { x: e.clientX, y: e.clientY });
      }
    }
  };

  private onCancel = () => {
    this.drag = null;
  };

  private onLeave = () => {
    if (this.overEarth) {
      this.overEarth = false;
      this.opts.onHoverEarth?.(false);
      this.renderer.domElement.style.cursor = '';
    }
  };

  /** Latitude/longitude currently facing the camera. */
  facing(): { lat: number; lng: number } {
    const v = new Vector3(0, 0, 1);
    this.pointer.set(0, 0);
    const p = this.hitEarth();
    if (p) v.copy(this.earth.worldToLocal(p.clone()));
    return xyzToLatLng(v.x, v.y, v.z);
  }

  setFrame(spec: { x: number; y: number; size: number }) {
    this.frameSpec = spec;
    this.resize();
  }

  /* ------------------------------------------------------------------ dive */

  /**
   * Turns the target to face the camera and plunges towards it. The rotation eases in-out; the
   * distance eases in hard (quartic), so the last frames rush at the ground before the white flash.
   */
  diveTo(target: { lat: number; lng: number }, durationMs: number): Promise<void> {
    if (this.opts.reducedMotion) return Promise.resolve();
    return new Promise((resolve) => {
      const spinTarget = nearestAngle(this.spinAngle, spinToFace(target.lng) - this.earthSpin());
      this.spinVelocity = 0;
      this.drag = null;
      this.dive = {
        start: performance.now(),
        duration: durationMs,
        from: { spin: this.spinAngle, tilt: this.tiltAngle, dist: this.cameraDistance },
        to: { spin: spinTarget, tilt: (target.lat * Math.PI) / 180, dist: 1.06 },
        resolve,
      };
      this.resume();
    });
  }

  /** Rotation of the Earth since the epoch (sidereal), so the user's spin is an offset on top. */
  private earthSpin(): number {
    return EARTH_ROTATION * this.simTime;
  }

  /* ------------------------------------------------------------------ loop */

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private pause() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private resume() {
    if (document.hidden || this.disposed) return;
    this.start();
  }

  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();

  private frame = (now: number) => {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const reduced = this.opts.reducedMotion;

    if (!reduced && !this.dive) this.simTime += dt * TIME_WARP;

    if (this.dive) {
      const d = this.dive;
      const t = Math.min(1, (now - d.start) / d.duration);
      const r = easeInOutCubic(Math.min(1, t * 1.25));
      this.spinAngle = d.from.spin + (d.to.spin - d.from.spin) * r;
      this.tiltAngle = d.from.tilt + (d.to.tilt - d.from.tilt) * r;
      this.cameraDistance = d.from.dist + (d.to.dist - d.from.dist) * easeInQuart(t);
      this.offsetBlend = 1 - easeInOutCubic(Math.min(1, t * 1.6));
      this.applyViewOffset();
      const fade = 1 - Math.min(1, t * 1.8);
      for (const s of this.sats) {
        s.group.visible = fade > 0.02;
        s.orbit.material.opacity = 0.22 * fade;
        if (s.label) s.label.style.opacity = String(fade);
      }
      this.atmosphere.material.uniforms.uIntensity!.value = 0.75 * (1 - t * 0.6);
      // Point sprites grow as 1/distance; shrink them so the last frames are not a wall of orange.
      if (this.fires) this.fires.material.uniforms.uFade!.value = Math.max(0.15, 1 - easeInQuart(t) * 0.9) * (this.cameraDistance / 3.4);
      if (t >= 1) {
        this.dive = null;
        d.resolve();
      }
    } else if (!this.drag) {
      if (!reduced) this.spinAngle += (IDLE_SPIN + this.spinVelocity) * dt;
      this.spinVelocity *= Math.pow(0.04, dt); // inertia decays to ~4% per second
      // Ease the tilt back towards a pleasant default when the user lets go.
      this.tiltAngle += (0.32 - this.tiltAngle) * Math.min(1, dt * 0.6);
    }

    this.spin.rotation.y = this.spinAngle + this.earthSpin();
    this.tilt.rotation.x = this.tiltAngle;
    this.camera.position.set(0, 0, this.cameraDistance);
    this.camera.lookAt(0, 0, 0);

    if (this.fires) this.fires.material.uniforms.uTime!.value = now / 1000;

    this.updateSatellites();

    if (this.hoverDirty && !this.dive) {
      this.hoverDirty = false;
      const over = this.hitEarth() !== null;
      if (over !== this.overEarth) {
        this.overEarth = over;
        this.renderer.domElement.style.cursor = over ? 'pointer' : '';
        this.opts.onHoverEarth?.(over);
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.frame);
  };

  private updateSatellites() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.tilt.updateMatrixWorld();
    for (const s of this.sats) {
      const pos = this.satPosition(s.sat, this.simTime, this.tmp);
      s.group.position.copy(pos);
      // Point the cone at the Earth's centre and keep the panels across-track.
      s.group.up.set(0, 1, 0);
      // lookAt works in world space: aim +Z away from the planet's centre.
      s.group.lookAt(this.tmp2.copy(pos).multiplyScalar(2).applyMatrix4(this.tilt.matrixWorld));
      s.group.rotateX(Math.PI / 2);

      // Trail: positions over the last few simulated minutes.
      const n = s.trailPositions.length / 3;
      for (let i = 0; i < n; i++) {
        const p = this.satPosition(s.sat, this.simTime - i * 22, this.tmp2);
        s.trailPositions.set([p.x, p.y, p.z], i * 3);
      }
      (s.trail.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;

      // Screen label, hidden when the satellite is behind the planet.
      if (s.label) {
        const world = this.tmp2.copy(pos).applyMatrix4(this.tilt.matrixWorld);
        const toSat = world.clone().sub(this.camera.position);
        const dist = toSat.length();
        toSat.normalize();
        // Ray-sphere test against the unit Earth.
        const b = this.camera.position.dot(toSat);
        const c = this.camera.position.lengthSq() - 1;
        const disc = b * b - c;
        const hidden = disc > 0 && -b - Math.sqrt(disc) < dist && -b - Math.sqrt(disc) > 0;
        const ndc = world.project(this.camera);
        const x = (ndc.x * 0.5 + 0.5) * w;
        const y = (-ndc.y * 0.5 + 0.5) * h;
        s.label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        s.label.dataset.hidden = hidden ? 'true' : 'false';
      }
    }
  }

  private applyViewOffset() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    const k = this.offsetBlend;
    if (k <= 0.001) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, -this.frameSpec.x * w * k, -this.frameSpec.y * h * k, w, h);
  }

  private resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = 32;
    // Distance at which the unit planet's radius spans frameSpec.size × half the short side:
    // R_px = (h / 2) / (D · tan(fov / 2)).
    const tanHalf = Math.tan((this.camera.fov / 2) * (Math.PI / 180));
    this.baseDistance = h / (2 * tanHalf * this.frameSpec.size * 0.5 * Math.min(w, h));
    if (!this.dive) this.cameraDistance = this.baseDistance;
    this.applyViewOffset();
    this.camera.updateProjectionMatrix();
    if (this.fires) this.fires.material.uniforms.uScale!.value = h * this.renderer.getPixelRatio() * 0.005;
  }

  dispose() {
    this.disposed = true;
    this.pause();
    this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointercancel', this.onCancel);
    el.removeEventListener('pointerleave', this.onLeave);
    this.scene.traverse((o) => {
      const mesh = o as Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as { dispose?: () => void } | { dispose?: () => void }[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
      else mat?.dispose?.();
    });
    this.texture.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    el.remove();
  }
}
