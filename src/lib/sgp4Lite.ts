/**
 * The four SGP4 functions the browser needs, straight from satellite.js's plain modules. The package entry also
 * re-exports its WebAssembly bulk propagator, whose worker uses top-level await and Node built-ins — Vite cannot
 * bundle that for the browser, and the site never uses it. (The server keeps importing 'satellite.js' itself.)
 */
export { twoline2satrec } from '../../node_modules/satellite.js/dist/io.js';
export { propagate } from '../../node_modules/satellite.js/dist/propagation/propagate.js';
export { gstime } from '../../node_modules/satellite.js/dist/propagation/gstime.js';
export { eciToEcf, eciToGeodetic } from '../../node_modules/satellite.js/dist/transforms.js';
export type { SatRec } from '../../node_modules/satellite.js/dist/propagation/SatRec.js';
