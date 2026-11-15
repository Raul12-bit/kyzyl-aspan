import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  ImageBitmapLoader,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  NoColorSpace,
  NormalBlending,
  PerspectiveCamera,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Raycaster,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Blending,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { CountryShape } from '@/domain/countries';
import { EARTH_RADIUS_KM, EARTH_ROTATION, FLEET, positionEci, type Satellite } from '@/domain/orbit';
import { paintEarth } from './earthTexture';
import { fromEcef, latLngToXYZ, nearestAngle, spinToFace, xyzToLatLng } from './geo3d';
import type { loadNasaSatellite as LoadNasaSatellite, NasaModel } from './nasaSatellites';
import { buildSatellite, disposeSatelliteKit, type SatelliteKind } from './satelliteModels';

export type Quality = 'high' | 'low';

export interface EarthSceneOptions {
  quality: Quality;
  reducedMotion: boolean;
  onHoverEarth?: (over: boolean) => void;
  /** Click (not drag) on the planet. */
  onPick?: (lat: number, lng: number, screen: { x: number; y: number }) => void;
  /** The daylight texture is on the GPU — the planet can be shown. */
  onReady?: () => void;
  /** Real-orbit playback moved to another 30-second step or changed speed (for the caption). */
  onConstellationTick?: (index: number, slow: boolean) => void;
}

/** NASA Blue Marble / Black Marble derived maps (public domain imagery, via the three.js examples). */
const TEXTURES = {
  day: '/textures/earth/earth_day_4096.jpg',
  night: '/textures/earth/earth_night_4096.jpg',
  specular: '/textures/earth/earth_specular_2048.jpg',
  clouds: '/textures/earth/earth_clouds_1024.png',
} as const;

/**
 * One satellite on its orbit: Terra (MODIS), the platform the 26-year record starts with in 2000.
 * High quality loads NASA's real model; the light profile (phones, data saver) keeps the procedural one.
 */
const SHOWN: { id: string; kind: SatelliteKind; model: NasaModel }[] = [{ id: 'terra', kind: 'eos', model: 'terra' }];
/** Render at most ~72 fps: 120–165 Hz screens would otherwise redraw the planet 2–3× more than needed. */
const MIN_FRAME_MS = 12.5;
/** Satellite trails change slowly: rebuild them every few rendered frames, not every frame. */
const TRAIL_EVERY = 4;
/** Orbit altitude is exaggerated so the satellites clear the atmosphere visibly. */
const ALTITUDE_EXAGGERATION = 2.4;
/** Simulation speed: one orbit takes ~50 s on screen. */
const TIME_WARP = 120;
/** Idle spin on top of the simulated rotation, rad/s. */
const IDLE_SPIN = 0.028;
/** Size of a procedural satellite model in scene units (Earth radius = 1). */
const SAT_SCALE = 0.04;
/** Longest side of a NASA model in scene units — matches the procedural ones (~0.11). */
const SAT_SIZE = 0.15;
/** Outer air shell radius (Earth = 1): wide enough for a soft halo. */
const ATMO_RADIUS = 1.1;
/** Sunlight comes from the upper left, slightly in front: most of the disc is lit, a crescent of night on the right. */
const SUN_DIR = new Vector3(-0.62, 0.38, 0.69).normalize();

/** The one look (the site is dark-only): additive air on black space, warm trail, crisp fires. */
const LOOK = {
  atmoInner: new Color('#a8d0ff'),
  atmoOuter: new Color('#3a6fe0'),
  atmoIntensity: 0.85,
  atmoBlending: AdditiveBlending as Blending,
  ambient: 0.035,
  trail: new Color('#f3a06a'),
  fireBlending: NormalBlending as Blending,
} as const;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeInCubic = (t: number) => t * t * t;

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

/**
 * Day/night Earth: lit daylight map, warm city lights on the night side, a sun glint on the oceans,
 * drifting clouds with a soft shadow, and an inner atmospheric rim. One draw call.
 */
const earthFragment = /* glsl */ `
  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform sampler2D uSpec;
  uniform sampler2D uClouds;
  uniform float uHasNight;
  uniform float uHasSpec;
  uniform float uHasClouds;
  uniform float uCloudShift;
  uniform vec3 uSunDir;
  uniform vec3 uAtmo;
  uniform float uAmbient;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(vViewDirW);
    float ndl = dot(n, uSunDir);
    float day = smoothstep(-0.12, 0.32, ndl);

    vec3 albedo = texture2D(uDay, vUv).rgb;
    vec2 cuv = vec2(vUv.x + uCloudShift, vUv.y);
    float cloud = uHasClouds * texture2D(uClouds, cuv).r;
    float cloudShadow = uHasClouds * texture2D(uClouds, cuv + vec2(0.0025, -0.002)).r;

    float diffuse = max(ndl, 0.0);
    vec3 col = albedo * (1.0 - 0.35 * cloudShadow) * (uAmbient + 1.15 * diffuse);

    // Sun glint on water (specular map = ocean mask): a small, quiet highlight.
    vec3 h = normalize(uSunDir + v);
    float water = uHasSpec * texture2D(uSpec, vUv).r;
    float nh = max(dot(n, h), 0.0);
    float glint = pow(nh, 700.0) * 0.28 * water * (1.0 - cloud);
    col += vec3(1.0, 0.9, 0.74) * glint * day;

    // Clouds catch the light (and stay faintly visible at night).
    col = mix(col, vec3(1.0) * (uAmbient * 0.6 + 1.05 * diffuse), cloud * 0.9);

    // City lights: Black Marble, warmed to gold, only where the sun has set.
    // The Black Marble map has a faint non-black floor; cut it so only real lights glow.
    vec3 lights = max(texture2D(uNight, vUv).rgb - 0.07, 0.0) * uHasNight;
    lights = pow(lights, vec3(1.35)) * vec3(1.0, 0.74, 0.42) * 2.6;
    col += lights * (1.0 - day) * (1.0 - cloud * 0.75);

    // Gentle limb darkening and the inner limb of the air. (No added terminator tint: small linear
    // additions turn into a visible brown band after the sRGB conversion on the dark side.)
    float facing = max(dot(n, v), 0.0);
    col *= mix(0.78, 1.0, pow(facing, 0.45));
    float fres = pow(1.0 - facing, 4.0);
    col += uAtmo * fres * (0.12 + 0.88 * smoothstep(-0.25, 0.55, ndl)) * 0.75;

    gl_FragColor = vec4(col, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
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

/**
 * Outer halo, drawn on the back faces of a larger shell. On that shell dot(n, view) runs from 0 at
 * its silhouette to -uLimb where it meets the planet's limb, so the glow is brightest against the
 * Earth and fades smoothly into space — no gap, no hard ring.
 */
const atmosphereFragment = /* glsl */ `
  uniform vec3 uInner;
  uniform vec3 uOuter;
  uniform vec3 uSunDir;
  uniform float uIntensity;
  uniform float uLimb;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    vec3 n = normalize(vNormalW);
    float d = dot(n, normalize(vViewDirW));
    float k = clamp(-d / uLimb, 0.0, 1.0);
    float glow = pow(k, 2.6);
    float lit = 0.2 + 0.8 * smoothstep(-0.35, 0.65, dot(n, uSunDir));
    vec3 col = mix(uOuter, uInner, pow(k, 4.0));
    gl_FragColor = vec4(col, glow * lit * uIntensity);
    #include <colorspace_fragment>
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
  varying float vFacing;
  void main() {
    vWeight = aWeight;
    vFlicker = 0.75 + 0.25 * sin(uTime * (1.6 + aPhase) + aPhase * 6.2831);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Fade points near the limb so the planet's edge stays clean.
    vec3 nView = normalize(mat3(modelViewMatrix) * normalize(position));
    vFacing = smoothstep(0.05, 0.35, dot(nView, normalize(-mv.xyz)));
    gl_PointSize = (6.0 + aWeight * 9.0) * uScale * uFade / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * Each fire is a crisp pointy-top hexagon (the product's one shape), coloured along the heat ramp by
 * its weight: embers → orange → amber. The edge is antialiased in the sprite's own pixel space.
 */
const fireFragment = /* glsl */ `
  uniform vec3 uHot;
  uniform vec3 uMid;
  uniform vec3 uCore;
  varying float vWeight;
  varying float vFlicker;
  varying float vFacing;
  void main() {
    vec2 p = abs(gl_PointCoord - 0.5) * 2.0;
    float d = max(p.x, p.x * 0.5 + p.y * 0.8660254);
    float edge = fwidth(d) * 1.2 + 0.02;
    float a = 1.0 - smoothstep(0.84 - edge, 0.84, d);
    vec3 col = vWeight < 0.5 ? mix(uHot, uMid, vWeight * 2.0) : mix(uMid, uCore, vWeight * 2.0 - 1.0);
    gl_FragColor = vec4(col * (0.9 + 0.1 * vFlicker), a * (0.6 + 0.4 * vWeight) * vFacing);
    #include <colorspace_fragment>
  }
`;

/** Three satellites on their real orbits and their links (from /v1/helios/constellation). */
export interface ConstellationInput {
  /** ISO time of step 0. */
  start: string;
  step_s: number;
  satellites: { name: string; track: readonly (readonly [number, number, number])[] }[];
  stations: { lat: number; lon: number; kind: string }[];
  states: readonly (readonly (readonly [number, number, number, number, number, number, string])[])[];
}

const SAT_MODEL: Record<string, NasaModel> = { TERRA: 'terra', AQUA: 'aqua', 'SUOMI NPP': 'snpp' };
/** Fleet entry and procedural look of each model, for satellites created when the constellation plays. */
const SAT_SPEC: Record<NasaModel, { id: string; kind: SatelliteKind }> = {
  terra: { id: 'terra', kind: 'eos' },
  aqua: { id: 'aqua', kind: 'eos' },
  snpp: { id: 'snpp', kind: 'jpss' },
};
/** Two hours of real orbits play in about three minutes… */
export const CONSTELLATION_SPEED = 40;
/** …and slow down while AI #2 switches a link (laser handoff, backup radio), so it can be seen. */
export const CONSTELLATION_SLOW = 10;
const MAX_LINKS = 8;
const LINK_COLOR = { down: new Color('#5ee6c6'), laser: new Color('#ffb24a'), radio: new Color('#7cb7ff') };
const STATION_COLOR = { radio: new Color('#8be9d9'), optical: new Color('#c4a8ff') };

interface SatVisual {
  sat: Satellite;
  kind: SatelliteKind;
  modelName: NasaModel;
  /** Positioned and oriented every frame; holds whichever model is loaded. */
  model: Group;
  trail: Line<BufferGeometry, LineBasicMaterial>;
  trailPositions: Float32Array;
  trailColors: Float32Array;
  /** NASA model requested (high quality only). */
  nasa?: boolean;
}

/**
 * The landing planet. Imperative three.js, mounted once by GlobeCanvas and disposed on unmount.
 * Draw calls: Earth (one shader: day, night, clouds, glint), atmosphere, fire points, three
 * satellite models (NASA glTF, or ~15 procedural meshes each on the light profile) and three trails.
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
  private con: {
    data: ConstellationInput;
    /** Playback position in (fractional) steps. */
    f: number;
    visuals: (SatVisual | null)[];
    stationPos: Vector3[];
    stations: Points<BufferGeometry, PointsMaterial>;
    links: LineSegments<BufferGeometry, LineBasicMaterial>;
    lastTick: number;
    lastSlow: boolean;
  } | null = null;
  /** Turns the planet toward a point for a while (the storm demo); a drag cancels it. */
  private focus: { lat: number; lng: number; until: number } | null = null;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly textures: Texture[] = [];
  private hasPhoto = false;
  private raf = 0;
  private running = false;
  private visible = true;
  private last = 0;
  private simTime = 0;
  private spinAngle = 0;
  private spinVelocity = 0;
  private tiltAngle = 0.36;
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
  /** Current render resolution; lowered step by step if the machine cannot keep up. */
  private pixelRatio = 1;
  private perf = { sum: 0, n: 0 };
  private frameCount = 0;
  /** Where the planet sits: centre offset as a share of the viewport, radius as a share of the short side. */
  private frameSpec = { x: 0, y: 0, size: 0.8 };
  private baseDistance = 4.4;
  private offsetBlend = 1;

  constructor(host: HTMLElement, opts: EarthSceneOptions) {
    this.host = host;
    this.opts = opts;
    const low = opts.quality === 'low';
    this.renderer = new WebGLRenderer({ antialias: !low, alpha: true, powerPreference: low ? 'low-power' : 'high-performance' });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, low ? 1.5 : 1.75);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    // Vertical swipes scroll the page; horizontal drags spin the planet.
    this.renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:pan-y;display:block';
    host.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(30, 1, 0.01, 100);
    this.camera.position.set(0, 0, this.cameraDistance);

    this.scene.add(this.tilt);
    this.tilt.add(this.spin);
    this.tilt.rotation.x = this.tiltAngle;

    // Light for the satellite models (the Earth shader lights itself with the same sun direction).
    const sun = new DirectionalLight('#fff6e8', 2.6);
    sun.position.copy(SUN_DIR).multiplyScalar(10);
    this.scene.add(sun, new AmbientLight('#c8d4ff', 0.35));
    if (!low) {
      const pmrem = new PMREMGenerator(this.renderer);
      const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = env;
      this.scene.environmentIntensity = 0.55;
      this.textures.push(env);
      pmrem.dispose();
    }

    const t = LOOK;
    const segments = low ? [64, 48] : [128, 96];
    const empty = new Texture();
    this.earth = new Mesh(
      new SphereGeometry(1, segments[0], segments[1]),
      new ShaderMaterial({
        vertexShader: earthVertex,
        fragmentShader: earthFragment,
        uniforms: {
          uDay: { value: empty },
          uNight: { value: empty },
          uSpec: { value: empty },
          uClouds: { value: empty },
          uHasNight: { value: 0 },
          uHasSpec: { value: 0 },
          uHasClouds: { value: 0 },
          uCloudShift: { value: 0 },
          uSunDir: { value: SUN_DIR.clone() },
          uAtmo: { value: t.atmoInner.clone() },
          uAmbient: { value: t.ambient },
          uOpacity: { value: 1 },
        },
      }),
    );
    this.earth.visible = false;
    this.spin.add(this.earth);

    this.atmosphere = new Mesh(
      new SphereGeometry(ATMO_RADIUS, segments[0], segments[1]),
      new ShaderMaterial({
        vertexShader: atmosphereVertex,
        fragmentShader: atmosphereFragment,
        uniforms: {
          uInner: { value: t.atmoInner.clone() },
          uOuter: { value: t.atmoOuter.clone() },
          uSunDir: { value: SUN_DIR.clone() },
          uIntensity: { value: t.atmoIntensity },
          uLimb: { value: Math.sqrt(1 - 1 / (ATMO_RADIUS * ATMO_RADIUS)) },
        },
        side: BackSide,
        transparent: true,
        depthWrite: false,
        blending: t.atmoBlending,
      }),
    );
    this.atmosphere.visible = false;
    this.tilt.add(this.atmosphere);

    this.buildSatellites();
    this.bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
    void this.loadTextures();
  }

  /* ------------------------------------------------------------------ content */

  private loader = new ImageBitmapLoader().setOptions({ imageOrientation: 'flipY' });

  /** Downscales a bitmap for the light profile (phones keep GPU memory in check). */
  private toTexture(bitmap: ImageBitmap, maxWidth: number): Texture {
    let tex: Texture;
    if (bitmap.width > maxWidth) {
      const c = document.createElement('canvas');
      c.width = maxWidth;
      c.height = Math.round((bitmap.height * maxWidth) / bitmap.width);
      const ctx = c.getContext('2d')!;
      // The bitmap is already flipped for WebGL; flip back for the canvas (CanvasTexture flips again).
      ctx.translate(0, c.height);
      ctx.scale(1, -1);
      ctx.drawImage(bitmap, 0, 0, c.width, c.height);
      bitmap.close();
      tex = new CanvasTexture(c);
    } else {
      tex = new Texture(bitmap);
      tex.flipY = false;
    }
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;
    this.textures.push(tex);
    return tex;
  }

  private load(url: string): Promise<ImageBitmap> {
    return new Promise((resolve, reject) => this.loader.load(url, resolve, undefined, reject));
  }

  private async loadTextures() {
    const low = this.opts.quality === 'low';
    const u = this.earth.material.uniforms;
    try {
      const day = await this.load(TEXTURES.day);
      if (this.disposed) return day.close();
      u.uDay!.value = this.toTexture(day, low ? 2048 : 4096);
      this.hasPhoto = true;
      this.showPlanet();
    } catch (err) {
      console.warn('[kyzyl-aspan] earth texture failed, using the drawn planet', err);
      return; // setCountries() paints a fallback planet.
    }
    // The rest is decoration: load after the first frame, one at a time.
    const extras: [keyof typeof TEXTURES, 'uNight' | 'uSpec' | 'uClouds', 'uHasNight' | 'uHasSpec' | 'uHasClouds', number][] = [
      // 2048 px is plenty for lights seen only on the night crescent, and halves the GPU upload hitch.
      ['night', 'uNight', 'uHasNight', 2048],
      ['clouds', 'uClouds', 'uHasClouds', 1024],
      ['specular', 'uSpec', 'uHasSpec', 2048],
    ];
    for (const [key, uniform, flag, width] of extras) {
      if (low && key === 'specular') continue;
      try {
        const bmp = await this.load(TEXTURES[key]);
        if (this.disposed) return bmp.close();
        const tex = this.toTexture(bmp, width);
        // Clouds are a single channel; keep them linear so the alpha reads as authored.
        if (key !== 'night') tex.colorSpace = NoColorSpace;
        // The cloud layer drifts in longitude: it must repeat across the date line. With the default
        // clamp, u > 1 smeared the edge column into a striped band over the Pacific.
        if (key === 'clouds') tex.wrapS = RepeatWrapping;
        u[uniform]!.value = tex;
        u[flag]!.value = 1;
      } catch {
        /* optional layer */
      }
    }
  }

  private showPlanet() {
    if (this.earth.visible) return;
    this.earth.visible = true;
    this.atmosphere.visible = true;
    for (const s of this.sats) {
      s.model.visible = true;
      s.trail.visible = true;
    }
    this.opts.onReady?.();
    if (this.opts.quality === 'high') void this.loadSatelliteModels();
  }

  private nasaLoader: Promise<typeof LoadNasaSatellite | null> | null = null;

  /** Swaps in NASA's models one by one once the planet is on screen; keeps the procedural ones on failure. */
  private async loadSatelliteModels() {
    for (const s of [...this.sats]) {
      await this.loadSatelliteModel(s);
      if (this.disposed) return;
    }
  }

  private async loadSatelliteModel(s: SatVisual) {
    if (s.nasa) return;
    s.nasa = true;
    // The glTF loader is its own chunk: the planet never waits for it.
    this.nasaLoader ??= import('./nasaSatellites').then((m) => m.loadNasaSatellite).catch(() => null);
    const loadNasaSatellite = await this.nasaLoader;
    if (!loadNasaSatellite || this.disposed) return;
    const anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    try {
      const pivot = await loadNasaSatellite(s.modelName, SAT_SIZE, anisotropy);
      if (this.disposed) return;
      const old = s.model.children[0];
      if (old) s.model.remove(old);
      s.model.add(pivot);
    } catch (err) {
      console.warn(`[kyzyl-aspan] satellite model ${s.modelName} unavailable, keeping the drawn one`, err);
    }
  }

  /** Fallback planet drawn from country outlines, used only when the photo texture cannot load. */
  setCountries(countries: readonly CountryShape[]) {
    if (this.disposed || this.hasPhoto) return;
    window.setTimeout(() => {
      if (this.disposed || this.hasPhoto) return;
      const tex = new CanvasTexture(paintEarth(countries, this.opts.quality === 'low' ? 1024 : 2048));
      tex.colorSpace = SRGBColorSpace;
      this.textures.push(tex);
      this.earth.material.uniforms.uDay!.value = tex;
      this.showPlanet();
    }, 2500);
  }

  setFires(points: readonly [number, number, number][]) {
    if (this.disposed) return;
    const n = points.length;
    const pos = new Float32Array(n * 3);
    const weight = new Float32Array(n);
    const phase = new Float32Array(n);
    points.forEach(([lng, lat, w], i) => {
      const [x, y, z] = latLngToXYZ(lat, lng, 1.003);
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
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 300 },
        uFade: { value: 1 },
        uHot: { value: new Color('#c23a14') },
        uMid: { value: new Color('#ec6420') },
        uCore: { value: new Color('#ffbf5a') },
      },
      transparent: true,
      depthWrite: false,
      blending: LOOK.fireBlending,
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

  /**
   * Switches the three satellites to their real orbits (SGP4 tracks from the API) and draws the ground
   * stations and the links: satellite → station, satellite → satellite (laser) and the backup radio.
   */
  setConstellation(data: ConstellationInput) {
    if (this.disposed || !data.satellites.length) return;
    const prev = this.con;
    if (this.con) {
      this.spin.remove(this.con.stations, this.con.links);
      this.con.stations.geometry.dispose();
      this.con.links.geometry.dispose();
    }
    const visuals = data.satellites.map((s) => this.visualFor(s.name));
    for (const v of visuals) {
      if (!v || v.model.parent === this.spin) continue;
      this.tilt.remove(v.model, v.trail);
      this.spin.add(v.model, v.trail);
    }
    const stationPos = data.stations.map((s) => new Vector3(...latLngToXYZ(s.lat, s.lon, 1.006)));
    const sGeo = new BufferGeometry();
    sGeo.setAttribute('position', new BufferAttribute(new Float32Array(stationPos.flatMap((v) => [v.x, v.y, v.z])), 3));
    sGeo.setAttribute(
      'color',
      new BufferAttribute(
        new Float32Array(data.stations.flatMap((s) => {
          const c = s.kind === 'optical' ? STATION_COLOR.optical : STATION_COLOR.radio;
          return [c.r, c.g, c.b];
        })),
        3,
      ),
    );
    const stations = new Points(sGeo, new PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
    stations.renderOrder = 3;
    const lGeo = new BufferGeometry();
    lGeo.setAttribute('position', new BufferAttribute(new Float32Array(MAX_LINKS * 6), 3));
    lGeo.setAttribute('color', new BufferAttribute(new Float32Array(MAX_LINKS * 6), 3));
    const links = new LineSegments(lGeo, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
    links.renderOrder = 4;
    links.frustumCulled = false;
    this.spin.add(stations, links);
    const steps = data.satellites[0]?.track.length ?? 0;
    // Keep the same moment across refetches (the window start moves by 10 minutes); start at "now".
    const ref = prev ? Date.parse(prev.data.start) + prev.f * prev.data.step_s * 1000 : Date.now();
    const f0 = (ref - Date.parse(data.start)) / 1000 / data.step_s;
    const f = Number.isFinite(f0) ? Math.max(0, Math.min(Math.max(0, steps - 1.001), f0)) : 0;
    this.con = { data, f, visuals, stationPos, stations, links, lastTick: -1, lastSlow: false };
  }

  /** Jumps the real-orbit playback to a step (e.g. the first moment the storm matters). */
  seekConstellation(index: number) {
    const c = this.con;
    if (!c) return;
    const steps = c.data.satellites[0]?.track.length ?? 0;
    c.f = Math.max(0, Math.min(Math.max(0, steps - 1.001), index));
  }

  /** Smoothly turns the planet so that a point faces the viewer, then goes back to the idle spin. */
  focusOn(lat: number, lng: number, ms = 9000) {
    if (this.dive) return;
    this.focus = { lat, lng, until: performance.now() + ms };
    this.spinVelocity = 0;
    this.resume();
  }

  /** Point of a real track at fractional step f, in the Earth-fixed (spinning) frame. */
  private trackPoint(track: readonly (readonly [number, number, number])[], f: number, out: Vector3): Vector3 {
    const i = Math.max(0, Math.min(track.length - 1, Math.floor(f)));
    const w = Math.max(0, Math.min(1, f - i));
    const a = track[i]!;
    const b = track[Math.min(i + 1, track.length - 1)]!;
    let dl = b[0] - a[0];
    if (dl > 180) dl -= 360;
    if (dl < -180) dl += 360;
    const alt = a[2] + (b[2] - a[2]) * w;
    const [x, y, z] = latLngToXYZ(a[1] + (b[1] - a[1]) * w, a[0] + dl * w, 1 + (alt / EARTH_RADIUS_KM) * ALTITUDE_EXAGGERATION);
    return out.set(x, y, z);
  }

  private updateConstellation(dt: number) {
    const c = this.con!;
    const steps = c.data.satellites[0]?.track.length ?? 0;
    if (steps < 2) return;
    const at = Math.floor(c.f);
    // Laser handoff (2) or backup-radio alerts (4): the moments AI #2 changes the link.
    const slow = c.data.states.some((st) => {
      const a = st[Math.min(at, st.length - 1)]?.[0];
      return a === 2 || a === 4;
    });
    const speed = this.opts.reducedMotion ? 0 : slow ? CONSTELLATION_SLOW : CONSTELLATION_SPEED;
    c.f = (c.f + (dt * speed) / c.data.step_s) % (steps - 1);
    const f = c.f;
    const i0 = Math.floor(f);
    this.spin.updateMatrixWorld();
    const pos = c.data.satellites.map((s) => this.trackPoint(s.track, f, new Vector3()));
    c.visuals.forEach((v, i) => {
      if (!v) return;
      const track = c.data.satellites[i]!.track;
      const p = pos[i]!;
      v.model.position.copy(p);
      const ahead = this.trackPoint(track, Math.min(steps - 1.001, f + 0.4), this.tmp3).sub(p);
      v.model.up.copy(ahead.transformDirection(this.spin.matrixWorld));
      v.model.lookAt(this.tmp2.copy(p).multiplyScalar(2).applyMatrix4(this.spin.matrixWorld));
      const n = v.trailPositions.length / 3;
      for (let k = 0; k < n; k++) {
        const q = this.trackPoint(track, Math.max(0, f - k * 0.45), this.tmp);
        v.trailPositions.set([q.x, q.y, q.z], k * 3);
      }
      (v.trail.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    });
    const lp = c.links.geometry.getAttribute('position') as BufferAttribute;
    const lc = c.links.geometry.getAttribute('color') as BufferAttribute;
    const P = lp.array as Float32Array;
    const C = lc.array as Float32Array;
    let seg = 0;
    const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 160);
    const put = (a: Vector3, b: Vector3, col: Color, k = 1) => {
      if (seg >= MAX_LINKS) return;
      P.set([a.x, a.y, a.z, b.x, b.y, b.z], seg * 6);
      C.set([col.r * k, col.g * k, col.b * k, col.r * k, col.g * k, col.b * k], seg * 6);
      seg++;
    };
    c.data.states.forEach((states, i) => {
      const s = states[Math.min(i0, states.length - 1)];
      if (!s) return;
      const [action, partner, station] = s;
      const st = station >= 0 ? c.stationPos[station] : undefined;
      if (st && (action === 1 || action === 3)) put(pos[i]!, st, LINK_COLOR.down);
      if (st && action === 4) put(pos[i]!, st, LINK_COLOR.radio, pulse);
      if (action === 2 && partner >= 0 && pos[partner]) put(pos[i]!, pos[partner]!, LINK_COLOR.laser, pulse);
    });
    for (; seg < MAX_LINKS; seg++) {
      P.fill(0, seg * 6, seg * 6 + 6);
      C.fill(0, seg * 6, seg * 6 + 6);
    }
    lp.needsUpdate = true;
    lc.needsUpdate = true;
    if (i0 !== c.lastTick || slow !== c.lastSlow) {
      c.lastTick = i0;
      c.lastSlow = slow;
      this.opts.onConstellationTick?.(i0, slow);
    }
  }


  private paintTrail(s: SatVisual) {
    const t = LOOK.trail;
    const n = s.trailColors.length / 3;
    for (let i = 0; i < n; i++) {
      // Additive blending fades the trail to black towards its tail.
      const f = (1 - i / (n - 1)) ** 1.8;
      s.trailColors.set([t.r * f, t.g * f, t.b * f], i * 3);
    }
    s.trail.material.blending = AdditiveBlending;
    s.trail.material.opacity = 0.55;
    s.trail.material.needsUpdate = true;
    (s.trail.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }


  private buildSatellites() {
    for (const { id, kind, model: modelName } of SHOWN) {
      const sat = FLEET.find((s) => s.id === id);
      if (sat) this.makeSatVisual(sat, kind, modelName);
    }
  }

  private makeSatVisual(sat: Satellite, kind: SatelliteKind, modelName: NasaModel): SatVisual {
    // A holder that rides the orbit; the procedural model is its first child until NASA's arrives.
    const model = new Group();
    const drawn = buildSatellite(kind);
    drawn.scale.setScalar(SAT_SCALE);
    model.add(drawn);
    model.visible = false;
    this.tilt.add(model);

    const TRAIL = 36;
    const trailPositions = new Float32Array(TRAIL * 3);
    const trailColors = new Float32Array(TRAIL * 3);
    const trailGeo = new BufferGeometry();
    trailGeo.setAttribute('position', new BufferAttribute(trailPositions, 3));
    trailGeo.setAttribute('color', new BufferAttribute(trailColors, 3));
    const trail = new Line(trailGeo, new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    trail.visible = false;
    this.tilt.add(trail);

    const visual: SatVisual = { sat, kind, modelName, model, trail, trailPositions, trailColors };
    this.paintTrail(visual);
    this.sats.push(visual);
    return visual;
  }

  /**
   * The visual for a satellite of the real constellation. The idle globe shows Terra only; Aqua and
   * Suomi NPP are created here the first time the constellation plays, so laser links never end in empty space.
   */
  private visualFor(name: string): SatVisual | null {
    const modelName = SAT_MODEL[name.toUpperCase()];
    if (!modelName) return null;
    const found = this.sats.find((v) => v.modelName === modelName);
    if (found) return found;
    const spec = SAT_SPEC[modelName];
    const sat = FLEET.find((f) => f.id === spec.id);
    if (!sat) return null;
    const v = this.makeSatVisual(sat, spec.kind, modelName);
    const shown = this.earth.visible && !this.dive;
    v.model.visible = shown;
    v.trail.visible = shown;
    if (this.opts.quality === 'high' && this.earth.visible) void this.loadSatelliteModel(v);
    return v;
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
    if (!this.earth.visible) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.earth, false)[0];
    return hit ? hit.point : null;
  }

  private onDown = (e: PointerEvent) => {
    if (this.dive) return;
    this.setPointer(e);
    if (!this.hitEarth()) return;
    // Touch: let the browser decide between page scroll (vertical) and a spin (horizontal).
    if (e.pointerType !== 'touch') this.renderer.domElement.setPointerCapture(e.pointerId);
    const now = performance.now();
    this.drag = { x: e.clientX, y: e.clientY, t: now, moved: 0, lastX: e.clientX, lastY: e.clientY, lastT: now };
    this.spinVelocity = 0;
    this.focus = null;
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
    if (e.pointerType !== 'touch') this.tiltAngle = Math.max(-0.9, Math.min(0.9, this.tiltAngle + dy * k));
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
   * distance eases in (cubic), so the plunge accelerates while the page-coloured veil rises over it.
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
      this.visible = true;
      this.resume();
    });
  }

  private earthSpin(): number {
    return EARTH_ROTATION * this.simTime;
  }

  /* ------------------------------------------------------------------ loop */

  start() {
    if (this.running || this.disposed || !this.visible) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Stops rendering (off-screen or hidden tab). */
  pause() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  resume() {
    if (document.hidden || this.disposed) return;
    this.start();
  }

  /** The page scrolled the planet out of view: stop spending frames on it. */
  setVisible(visible: boolean) {
    this.visible = visible || this.dive !== null;
    if (this.visible) this.resume();
    else this.pause();
  }

  /**
   * Draws one frame outside the rAF loop. Background tabs never tick rAF, so tests and dev tools use
   * this to see the planet; it never leaves a second loop running.
   */
  debugStep(ms = 16) {
    if (this.disposed) return;
    cancelAnimationFrame(this.raf);
    const wasRunning = this.running;
    this.running = true;
    // At least one frame-cap interval, so the frame is never skipped by MIN_FRAME_MS.
    this.last = performance.now() - Math.max(ms, MIN_FRAME_MS);
    this.frame(performance.now());
    if (!wasRunning) {
      this.running = false;
      cancelAnimationFrame(this.raf);
    }
  }

  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly tmp3 = new Vector3();

  /**
   * Watches the real frame interval and lowers the render resolution (1.75 → 1.4 → 1.05 → 1) when the
   * machine cannot hold ~40 fps for ~1.5 s. It never goes back up, so it cannot oscillate.
   */
  private watchFrameRate(interval: number) {
    if (this.dive || interval > 250) return; // pauses, tab switches and the dive are not a verdict
    this.perf.sum += interval;
    this.perf.n += 1;
    if (this.perf.n < 90) return;
    const avg = this.perf.sum / this.perf.n;
    this.perf = { sum: 0, n: 0 };
    if (avg <= 25 || this.pixelRatio <= 1) return;
    this.pixelRatio = Math.max(1, Math.round((this.pixelRatio - 0.35) * 100) / 100);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.resize();
  }

  private frame = (now: number) => {
    if (!this.running) return;
    if (now - this.last < MIN_FRAME_MS) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    const interval = now - this.last;
    const dt = Math.min(0.05, interval / 1000);
    this.last = now;
    this.frameCount += 1;
    this.watchFrameRate(interval);
    const reduced = this.opts.reducedMotion;

    if (!reduced && !this.dive) this.simTime += dt * TIME_WARP;

    if (this.dive) {
      const d = this.dive;
      const t = Math.min(1, (now - d.start) / d.duration);
      const r = easeInOutCubic(Math.min(1, t * 1.25));
      this.spinAngle = d.from.spin + (d.to.spin - d.from.spin) * r;
      this.tiltAngle = d.from.tilt + (d.to.tilt - d.from.tilt) * r;
      this.cameraDistance = d.from.dist + (d.to.dist - d.from.dist) * easeInCubic(t);
      this.offsetBlend = 1 - easeInOutCubic(Math.min(1, t * 1.6));
      this.applyViewOffset();
      const fade = 1 - Math.min(1, t * 1.8);
      for (const s of this.sats) {
        s.model.visible = fade > 0.02;
        s.trail.visible = fade > 0.02;
      }
      if (this.con) {
        this.con.links.visible = fade > 0.02;
        this.con.stations.visible = fade > 0.02;
      }
      this.atmosphere.material.uniforms.uIntensity!.value = LOOK.atmoIntensity * (1 - t * 0.6);
      if (this.fires) this.fires.material.uniforms.uFade!.value = Math.max(0.15, 1 - easeInCubic(t) * 0.9) * (this.cameraDistance / 3.4);
      if (t >= 1) {
        this.dive = null;
        d.resolve();
      }
    } else if (!this.drag) {
      const focus = this.focus && now < this.focus.until ? this.focus : null;
      if (focus) {
        const target = nearestAngle(this.spinAngle, spinToFace(focus.lng) - this.earthSpin());
        const k = reduced ? 1 : Math.min(1, dt * 2.4);
        this.spinAngle += (target - this.spinAngle) * k;
        const tilt = Math.max(-0.9, Math.min(0.9, ((focus.lat * Math.PI) / 180) * 0.8));
        this.tiltAngle += (tilt - this.tiltAngle) * (reduced ? 1 : Math.min(1, dt * 1.8));
      } else {
        this.focus = null;
        if (!reduced) this.spinAngle += (IDLE_SPIN + this.spinVelocity) * dt;
        this.spinVelocity *= Math.pow(0.04, dt);
        this.tiltAngle += (0.36 - this.tiltAngle) * Math.min(1, dt * 0.6);
      }
    }

    this.spin.rotation.y = this.spinAngle + this.earthSpin();
    this.tilt.rotation.x = this.tiltAngle;
    this.camera.position.set(0, 0, this.cameraDistance);
    this.camera.lookAt(0, 0, 0);

    const u = this.earth.material.uniforms;
    if (!reduced) u.uCloudShift!.value = (u.uCloudShift!.value + dt * 0.0016) % 1;
    if (this.fires) this.fires.material.uniforms.uTime!.value = now / 1000;

    this.updateSatellites(dt);

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

  private updateSatellites(dt = 0) {
    if (this.con) {
      this.updateConstellation(dt);
      return;
    }
    this.tilt.updateMatrixWorld();
    for (const s of this.sats) {
      const pos = this.satPosition(s.sat, this.simTime, this.tmp);
      s.model.position.copy(pos);
      // Nadir (−Z) at the Earth's centre, +Y along the track.
      const ahead = this.satPosition(s.sat, this.simTime + 30, this.tmp3).sub(pos);
      s.model.up.copy(ahead.transformDirection(this.tilt.matrixWorld));
      s.model.lookAt(this.tmp2.copy(pos).multiplyScalar(2).applyMatrix4(this.tilt.matrixWorld));

      if (this.frameCount % TRAIL_EVERY !== 0 && !this.dive) continue;
      const n = s.trailPositions.length / 3;
      const out = s.trailPositions;
      for (let i = 0; i < n; i++) {
        const p = this.satPosition(s.sat, this.simTime - i * 18, this.tmp2);
        out[i * 3] = p.x;
        out[i * 3 + 1] = p.y;
        out[i * 3 + 2] = p.z;
      }
      (s.trail.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    }
  }

  private applyViewOffset() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    const k = this.offsetBlend;
    if (k <= 0.001 || (this.frameSpec.x === 0 && this.frameSpec.y === 0)) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, -this.frameSpec.x * w * k, -this.frameSpec.y * h * k, w, h);
  }

  private resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Distance at which the unit planet's radius spans frameSpec.size × half the short side.
    const tanHalf = Math.tan((this.camera.fov / 2) * (Math.PI / 180));
    this.baseDistance = h / (2 * tanHalf * this.frameSpec.size * 0.5 * Math.min(w, h));
    if (!this.dive) this.cameraDistance = this.baseDistance;
    this.applyViewOffset();
    this.camera.updateProjectionMatrix();
    if (this.fires) this.fires.material.uniforms.uScale!.value = h * this.renderer.getPixelRatio() * 0.005;
    // Render one frame right away so a paused scene is never stretched after a resize.
    if (!this.running && this.earth.visible) this.renderer.render(this.scene, this.camera);
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
      const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
      for (const m of mats) {
        (m as { map?: Texture | null }).map?.dispose();
        m.dispose?.();
      }
    });
    disposeSatelliteKit();
    for (const t of this.textures) {
      const img = t.image as ImageBitmap | undefined;
      if (img && 'close' in img) img.close();
      t.dispose();
    }
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    el.remove();
  }
}
