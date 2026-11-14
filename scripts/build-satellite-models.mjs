/**
 * Builds the landing-page satellite models from NASA's public 3D resources.
 *
 * Source (public domain, NASA media usage guidelines): https://github.com/nasa/NASA-3D-Resources
 *   3D Models/Terra/Terra.glb                                       → public/models/terra.glb   (MODIS)
 *
 * The originals are 2–2.3 MB each (117k-triangle CAD meshes, Draco, PNG duplicates of WebP textures,
 * broken links to .tga files). On screen a satellite is 40–80 px wide, so this script:
 *   1. decodes Draco (three's bundled decoder — no extra dependency),
 *   2. welds vertices (by position, plus UV where a texture needs it),
 *   3. simplifies with meshoptimizer (bundled with three) to a triangle budget,
 *   4. drops normals — the browser rebuilds creased normals on load (BufferGeometryUtils.toCreasedNormals),
 *   5. keeps only the WebP textures, fixes impossible material values (negative roughness),
 *   6. writes a plain, uncompressed GLB that needs no decoder at runtime.
 *
 * Usage: node scripts/build-satellite-models.mjs <dir with terra.glb> [outDir]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { runInThisContext } from 'node:vm';
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';

// three ships the Draco decoder as a classic (CommonJS-style) script inside an ESM package, so
// require() would treat it as ESM. Evaluate it with a CommonJS wrapper instead.
const dracoPath = createRequire(import.meta.url).resolve(
  'three/examples/jsm/libs/draco/gltf/draco_decoder.js',
);
const dracoModule = { exports: {} };
runInThisContext(
  `(function (module, exports, require, __filename, __dirname) {${readFileSync(dracoPath, 'utf8')}
})`,
  { filename: dracoPath },
)(dracoModule, dracoModule.exports, createRequire(dracoPath), dracoPath, dirname(dracoPath));
const DracoDecoderModule = dracoModule.exports;

const MODELS = [
  { file: 'terra.glb', budget: 9000 },
];

/* ------------------------------------------------------------------ GLB io */

function readGlb(path) {
  const src = readFileSync(path);
  if (src.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${path}: not a GLB`);
  const jsonLen = src.readUInt32LE(12);
  const json = JSON.parse(src.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const bin = src.subarray(binStart, binStart + src.readUInt32LE(20 + jsonLen));
  return { json, bin, size: src.length };
}

class BinWriter {
  chunks = [];
  length = 0;
  views = [];
  add(bytes, target) {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(Buffer.alloc(pad));
      this.length += pad;
    }
    const view = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength };
    if (target) view.target = target;
    this.views.push(view);
    this.chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.length += bytes.byteLength;
    return this.views.length - 1;
  }
}

function writeGlb(path, json, bin) {
  const data = Buffer.concat(bin.chunks);
  const binPad = Buffer.alloc((4 - (data.length % 4)) % 4);
  json.buffers = [{ byteLength: data.length + binPad.length }];
  json.bufferViews = bin.views;
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
  const total = 12 + 8 + jsonBuf.length + jsonPad.length + 8 + data.length + binPad.length;
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length + jsonPad.length, 0);
  jh.write('JSON', 4, 'ascii');
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(data.length + binPad.length, 0);
  bh.write('BIN\0', 4, 'binary');
  writeFileSync(path, Buffer.concat([header, jh, jsonBuf, jsonPad, bh, data, binPad]));
  return total;
}

/* ------------------------------------------------------------------ accessors */

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const ARRAYS = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};

/** Reads a plain (non-Draco) accessor as a tightly packed array. */
function readAccessor(json, bin, index) {
  const a = json.accessors[index];
  const n = COMPONENTS[a.type];
  const Arr = ARRAYS[a.componentType];
  const bv = json.bufferViews[a.bufferView];
  const stride = bv.byteStride ?? n * Arr.BYTES_PER_ELEMENT;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out = new Arr(a.count * n);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const get = {
    5120: (o) => view.getInt8(o),
    5121: (o) => view.getUint8(o),
    5122: (o) => view.getInt16(o, true),
    5123: (o) => view.getUint16(o, true),
    5125: (o) => view.getUint32(o, true),
    5126: (o) => view.getFloat32(o, true),
  }[a.componentType];
  for (let i = 0; i < a.count; i++)
    for (let c = 0; c < n; c++) out[i * n + c] = get(base + i * stride + c * Arr.BYTES_PER_ELEMENT);
  return out;
}

function decodeDraco(draco, json, bin, prim) {
  const ext = prim.extensions.KHR_draco_mesh_compression;
  const bv = json.bufferViews[ext.bufferView];
  const bytes = new Int8Array(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength);
  const decoder = new draco.Decoder();
  const buffer = new draco.DecoderBuffer();
  buffer.Init(bytes, bytes.byteLength);
  const mesh = new draco.Mesh();
  const status = decoder.DecodeBufferToMesh(buffer, mesh);
  if (!status.ok()) throw new Error(`Draco: ${status.error_msg()}`);
  const points = mesh.num_points();
  const faces = mesh.num_faces();
  const idxPtr = draco._malloc(faces * 3 * 4);
  decoder.GetTrianglesUInt32Array(mesh, faces * 3 * 4, idxPtr);
  const indices = new Uint32Array(draco.HEAPU32.buffer, idxPtr, faces * 3).slice();
  draco._free(idxPtr);
  const attr = (semantic) => {
    const id = ext.attributes[semantic];
    if (id === undefined) return null;
    const att = decoder.GetAttributeByUniqueId(mesh, id);
    const n = points * att.num_components();
    const ptr = draco._malloc(n * 4);
    decoder.GetAttributeDataArrayForAllPoints(mesh, att, draco.DT_FLOAT32, n * 4, ptr);
    const out = new Float32Array(draco.HEAPF32.buffer, ptr, n).slice();
    draco._free(ptr);
    return out;
  };
  const result = { position: attr('POSITION'), uv: attr('TEXCOORD_0'), indices };
  draco.destroy(mesh);
  draco.destroy(buffer);
  draco.destroy(decoder);
  return result;
}

/* ------------------------------------------------------------------ geometry */

/** Merges vertices that share a position (and a UV when `uv` is given). */
function weld(position, uv, indices) {
  const map = new Map();
  const remap = new Uint32Array(position.length / 3);
  const pos = [];
  const tex = [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of position) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const q = 1e5 / Math.max(1e-9, max - min);
  for (let i = 0; i < remap.length; i++) {
    let key = `${Math.round(position[i * 3] * q)},${Math.round(position[i * 3 + 1] * q)},${Math.round(position[i * 3 + 2] * q)}`;
    if (uv) key += `|${Math.round(uv[i * 2] * 4096)},${Math.round(uv[i * 2 + 1] * 4096)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      map.set(key, id);
      pos.push(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
      if (uv) tex.push(uv[i * 2], uv[i * 2 + 1]);
    }
    remap[i] = id;
  }
  const idx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) idx[i] = remap[indices[i]];
  return { position: new Float32Array(pos), uv: uv ? new Float32Array(tex) : null, indices: idx };
}

/** Drops degenerate triangles and vertices no triangle uses. */
function compact(position, uv, indices) {
  const keep = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    if (a !== b && b !== c && a !== c) keep.push(a, b, c);
  }
  const remap = new Map();
  const pos = [];
  const tex = [];
  const idx = new Uint32Array(keep.length);
  keep.forEach((v, i) => {
    let id = remap.get(v);
    if (id === undefined) {
      id = remap.size;
      remap.set(v, id);
      pos.push(position[v * 3], position[v * 3 + 1], position[v * 3 + 2]);
      if (uv) tex.push(uv[v * 2], uv[v * 2 + 1]);
    }
    idx[i] = id;
  });
  return { position: new Float32Array(pos), uv: uv ? new Float32Array(tex) : null, indices: idx };
}

function bounds(position) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], position[i + c]);
      max[c] = Math.max(max[c], position[i + c]);
    }
  }
  return { min, max };
}

/* ------------------------------------------------------------------ materials */

function fixMaterial(m) {
  const name = (m.name ?? '').toLowerCase();
  const pbr = (m.pbrMetallicRoughness ??= {});
  const set = (metal, rough) => {
    pbr.metallicFactor = metal;
    pbr.roughnessFactor = rough;
  };
  if (/foil|gold|leaf/.test(name)) set(0.85, 0.36);
  else if (/silver|chrome|crome|metal|plating|antenna|dish/.test(name)) set(0.7, 0.42);
  else if (/solar|panel|cell/.test(name)) set(0.35, 0.32);
  else set(0.1, 0.62);
  delete m.extensions;
  delete m.extras;
}

/* ------------------------------------------------------------------ main */

async function build(draco, inDir, outDir, { file, budget }) {
  const { json, bin, size } = readGlb(join(inDir, file));
  const textured = (matIndex) => {
    const m = json.materials?.[matIndex];
    const t = m?.pbrMetallicRoughness?.baseColorTexture?.index;
    if (t === undefined) return false;
    const tex = json.textures[t];
    const source = tex.extensions?.EXT_texture_webp?.source ?? tex.source;
    return json.images?.[source]?.bufferView !== undefined;
  };

  // 1. Decode every primitive.
  const prims = [];
  let totalTris = 0;
  for (const mesh of json.meshes) {
    for (const p of mesh.primitives) {
      if ((p.mode ?? 4) !== 4) continue;
      const data = p.extensions?.KHR_draco_mesh_compression
        ? decodeDraco(draco, json, bin, p)
        : {
            position: Float32Array.from(readAccessor(json, bin, p.attributes.POSITION)),
            uv:
              p.attributes.TEXCOORD_0 !== undefined
                ? Float32Array.from(readAccessor(json, bin, p.attributes.TEXCOORD_0))
                : null,
            indices:
              p.indices !== undefined
                ? Uint32Array.from(readAccessor(json, bin, p.indices))
                : Uint32Array.from({ length: json.accessors[p.attributes.POSITION].count }, (_, i) => i),
          };
      const keepUv = textured(p.material) && data.uv;
      const welded = weld(data.position, keepUv ? data.uv : null, data.indices);
      prims.push({ mesh, prim: p, ...welded });
      totalTris += welded.indices.length / 3;
    }
  }

  // 2. Simplify to the budget, small parts first keep a floor so nothing vanishes.
  const ratio = Math.min(1, budget / totalTris);
  let outTris = 0;
  for (const p of prims) {
    if (ratio < 1) {
      const target = Math.max(36, Math.floor((p.indices.length * ratio) / 3) * 3);
      let [idx] = MeshoptSimplifier.simplify(p.indices, p.position, 3, target, 0.04, []);
      if (idx.length > target * 1.6 && p.indices.length > 600) {
        [idx] = MeshoptSimplifier.simplifySloppy(p.indices, p.position, 3, null, target, 0.04);
      }
      p.indices = idx;
    }
    Object.assign(p, compact(p.position, p.uv, p.indices));
    outTris += p.indices.length / 3;
  }

  // 3. Rebuild the document: same nodes and meshes, plain accessors, WebP images only.
  const w = new BinWriter();
  const accessors = [];
  const images = [];
  const imageMap = new Map();
  for (const p of prims) {
    if (!p.indices.length) {
      p.prim.__drop = true;
      continue;
    }
    const b = bounds(p.position);
    const attributes = {};
    attributes.POSITION =
      accessors.push({
        bufferView: w.add(p.position, 34962),
        componentType: 5126,
        count: p.position.length / 3,
        type: 'VEC3',
        min: b.min,
        max: b.max,
      }) - 1;
    if (p.uv)
      attributes.TEXCOORD_0 =
        accessors.push({
          bufferView: w.add(p.uv, 34962),
          componentType: 5126,
          count: p.uv.length / 2,
          type: 'VEC2',
        }) - 1;
    const vcount = p.position.length / 3;
    const idx = vcount < 65536 ? Uint16Array.from(p.indices) : p.indices;
    const indices =
      accessors.push({
        bufferView: w.add(idx, 34963),
        componentType: idx instanceof Uint16Array ? 5123 : 5125,
        count: idx.length,
        type: 'SCALAR',
      }) - 1;
    const material = p.prim.material;
    for (const k of Object.keys(p.prim)) delete p.prim[k];
    Object.assign(p.prim, { attributes, indices, mode: 4 });
    if (material !== undefined) p.prim.material = material;
  }
  for (const mesh of json.meshes)
    mesh.primitives = mesh.primitives.filter(
      (p) => !p.__drop && p.attributes?.POSITION !== undefined && accessors[p.attributes.POSITION],
    );

  // Textures: WebP sources embedded in the file; anything else (missing .tga) is dropped.
  const textures = [];
  const texMap = new Map();
  (json.textures ?? []).forEach((t, i) => {
    const source = t.extensions?.EXT_texture_webp?.source ?? t.source;
    const img = json.images?.[source];
    if (!img || img.bufferView === undefined) return;
    if (!imageMap.has(source)) {
      const bv = json.bufferViews[img.bufferView];
      const bytes = new Uint8Array(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength);
      imageMap.set(
        source,
        images.push({ bufferView: w.add(bytes), mimeType: img.mimeType ?? 'image/webp' }) - 1,
      );
    }
    texMap.set(i, textures.push({ source: imageMap.get(source), sampler: 0 }) - 1);
  });
  for (const m of json.materials ?? []) {
    const pbr = m.pbrMetallicRoughness;
    if (pbr?.baseColorTexture) {
      const t = texMap.get(pbr.baseColorTexture.index);
      if (t === undefined) delete pbr.baseColorTexture;
      else pbr.baseColorTexture = { index: t };
    }
    delete pbr?.metallicRoughnessTexture;
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    fixMaterial(m);
  }

  json.accessors = accessors;
  if (textures.length) {
    json.textures = textures;
    json.images = images;
    json.samplers = [{ magFilter: 9729, minFilter: 9987 }];
  } else {
    delete json.textures;
    delete json.images;
    delete json.samplers;
  }
  delete json.extensionsUsed;
  delete json.extensionsRequired;
  json.asset = {
    version: '2.0',
    generator: 'kyzyl-aspan build-satellite-models (NASA 3D Resources, public domain)',
  };

  const bytes = writeGlb(join(outDir, file), json, w);
  console.log(
    `${file}: ${size} B, ${totalTris} tris → ${bytes} B, ${outTris} tris, ${textures.length} textures`,
  );
}

const [inDir, outDir = 'public/models'] = process.argv.slice(2);
if (!inDir) {
  console.error(
    'usage: node scripts/build-satellite-models.mjs <dir with terra.glb> [outDir]',
  );
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
await MeshoptSimplifier.ready;
const draco = await DracoDecoderModule();
for (const model of MODELS) await build(draco, resolve(inDir), resolve(outDir), model);
