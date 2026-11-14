import { Box3, Group, Vector3, type Mesh, type MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Real spacecraft from NASA 3D Resources (public domain), simplified for the web by
 * scripts/build-satellite-models.mjs: ~9k triangles and 130 kB, no decoder needed.
 */
export type NasaModel = 'terra';

const URLS: Record<NasaModel, string> = {
  terra: '/models/terra.glb',
};

/** Hard edges stay hard (panels, boxes), curved parts (dishes, booms) stay smooth. */
const CREASE = (35 * Math.PI) / 180;

let loader: GLTFLoader | null = null;

/**
 * Loads one model, rebuilds its normals (the files ship without them to stay small), centres it
 * and scales it so its longest side is `size` scene units. Resolves to a pivot group.
 */
export async function loadNasaSatellite(name: NasaModel, size: number, anisotropy: number): Promise<Group> {
  loader ??= new GLTFLoader();
  const gltf = await loader.loadAsync(URLS[name]);
  const root = gltf.scene;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const old = mesh.geometry;
    mesh.geometry = toCreasedNormals(old, CREASE);
    old.dispose();
    const mat = mesh.material as MeshStandardMaterial;
    mat.flatShading = false;
    if (mat.map) mat.map.anisotropy = anisotropy;
    mat.needsUpdate = true;
  });
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  const centre = box.getCenter(new Vector3());
  const dims = box.getSize(new Vector3());
  root.position.sub(centre);
  const pivot = new Group();
  pivot.add(root);
  pivot.scale.setScalar(size / Math.max(dims.x, dims.y, dims.z, 1e-6));
  pivot.name = `nasa-${name}`;
  return pivot;
}
