import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import * as CANNON from 'cannon-es';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// fast raycasts against the big map mesh (meshes without a bounds tree raycast as usual)
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const V3 = THREE.Vector3, Q = THREE.Quaternion;
const $ = id => document.getElementById(id);
const _v1 = new V3(), _v2 = new V3(), _v3 = new V3(), _q1 = new Q(), _q2 = new Q();

// ---------------------------------------------------------------- renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
// phones and tablets: touch controls (see the touch module) and a lighter picture
// (?touch in the address forces them on, e.g. for a touch-screen laptop)
const IS_TOUCH = (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) || new URLSearchParams(location.search).has('touch');
renderer.setPixelRatio(Math.min(devicePixelRatio, IS_TOUCH ? 1.25 : 2));
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#9cc9f0');
scene.fog = new THREE.Fog('#9cc9f0', 80, 260);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 600);
camera.rotation.order = 'YXZ';
// In VR the headset moves the camera inside this rig, and the rig is put where the game wants your eyes.
// Outside VR it stays at the origin, so the camera's own position is its world position.
const xrRig = new THREE.Group();
xrRig.add(camera); scene.add(xrRig);

const hemi = new THREE.HemisphereLight('#f4f0ff', '#6a6050', 1.7); scene.add(hemi);   // strong ambient: we're mostly indoors
const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(IS_TOUCH ? 1024 : 2048, IS_TOUCH ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 200 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- canvas textures
function canvasTex(size, draw, repeat = 1) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat); t.anisotropy = 8;
  return t;
}
const tex = {
  grid: canvasTex(256, (g, s) => {
    g.fillStyle = '#b9bcc0'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#a9adb2'; g.fillRect(0, 0, s / 2, s / 2); g.fillRect(s / 2, s / 2, s / 2, s / 2);
    g.strokeStyle = '#7d8288'; g.lineWidth = 3; g.strokeRect(0, 0, s, s);
  }, 100),
  wall: canvasTex(256, (g, s) => {
    g.fillStyle = '#d8d2c4'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#b5ad9c'; g.lineWidth = 2;
    for (let y = 0; y < s; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
  }),
  wood: canvasTex(128, (g, s) => {
    g.fillStyle = '#a8763e'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#7a5226'; g.lineWidth = 2;
    for (let y = 16; y < s; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
    g.lineWidth = 10; g.strokeStyle = '#6b4520'; g.strokeRect(5, 5, s - 10, s - 10);
    g.lineWidth = 8; g.beginPath(); g.moveTo(8, 8); g.lineTo(s - 8, s - 8); g.stroke();
  }),
  metal: canvasTex(128, (g, s) => {
    g.fillStyle = '#4a6a8a'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#3a5470'; for (let y = 10; y < s; y += 40) g.fillRect(0, y, s, 6);
  }),
  boom: canvasTex(128, (g, s) => {
    g.fillStyle = '#b52218'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#f2c12e'; g.fillRect(0, s * 0.4, s, s * 0.2);
    g.fillStyle = '#111'; g.font = 'bold 22px sans-serif'; g.textAlign = 'center'; g.fillText('BOOM', s / 2, s * 0.56);
  }),
  beach: canvasTex(128, (g, s) => {
    const cols = ['#e33', '#fff', '#36d', '#fd3', '#fff', '#3c6'];
    cols.forEach((c, i) => { g.fillStyle = c; g.fillRect(i * s / 6, 0, s / 6 + 1, s); });
  }),
};

// ---------------------------------------------------------------- physics
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -12, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;
world.solver.iterations = 12;
const mat = {
  ground: new CANNON.Material('ground'), prop: new CANNON.Material('prop'),
  player: new CANNON.Material('player'), bouncy: new CANNON.Material('bouncy'),
};
world.defaultContactMaterial.friction = 0.4;
world.addContactMaterial(new CANNON.ContactMaterial(mat.player, mat.ground, { friction: 0, restitution: 0 }));
world.addContactMaterial(new CANNON.ContactMaterial(mat.player, mat.prop, { friction: 0, restitution: 0 }));
world.addContactMaterial(new CANNON.ContactMaterial(mat.bouncy, mat.ground, { friction: 0.4, restitution: 0.8 }));
world.addContactMaterial(new CANNON.ContactMaterial(mat.bouncy, mat.prop, { friction: 0.4, restitution: 0.7 }));
const G_WORLD = 1, G_PLAYER = 2;

// ---------------------------------------------------------------- map
const staticMeshes = [];
const stdMat = (opts) => new THREE.MeshStandardMaterial({ roughness: 0.85, ...opts });
function addStatic(size, pos, material, rot = [0, 0, 0]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  m.position.set(...pos); m.rotation.set(...rot);
  m.castShadow = m.receiveShadow = true;
  scene.add(m); staticMeshes.push(m);
  const b = new CANNON.Body({ mass: 0, material: mat.ground, shape: new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2)) });
  b.position.set(...pos); b.quaternion.copy(m.quaternion);
  world.addBody(b);
  return m;
}
// The world is the Lethal Ape Redux map (an indoor facility), loaded from assets/map.
// Its mesh doubles as the physics floor/walls (a trimesh: spheres collide with it) and as the source of
// a walk graph the killers use to find their way through the corridors.
let mapReady = false, FALL_Y = -30, mapMesh = null;
// The map is a thin trimesh: a small, fast ball (prop edges, ragdoll limbs) can step right through it in one physics
// step and drop under the floor. After each step, anything that moved through the map surface is put back on it.
const antiTunnel = {
  prev: new Map(), ray: new THREE.Raycaster(), d: new V3(), a: new V3(), b: new V3(), off: new CANNON.Vec3(), w: new CANNON.Vec3(),
  bodies() {
    const out = [];
    for (const p of props) if (!p.frozen && p.body.type === CANNON.Body.DYNAMIC) out.push(p.body);
    for (const rd of ragdolls.list) for (const b of rd.bodies) if (b.type === CANNON.Body.DYNAMIC) out.push(b);
    return out;
  },
  // where each ball of the body is now
  spheres(b, out) {
    for (let i = 0; i < b.shapes.length; i++) {
      const sh = b.shapes[i]; if (!(sh instanceof CANNON.Sphere)) continue;
      b.quaternion.vmult(b.shapeOffsets[i], this.w);
      out.push(b.position.x + this.w.x, b.position.y + this.w.y, b.position.z + this.w.z, sh.radius);
    }
    return out;
  },
  before() {
    if (!mapMesh) return;
    for (const b of this.bodies()) {
      if (b.velocity.lengthSquared() < 9) { this.prev.delete(b); continue; }   // slow things can't tunnel
      this.prev.set(b, this.spheres(b, []));
    }
  },
  after() {
    if (!mapMesh) return;
    for (const [b, was] of this.prev) {
      const now = this.spheres(b, []);
      if (now.length !== was.length) continue;
      let fix = null, best = Infinity;
      for (let i = 0; i < now.length; i += 4) {
        this.a.set(was[i], was[i + 1], was[i + 2]); this.b.set(now[i], now[i + 1], now[i + 2]);
        const L = this.a.distanceTo(this.b); if (L < 1e-4) continue;
        this.d.subVectors(this.b, this.a).divideScalar(L);
        this.ray.set(this.a, this.d); this.ray.far = L + now[i + 3];
        const hit = this.ray.intersectObject(mapMesh, false)[0];
        if (!hit || hit.distance >= best) continue;
        // the surface normal, facing back where the ball came from
        const n = hit.face.normal.clone(); if (n.dot(this.d) > 0) n.negate();
        best = hit.distance;
        fix = { n, push: this.b.clone().sub(hit.point).dot(n) * -1 + now[i + 3] + 0.01 };
      }
      if (!fix || fix.push <= 0) continue;
      b.position.x += fix.n.x * fix.push; b.position.y += fix.n.y * fix.push; b.position.z += fix.n.z * fix.push;
      const vn = b.velocity.x * fix.n.x + b.velocity.y * fix.n.y + b.velocity.z * fix.n.z;
      if (vn < 0) { b.velocity.x -= vn * fix.n.x; b.velocity.y -= vn * fix.n.y; b.velocity.z -= vn * fix.n.z; }   // stop going into it (no bounce)
    }
    this.prev.clear();
  },
};
async function loadMap() {
  const mgr = new THREE.LoadingManager();
  mgr.setURLModifier(u => (u.startsWith('blob:') || u.startsWith('data:')) ? u : 'assets/map/' + u.split(/[\\/]/).pop());
  const fbx = await new FBXLoader(mgr).loadAsync('Map.fbx');
  fbx.scale.setScalar(0.01);                       // centimetres -> metres
  fbx.updateMatrixWorld(true);
  let src = null;
  fbx.traverse(o => { if (!src && o.isMesh) src = o; });
  // bake into world space so the render mesh, the physics trimesh and the walk graph share coordinates
  const geo = src.geometry.clone();
  geo.applyMatrix4(src.matrixWorld);
  geo.computeBoundsTree();
  // the images embedded in the FBX come out dark and see-through, so use the zip's albedo files
  // (matched to the materials through the FBX's texture connections); normal maps are left out
  const ALBEDO = { New_Material_3: 'TCom_Plaster_Rough_1K_albedo.png', New_Material_0: 'newfloortiles.png', New_Material_1_1: '2056.png', New_Material: 'TCom_Asphalt10_2x2_1K_albedo.png' };
  const tl = new THREE.TextureLoader();
  const mats = [].concat(src.material).map(m => {
    let map = m.map;
    if (ALBEDO[m.name]) { map = tl.load('assets/map/' + ALBEDO[m.name]); map.wrapS = map.wrapT = THREE.RepeatWrapping; map.anisotropy = 8; }
    if (map) map.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map, roughness: 0.9, side: THREE.DoubleSide });
  });
  const mesh = new THREE.Mesh(geo, mats.length > 1 ? mats : mats[0]);
  mesh.receiveShadow = true;                       // no castShadow: the roof would shade every room
  scene.add(mesh); staticMeshes.push(mesh); mapMesh = mesh;

  // physics: one trimesh per 12 m block (a triangle goes in every block it touches). A single trimesh
  // of the whole map makes every collision test walk thousands of big triangles.
  const pos = geo.attributes.position;
  const idx = geo.index ? geo.index.array : Uint32Array.from({ length: pos.count }, (_, i) => i);
  const CH = 12, blocks = new Map();
  for (let t = 0; t < idx.length / 3; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k], x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z); x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
    }
    for (let bx = Math.floor(x0 / CH); bx <= Math.floor(x1 / CH); bx++)
      for (let by = Math.floor(y0 / CH); by <= Math.floor(y1 / CH); by++)
        for (let bz = Math.floor(z0 / CH); bz <= Math.floor(z1 / CH); bz++) {
          const k = bx + ',' + by + ',' + bz;
          (blocks.get(k) || blocks.set(k, []).get(k)).push(t);
        }
  }
  for (const tris of blocks.values()) {
    const remap = new Map(), verts = [], ind = [];
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      if (!remap.has(v)) { remap.set(v, verts.length / 3); verts.push(pos.getX(v), pos.getY(v), pos.getZ(v)); }
      ind.push(remap.get(v));
    }
    world.addBody(new CANNON.Body({ mass: 0, material: mat.ground, shape: new CANNON.Trimesh(verts, ind) }));
  }

  geo.computeBoundingBox();
  FALL_Y = geo.boundingBox.min.y - 15;
  nav.build(mesh);
  mapReady = true;
  console.log('[map] tris', idx.length / 3, 'walk nodes', nav.nodes.length);
}

// ---- walk graph: one node per 1 m floor cell under a roof, linked to neighbours you can walk to
const nav = {
  nodes: [], cells: new Map(), CELL: 1,
  ray: new THREE.Raycaster(),
  hit(mesh, from, dir, far) { this.ray.set(from, dir); this.ray.far = far; this.ray.firstHitOnly = true; return this.ray.intersectObject(mesh)[0]; },
  build(mesh) {
    const C = this.CELL, geo = mesh.geometry, pos = geo.attributes.position, index = geo.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    const a = new V3(), b = new V3(), c = new V3(), n = new V3(), e = new V3(), UP = new V3(0, 1, 0);
    const cand = new Map();
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3, i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1, i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
      n.subVectors(c, b).cross(e.subVectors(a, b)).normalize();
      if (Math.abs(n.y) < 0.6) continue;              // floors and gentle ramps only
      const x0 = Math.floor(Math.min(a.x, b.x, c.x) / C), x1 = Math.floor(Math.max(a.x, b.x, c.x) / C);
      const z0 = Math.floor(Math.min(a.z, b.z, c.z) / C), z1 = Math.floor(Math.max(a.z, b.z, c.z) / C);
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
        const px = (gx + 0.5) * C, pz = (gz + 0.5) * C;
        const v0x = c.x - a.x, v0z = c.z - a.z, v1x = b.x - a.x, v1z = b.z - a.z, v2x = px - a.x, v2z = pz - a.z;
        const d00 = v0x * v0x + v0z * v0z, d01 = v0x * v1x + v0z * v1z, d11 = v1x * v1x + v1z * v1z, d20 = v2x * v0x + v2z * v0z, d21 = v2x * v1x + v2z * v1z;
        const den = d00 * d11 - d01 * d01;
        if (Math.abs(den) < 1e-9) continue;
        const u = (d11 * d20 - d01 * d21) / den, v = (d00 * d21 - d01 * d20) / den;
        if (u < 0 || v < 0 || u + v > 1) continue;
        const y = a.y + u * (c.y - a.y) + v * (b.y - a.y);
        const key = gx + ',' + gz + ',' + Math.round(y * 2);
        if (!cand.has(key)) cand.set(key, { x: px, y, z: pz, gx, gz });
      }
    }
    // indoors only: a ceiling somewhere above, but at least 2 m of headroom
    let nodes = [];
    for (const nd of cand.values()) {
      const h = this.hit(mesh, new V3(nd.x, nd.y + 0.05, nd.z), UP, 15);
      if (h && h.distance > 2.0) { nd.nb = []; nd.i = nodes.length; nodes.push(nd); }
    }
    const grid = new Map();
    for (const nd of nodes) { const k = nd.gx + ',' + nd.gz; (grid.get(k) || grid.set(k, []).get(k)).push(nd); }
    const o = new V3(), d = new V3();
    for (const nd of nodes) for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      for (const m of grid.get((nd.gx + dx) + ',' + (nd.gz + dz)) || []) {
        if (Math.abs(m.y - nd.y) > 1.2) continue;     // up to a 1.2 m ledge (jumpable)
        let clear = true;
        for (const hgt of [0.7, 1.5]) {
          o.set(nd.x, Math.max(nd.y, m.y) + hgt, nd.z); d.set(m.x - nd.x, 0, m.z - nd.z);
          const L = d.length(); d.normalize();
          if (this.hit(mesh, o, d, L)) { clear = false; break; }
        }
        if (clear) { nd.nb.push(m.i); m.nb.push(nd.i); }
      }
    }
    // keep the biggest connected area
    const comp = new Int32Array(nodes.length).fill(-1); let best = -1, bestN = 0;
    for (let i = 0, id = 0; i < nodes.length; i++, id++) {
      if (comp[i] >= 0) { id--; continue; }
      let cnt = 0; const st = [i]; comp[i] = id;
      while (st.length) { const j = st.pop(); cnt++; for (const k of nodes[j].nb) if (comp[k] < 0) { comp[k] = id; st.push(k); } }
      if (cnt > bestN) { bestN = cnt; best = id; }
    }
    const remap = new Int32Array(nodes.length).fill(-1);
    const keep = nodes.filter(nd => comp[nd.i] === best);
    keep.forEach((nd, i) => remap[nd.i] = i);
    keep.forEach(nd => { nd.nb = nd.nb.map(k => remap[k]).filter(k => k >= 0); });
    keep.forEach((nd, i) => { nd.i = i; nd.p = new V3(nd.x, nd.y, nd.z); });
    this.nodes = keep;
    this.cells.clear();
    for (const nd of keep) { const k = nd.gx + ',' + nd.gz; (this.cells.get(k) || this.cells.set(k, []).get(k)).push(nd); }
    // how open each spot is (walkable cells within 3 m at about the same height) - used to pick rooms
    for (const nd of keep) {
      let open = 0;
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++)
        for (const m of this.cells.get((nd.gx + dx) + ',' + (nd.gz + dz)) || []) if (Math.abs(m.y - nd.y) < 0.4) open++;
      nd.open = open;
    }
  },
  nearest(p) {
    const gx = Math.floor(p.x / this.CELL), gz = Math.floor(p.z / this.CELL);
    let best = null, bd = Infinity;
    for (let r = 0; r <= 4 && !best; r++)
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const nd of this.cells.get((gx + dx) + ',' + (gz + dz)) || []) {
          const dy = nd.y - p.y, d = (nd.x - p.x) ** 2 + (nd.z - p.z) ** 2 + (dy < -0.3 || dy > 1.3 ? 9 * dy * dy : 0);
          if (d < bd) { bd = d; best = nd; }
        }
      }
    return best;
  },
  // A* from one world position to another; returns node positions to walk through, or null
  path(from, to) {
    const s = this.nearest(from), g = this.nearest(to);
    if (!s || !g) return null;
    if (s === g) return [g.p];
    const N = this.nodes, gs = new Float32Array(N.length).fill(Infinity), came = new Int32Array(N.length).fill(-1), closed = new Uint8Array(N.length);
    const heap = [];   // [f, i]
    const push = (f, i) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const pk = (k - 1) >> 1; if (heap[pk][0] <= heap[k][0]) break; [heap[pk], heap[k]] = [heap[k], heap[pk]]; k = pk; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    gs[s.i] = 0; push(s.p.distanceTo(g.p), s.i);
    let iter = 0;
    while (heap.length && iter++ < 20000) {
      const [, i] = pop();
      if (closed[i]) continue;
      if (i === g.i) break;
      closed[i] = 1;
      const a = N[i];
      for (const j of a.nb) {
        const b = N[j], ng = gs[i] + a.p.distanceTo(b.p);
        if (ng < gs[j]) { gs[j] = ng; came[j] = i; push(ng + b.p.distanceTo(g.p), j); }
      }
    }
    if (came[g.i] < 0) return null;
    const out = [];
    for (let i = g.i; i !== s.i; i = came[i]) out.push(N[i].p);
    return out.reverse();
  },
  random(filter = () => true) {
    for (let k = 0; k < 200; k++) { const nd = this.nodes[Math.floor(Math.random() * this.nodes.length)]; if (filter(nd)) return nd; }
    return this.nodes[Math.floor(Math.random() * this.nodes.length)];
  },
};

// ---------------------------------------------------------------- sound
let actx = null;
function audio() { if (!actx) actx = new AudioContext(); return actx; }
// volume: a master level and three groups, saved in the browser. Every synth sound goes through bus(group);
// the killers' sound files (HTML audio) are scaled by htmlVol().
const VOL_KEY = 'apeSandbox.volume', VOL_CATS = ['master', 'monsters', 'effects', 'ambience'];
const volume = Object.assign({ master: 0.5, monsters: 0.7, effects: 0.7, ambience: 0.6, muted: false },
  (() => { try { return JSON.parse(localStorage.getItem(VOL_KEY)) || {}; } catch { return {}; } })());
let buses = null;
function bus(cat) {
  const a = audio();
  if (!buses) {
    const m = a.createGain(); m.connect(a.destination); buses = { master: m };
    for (const c of VOL_CATS.slice(1)) { const g = a.createGain(); g.connect(m); buses[c] = g; }
    applyVolume();
  }
  return buses[cat] || buses.effects;
}
const htmlVol = () => volume.muted ? 0 : volume.master * volume.monsters;
function applyVolume() {
  try { localStorage.setItem(VOL_KEY, JSON.stringify(volume)); } catch {}
  if (buses) {
    buses.master.gain.value = volume.muted ? 0 : volume.master;
    for (const c of VOL_CATS.slice(1)) buses[c].gain.value = volume[c];
  }
  try { for (const kl of killers) for (const a of Object.values(kl.sounds)) if (a.baseVol != null) a.volume = Math.min(1, a.baseVol * htmlVol()); } catch {}
}
function beep(freq = 440, dur = 0.08, type = 'sine', vol = 0.08) {
  const a = audio(), o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = freq; g.gain.value = vol;
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(bus('effects')); o.start(); o.stop(a.currentTime + dur);
}
function boomSound(vol = 0.5) {
  const a = audio(), len = a.sampleRate * 0.8, buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  f.type = 'lowpass'; f.frequency.value = 700; g.gain.value = vol;
  s.buffer = buf; s.connect(f).connect(g).connect(bus('effects')); s.start();
}

// ---------------------------------------------------------------- UI helpers
let toastTimer = 0;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.opacity = 1; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.opacity = 0, 1400); }

// ---------------------------------------------------------------- ape model + rig
const APE_HEIGHT = 1.6;   // torso + head, in metres
let apeSource = null;          // loaded FBX (for statue clones)
const apeRoot = new THREE.Group();   // world position + yaw
const apeBody = new THREE.Group();   // bob / sway / lean
apeRoot.add(apeBody); scene.add(apeRoot);
const rig = { arms: [], head: null, spine: null, rest: new Map(), local0: new Map() };

async function loadApe() {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => (url.startsWith('blob:') || url.startsWith('data:')) ? url : 'assets/' + url.split(/[\\/]/).pop());
  const fbx = await new FBXLoader(manager).loadAsync('Ape.fbx');
  const tl = new THREE.TextureLoader();
  const loadTex = (f, srgb) => { const t = tl.load('assets/' + f); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };
  const fur = loadTex('GorillaFur.png', true), face = loadTex('PrimalFear_face_remade.png', true), furN = loadTex('GorillaFurNormal.png', false);
  const mk = m => new THREE.MeshStandardMaterial({ name: m.name, map: /_2$/.test(m.name) ? face : fur, normalMap: furN, roughness: 0.95 });
  fbx.traverse(o => {
    if (o.isMesh) {
      o.material = Array.isArray(o.material) ? o.material.map(mk) : mk(o.material);
      o.castShadow = o.receiveShadow = true; o.frustumCulled = false;
    }
  });

  const bone = n => {
    let found = null;
    fbx.traverse(o => { if (!found && o.isBone && o.name.toLowerCase() === n.toLowerCase()) found = o; });
    if (!found) throw new Error('Missing bone ' + n);
    return found;
  };
  // Work out the model's own axes from its bones, then turn it to face -Z with +Y up.
  fbx.updateMatrixWorld(true);
  const wp = n => bone(n).getWorldPosition(new V3());
  const up = wp('Bone_002').sub(wp('Bone_001')).normalize();
  const left = wp('Bone_004_L').sub(wp('Bone_004_R'));
  left.sub(up.clone().multiplyScalar(left.dot(up))).normalize();
  const fwd = new V3().crossVectors(left, up);
  const basis = new THREE.Matrix4().makeBasis(left.clone().negate(), up, fwd.clone().negate());
  fbx.quaternion.premultiply(new Q().setFromRotationMatrix(basis).invert());
  // skinned bounds need fresh bone matrices, which three only computes at render time
  // (torso + head only: the arms hang below the body in the bind pose)
  const isArm = b => /_[LR]$/.test(b.name);
  const skinnedBox = () => {
    fbx.updateMatrixWorld(true);
    const box = new THREE.Box3(), p = new V3();
    fbx.traverse(o => {
      if (!o.isSkinnedMesh) return;
      o.skeleton.update();
      const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight;
      for (let i = 0; i < si.count; i++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (isArm(o.skeleton.bones[si.getComponent(i, k)])) w += sw.getComponent(i, k);
        if (w > 0.3) continue;
        o.getVertexPosition(i, p); box.expandByPoint(o.localToWorld(p));
      }
    });
    return box;
  };
  let box = skinnedBox();
  fbx.scale.multiplyScalar(APE_HEIGHT / (box.max.y - box.min.y));
  box = skinnedBox();
  const pelvis = wp('Bone_001');
  fbx.position.x -= pelvis.x; fbx.position.z -= pelvis.z; fbx.position.y -= box.min.y;
  apeBody.add(fbx);
  apeRoot.position.set(0, 0, 0); apeRoot.rotation.set(0, 0, 0);
  apeRoot.updateMatrixWorld(true);
  apeSource = fbx;
  Object.assign(rig, buildRig(fbx, apeRoot));
  hats.player = hats.register(bone('Bone_002'), new V3(0, 0, -1));      // the ape faces -Z here
  console.log('[ape] arm length', rig.reach.toFixed(2), 'shoulder height', rig.shoulderY.toFixed(2));
}

// Rest pose of an ape (the player or a copy of it) in its root's ("character") space.
// The root must sit at the origin, unrotated, while this runs.
const APE_SPEC = {
  spine: 'Bone_001', head: 'Bone_002',
  arms: ['L', 'R'].map(s => ({
    side: s === 'L' ? -1 : 1, up: `Bone_004_${s}`, fore: `Bone_005_${s}`, hand: `Bone_006_${s}`,
    fingers: [[`Bone_008_${s}`, `Bone_009_${s}`, `Bone_010_${s}`], [`Bone_012_${s}`, `Bone_013_${s}`, `Bone_014_${s}`], [`Bone_016_${s}`, `Bone_016_L_001_${s}`, `Bone_017_${s}`]],
  })),
};
function buildRig(fbx, root, spec = APE_SPEC) {
  const r = { root, arms: [], rest: new Map(), local0: new Map() };
  const byName = {};
  fbx.traverse(o => { if (o.isBone && !byName[o.name.toLowerCase()]) byName[o.name.toLowerCase()] = o; });   // first match: the FBX repeats some bone names
  root.updateMatrixWorld(true);
  const remember = n => {
    const b = byName[n.toLowerCase()];
    if (!b) throw new Error('Missing bone ' + n);
    r.local0.set(b, b.quaternion.clone());
    r.rest.set(b, { q: b.getWorldQuaternion(new Q()), p: root.worldToLocal(b.getWorldPosition(new V3())) });
    return b;
  };
  r.spine = remember(spec.spine);
  r.head = remember(spec.head);
  for (const s of spec.arms) {
    const a = {
      side: s.side, up: remember(s.up), fore: remember(s.fore), hand: remember(s.hand),
      fingers: s.fingers.map(chain => chain.map(remember)),
    };
    const S = r.rest.get(a.up).p, E = r.rest.get(a.fore).p, W = r.rest.get(a.hand).p;
    a.L1 = S.distanceTo(E); a.L2 = E.distanceTo(W);
    a.dirU = E.clone().sub(S).normalize(); a.dirF = W.clone().sub(E).normalize();
    r.arms.push(a);
  }
  r.reach = r.arms[0].L1 + r.arms[0].L2;
  r.shoulderY = r.rest.get(r.arms[0].up).p.y;
  return r;
}

function setWorldQ(b, qw) {
  b.parent.getWorldQuaternion(_q1);
  b.quaternion.copy(_q1.invert().multiply(qw));
  b.updateMatrixWorld(true);
}
// rotate a bone by a world-space delta on top of its current pose
function rotateWorld(b, axis, angle) {
  b.parent.getWorldQuaternion(_q1);
  _q2.setFromAxisAngle(axis, angle);
  const parentInv = _q1.clone().invert();
  b.quaternion.premultiply(parentInv.multiply(_q2).multiply(_q1));
  b.updateMatrixWorld(true);
}

// two-bone IK in apeRoot ("character") space
const ik = { S: new V3(), D: new V3(), elbow: new V3(), wrist: new V3(), pp: new V3(), du: new V3(), df: new V3() };
function solveArm(a, target, pole, wristBend, R = rig) {
  const root = R.root, rest = R.rest;
  const charQ = root.quaternion;
  const S = root.worldToLocal(a.up.getWorldPosition(ik.S));
  const D = ik.D.subVectors(target, S);
  const max = (a.L1 + a.L2) * 0.995, min = Math.abs(a.L1 - a.L2) + 0.05;
  const d = THREE.MathUtils.clamp(D.length(), min, max);
  D.normalize();
  const along = (a.L1 * a.L1 - a.L2 * a.L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.L1 * a.L1 - along * along));
  const pp = ik.pp.copy(pole).addScaledVector(D, -pole.dot(D));
  if (pp.lengthSq() < 1e-6) pp.set(0, 1, 0);
  pp.normalize();
  ik.elbow.copy(S).addScaledVector(D, along).addScaledVector(pp, h);
  ik.wrist.copy(S).addScaledVector(D, d);
  ik.du.subVectors(ik.elbow, S).normalize();
  ik.df.subVectors(ik.wrist, ik.elbow).normalize();

  const R1 = new Q().setFromUnitVectors(a.dirU, ik.du);
  setWorldQ(a.up, charQ.clone().multiply(R1).multiply(rest.get(a.up).q));
  const fRot = a.dirF.clone().applyQuaternion(R1);
  const Rf = new Q().setFromUnitVectors(fRot, ik.df).multiply(R1);
  setWorldQ(a.fore, charQ.clone().multiply(Rf).multiply(rest.get(a.fore).q));
  setWorldQ(a.hand, charQ.clone().multiply(Rf).multiply(rest.get(a.hand).q));
  // bend wrist / curl fingers toward the ground
  const dfW = ik.df.clone().applyQuaternion(charQ);
  const axis = new V3().crossVectors(dfW, new V3(0, 1, 0));
  if (axis.lengthSq() > 1e-4) {
    axis.normalize();
    if (wristBend) rotateWorld(a.hand, axis, -wristBend);
    a.fingers.forEach((chain, ci) => chain.forEach(b => rotateWorld(b, axis, -(ci === 2 ? 0.15 : 0.35) * (wristBend > 0 ? 1 : 0.3))));
  }
}

// ---------------------------------------------------------------- player
const SPAWN = new CANNON.Vec3(0, 1, 0);
const player = {
  body: new CANNON.Body({ mass: 90, material: mat.player, fixedRotation: true, linearDamping: 0, collisionFilterGroup: G_PLAYER }),
  yaw: 0, pitch: -0.15, faceYaw: 0, grounded: false, thirdPerson: false, dead: false,
  health: 100, phase: 0, speed: 0, airTime: 0,
};
player.body.addShape(new CANNON.Sphere(0.45), new CANNON.Vec3(0, 0.45, 0));
player.body.addShape(new CANNON.Sphere(0.45), new CANNON.Vec3(0, 1.25, 0));
player.body.position.copy(SPAWN);
player.body.allowSleep = false;
world.addBody(player.body);

const keys = {};
let locked = false, menuOpen = false;
const rayRes = new CANNON.RaycastResult();
function groundCheck() {
  const p = player.body.position;
  rayRes.reset();
  return world.raycastClosest(new CANNON.Vec3(p.x, p.y + 0.4, p.z), new CANNON.Vec3(p.x, p.y - 0.15, p.z),
    { collisionFilterMask: G_WORLD, skipBackfaces: true }, rayRes);
}
function camForward(out = new V3()) {
  return out.set(-Math.sin(player.yaw) * Math.cos(player.pitch), Math.sin(player.pitch), -Math.cos(player.yaw) * Math.cos(player.pitch));
}
function updatePlayer(dt) {
  const b = player.body;
  const fwd = new V3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw)), right = new V3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  const wish = new V3();
  if (!menuOpen) {
    if (keys.KeyW) wish.add(fwd); if (keys.KeyS) wish.sub(fwd);
    if (keys.KeyD) wish.add(right); if (keys.KeyA) wish.sub(right);
    for (const m of [pad.move, touch.move, vr.move]) if (m.lengthSq()) wish.addScaledVector(fwd, m.y).addScaledVector(right, m.x);
  }
  if (!mapReady) { b.position.copy(SPAWN); b.velocity.set(0, 0, 0); return; }   // nothing to stand on yet
  if (player.dead) { b.velocity.set(0, Math.min(b.velocity.y, 0), 0); player.speed = 0; return; }
  if (wish.lengthSq() > 1) wish.normalize();     // a half-pushed stick walks slower
  const run = keys.ShiftLeft || keys.ShiftRight || touch.run;
  player.grounded = groundCheck();
  const speed = run ? 9 : 4.5;
  const accel = player.grounded ? 14 : 3;
  const k = 1 - Math.exp(-accel * dt);
  b.velocity.x += (wish.x * speed - b.velocity.x) * k;
  b.velocity.z += (wish.z * speed - b.velocity.z) * k;
  if (player.grounded && keys.Space && b.velocity.y < 1 && !menuOpen) { b.velocity.y = 7; beep(180, 0.12, 'triangle', 0.05); }
  player.speed = Math.hypot(b.velocity.x, b.velocity.z);
  player.airTime = player.grounded ? 0 : player.airTime + dt;
  if (b.position.y < FALL_Y) respawn();
}
function respawn() {
  player.body.position.copy(SPAWN); player.body.velocity.set(0, 0, 0);
  director.reset();       // back at the start: the hunt starts over
  player.health = 100;
}
function hurt(n) {
  player.health = Math.max(0, player.health - n);
  if (player.health <= 0) { toast('You died!'); boomSound(0.2); respawn(); }
}

// ---------------------------------------------------------------- camera
const camRay = new THREE.Raycaster();
const EYE_UP = 0.12, EYE_FWD = 0.22;
function updateCamera() {
  const p = apeRoot.position;
  const f = camForward();
  camera.rotation.set(player.pitch, player.yaw, 0);
  if (player.thirdPerson) {
    const pivot = _v1.set(p.x, p.y + 1.9, p.z);
    const right = _v2.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    const want = _v3.copy(pivot).addScaledVector(f, -5).addScaledVector(right, 0.9);
    const dir = want.clone().sub(pivot); const len = dir.length(); dir.normalize();
    camRay.set(pivot, dir); camRay.far = len;
    const hit = camRay.intersectObjects(staticMeshes, false)[0];
    camera.position.copy(pivot).addScaledVector(dir, hit ? Math.max(0.3, hit.distance - 0.3) : len);
  } else {
    // eyes: just in front of the head bone, so the player sees out of the ape's head
    rig.head ? rig.head.getWorldPosition(camera.position) : camera.position.set(p.x, p.y + 1.4, p.z);
    camera.position.y += EYE_UP;
    camera.position.x -= Math.sin(player.faceYaw) * EYE_FWD;
    camera.position.z -= Math.cos(player.faceYaw) * EYE_FWD;
  }
}

// ---------------------------------------------------------------- ape animation
const groundRay = new THREE.Raycaster();
function groundHeightAt(worldX, worldZ, fromY) {
  groundRay.set(_v1.set(worldX, fromY, worldZ), _v2.set(0, -1, 0)); groundRay.far = 6;
  const hit = groundRay.intersectObjects(staticMeshes.concat(props.filter(p => !p.isApe).map(p => p.mesh)), true)[0];
  return hit ? hit.point.y : null;
}
let aimingArm = 0;   // >0 while a tool is being used (right arm reaches out)
function animateApe(dt, t) {
  if (!rig.head) return;
  // smooth body yaw toward camera yaw
  let dy = player.yaw - player.faceYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  player.faceYaw += dy * Math.min(1, dt * 10);
  apeRoot.rotation.set(0, player.faceYaw, 0);

  const speedF = THREE.MathUtils.clamp(player.speed / 9, 0, 1);
  const running = player.speed > 6;
  const stride = 0.35 + 0.55 * speedF;
  if (player.speed > 0.3) player.phase += Math.PI * player.speed / (2 * stride) * dt;
  const airborne = !player.grounded && player.airTime > 0.12;

  // whole-body bob, sway, lean
  const ph = player.phase;
  const bob = airborne ? 0 : (running ? Math.abs(Math.sin(ph)) * 0.18 : Math.abs(Math.sin(ph)) * 0.07 * speedF) + Math.sin(t * 2.2) * 0.012;
  apeBody.position.set(0, bob, 0);
  apeBody.rotation.set(-0.12 * speedF - (airborne ? 0.15 : 0), 0, running ? 0 : Math.sin(ph) * 0.09 * speedF);

  // reset driven bones to their bind pose
  for (const [b, q] of rig.local0) b.quaternion.copy(q);
  apeRoot.updateMatrixWorld(true);

  // head looks where the camera looks
  const yawOff = THREE.MathUtils.clamp(Math.atan2(Math.sin(player.yaw - player.faceYaw), Math.cos(player.yaw - player.faceYaw)), -0.8, 0.8);
  const look = new Q().setFromEuler(new THREE.Euler(THREE.MathUtils.clamp(player.pitch, -0.7, 0.6) * 0.7, yawOff, 0, 'YXZ'));
  setWorldQ(rig.head, apeRoot.quaternion.clone().multiply(look).multiply(rig.rest.get(rig.head).q));

  const f = camForward();
  const fChar = f.clone().applyQuaternion(apeRoot.quaternion.clone().invert());
  aimingArm = Math.max(0, aimingArm - dt);
  for (const a of rig.arms) {
    const S = apeRoot.worldToLocal(a.up.getWorldPosition(new V3()));
    const pole = new V3(a.side * 0.7, 1, 0.5);
    let target, bend = 0.9;
    if (a.side > 0 && tools.list[tools.current] === 'Stick') {
      target = stick.armTarget(S); pole.set(1, 0.4, 0.6); bend = 0;
    } else if (a.side > 0 && (aimingArm > 0 || tools.holding())) {
      target = S.clone().addScaledVector(fChar, rig.reach * 0.97);
      pole.set(a.side, 0.2, 0.6); bend = 0;
    } else if (airborne) {
      const fl = Math.sin(t * 9 + a.side) * 0.25;
      // raised arms would sit right against the eyes in first person, so keep them out and down there
      const reachDir = player.thirdPerson ? new V3(a.side * 0.7, 0.55 + fl, -0.25 + fl) : new V3(a.side * 0.45, -0.9 + fl * 0.3, -0.35);
      target = S.clone().add(reachDir.normalize().multiplyScalar(rig.reach * 0.85));
      pole.set(a.side, 0.3, 1); bend = 0.2;
    } else {
      // knuckle-walk: hands plant ahead of the body, alternate (walk) or together (gallop)
      const pha = running ? ph : ph + (a.side > 0 ? Math.PI : 0);
      const amp = player.speed > 0.3 ? stride : 0;
      const forward = Math.min(rig.reach * 0.55, 1.2) + 0.25 * speedF;
      target = new V3(S.x + a.side * 0.35, 0, -forward + amp * Math.cos(pha));
      const lift = Math.max(0, Math.sin(pha)) * (running ? 0.5 : 0.3) * (amp > 0 ? 1 : 0);
      const tw = apeRoot.localToWorld(target.clone());
      const gy = groundHeightAt(tw.x, tw.z, apeRoot.position.y + 1.5);
      const groundLocal = gy == null ? 0 : THREE.MathUtils.clamp(gy - apeRoot.position.y, -1, 1.2);
      target.y = groundLocal + 0.13 + lift;
    }
    solveArm(a, target, pole, bend);
  }
}

// ---------------------------------------------------------------- props
const props = [];
const undoStack = [];
const propByBody = new Map();
const propModels = { shelf: null, speaker: null };   // loaded templates (see loadPropModels)

// cannon only collides spheres with the map's trimesh, so boxes and cylinders also carry small
// spheres along their edges: those are what rest on the map floor and bump its walls
function addEdgeSpheres(body, hx, hy, hz, r = 0.08) {
  const steps = h => Math.max(1, Math.ceil(2 * h / 1.1));
  const pts = [];
  for (const sy of [-1, 1]) for (const sz of [-1, 1]) { const n = steps(hx); for (let i = 0; i <= n; i++) pts.push([-hx + 2 * hx * i / n, sy * hy, sz * hz]); }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const n = steps(hy); for (let i = 1; i < n; i++) pts.push([sx * hx, -hy + 2 * hy * i / n, sz * hz]); }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) { const n = steps(hz); for (let i = 1; i < n; i++) pts.push([sx * hx, sy * hy, -hz + 2 * hz * i / n]); }
  const inset = v => v - Math.sign(v) * r;
  for (const [x, y, z] of pts) body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(inset(x), inset(y), inset(z)));
}
function addRimSpheres(body, radius, height, r = 0.07) {
  for (const sy of [-1, 1]) for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(Math.cos(a) * (radius - r), sy * (height / 2 - r), Math.sin(a) * (radius - r)));
  }
}
async function loadPropModels() {
  const mgr = new THREE.LoadingManager();
  mgr.setURLModifier(u => (u.startsWith('blob:') || u.startsWith('data:')) ? u : 'assets/shelf/' + u.split(/[\\/]/).pop());
  const [shelf, speaker] = await Promise.all([new FBXLoader(mgr).loadAsync('Iron_shelf.fbx'), _gltf.loadAsync('assets/speaker/Speaker.glb')]);
  const tl = new THREE.TextureLoader();
  const t = (f, srgb) => { const x = tl.load('assets/shelf/' + f); if (srgb) x.colorSpace = THREE.SRGBColorSpace; return x; };
  const iron = new THREE.MeshStandardMaterial({ map: t('Iron_shelf_DefaultMaterial_BaseColor.png', true), metalnessMap: t('Iron_shelf_DefaultMaterial_Metallic.png'),
    roughnessMap: t('Iron_shelf_DefaultMaterial_Roughness.png'), metalness: 1, roughness: 1 });
  shelf.traverse(o => { if (o.isMesh) o.material = iron; });
  const centre = (obj, scale) => {
    obj.scale.multiplyScalar(scale); obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj), c = box.getCenter(new V3());
    obj.position.sub(c);
    const g = new THREE.Group(); g.add(obj);
    g.userData.half = box.getSize(new V3()).multiplyScalar(0.5);
    return g;
  };
  propModels.shelf = centre(shelf, 0.01);           // ~0.6 x 2 x 2 m
  propModels.speaker = centre(speaker.scene, 2.6);  // a floor-standing speaker
}
function makeProp(kind) {
  let mesh, shape, mass, material = mat.prop, extra = {};
  const shade = m => { m.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } }); return m; };
  switch (kind) {
    case 'crate': case 'small crate': case 'big crate': {
      const s = kind === 'crate' ? 1 : kind === 'small crate' ? 0.55 : 2;
      mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), stdMat({ map: tex.wood }));
      shape = new CANNON.Box(new CANNON.Vec3(s / 2, s / 2, s / 2)); mass = 25 * s * s * s; break;
    }
    case 'barrel': case 'explosive barrel': {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 1.1, 20), stdMat({ map: kind === 'barrel' ? tex.metal : tex.boom, metalness: 0.3, roughness: 0.6 }));
      shape = new CANNON.Cylinder(0.38, 0.38, 1.1, 12); mass = 30;
      if (kind === 'explosive barrel') extra.explosive = true;
      break;
    }
    case 'ball':
      mesh = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 16), stdMat({ color: '#d84', roughness: 0.5 }));
      shape = new CANNON.Sphere(0.4); mass = 8; material = mat.bouncy; break;
    case 'beach ball':
      mesh = new THREE.Mesh(new THREE.SphereGeometry(0.75, 24, 16), stdMat({ map: tex.beach, roughness: 0.4 }));
      shape = new CANNON.Sphere(0.75); mass = 1; material = mat.bouncy; extra.damp = 0.3; break;
    case 'melon':
      mesh = new THREE.Mesh(new THREE.SphereGeometry(0.28, 20, 14), stdMat({ color: '#3a8a2e', roughness: 0.6 }));
      mesh.scale.set(1, 0.85, 1.25);
      shape = new CANNON.Sphere(0.28); mass = 4; break;
    case 'plank':
      mesh = new THREE.Mesh(new THREE.BoxGeometry(3, 0.15, 0.6), stdMat({ map: tex.wood }));
      shape = new CANNON.Box(new CANNON.Vec3(1.5, 0.075, 0.3)); mass = 15; break;
    case 'wall panel':
      mesh = new THREE.Mesh(new THREE.BoxGeometry(3, 2.4, 0.2), stdMat({ map: tex.wall }));
      shape = new CANNON.Box(new CANNON.Vec3(1.5, 1.2, 0.1)); mass = 90; break;
    case 'ramp':
      mesh = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.25, 4), stdMat({ color: '#556' }));
      shape = new CANNON.Box(new CANNON.Vec3(1.25, 0.125, 2)); mass = 70; extra.tilt = 0.35; break;
    case 'ape statue': {
      if (!apeSource) return null;
      const clone = SkeletonUtils.clone(apeSource);
      clone.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
      const s = 0.45;
      clone.scale.multiplyScalar(s);
      clone.position.multiplyScalar(s);
      clone.position.y -= APE_HEIGHT * s / 2;
      mesh = new THREE.Group(); mesh.add(clone);
      shape = new CANNON.Box(new CANNON.Vec3(0.22, APE_HEIGHT * s / 2, 0.22)); mass = 40; extra.isApe = true; break;
    }
    case 'shelf': case 'speaker': {
      const tpl = propModels[kind];
      if (!tpl) return null;
      mesh = tpl.clone();
      const h = tpl.userData.half;
      shape = new CANNON.Box(new CANNON.Vec3(h.x, h.y, h.z)); mass = kind === 'shelf' ? 70 : 18;
      break;
    }
    default: return null;
  }
  shade(mesh);
  const body = new CANNON.Body({ mass, material, shape, collisionFilterGroup: G_WORLD });
  if (shape instanceof CANNON.Box) addEdgeSpheres(body, shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
  else if (shape instanceof CANNON.Cylinder) addRimSpheres(body, shape.radiusTop, shape.height);
  body.linearDamping = extra.damp ?? 0.05; body.angularDamping = 0.1;
  body.sleepSpeedLimit = 0.15;
  scene.add(mesh);
  world.addBody(body);
  const prop = { kind, mesh, body, frozen: false, explosive: !!extra.explosive, isApe: !!extra.isApe, armed: false, dead: false };
  mesh.traverse(o => o.userData.prop = prop);
  if (prop.explosive) body.addEventListener('collide', e => {
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
    if (v > 9 || (prop.armed && v > 3)) queueExplosion(prop, 0);
  });
  if (extra.tilt) body.quaternion.setFromEuler(extra.tilt, 0, 0);
  props.push(prop); propByBody.set(body, prop);
  return prop;
}
function spawnProp(kind) {
  const p = makeProp(kind); if (!p) return;
  const hit = aimHit(30, true);
  const f = camForward();
  const pos = hit ? hit.point.clone().addScaledVector(hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new V3(0, 1, 0), 0.1)
                  : camera.position.clone().addScaledVector(f, 6);
  p.body.quaternion.mult(new CANNON.Quaternion().setFromEuler(0, player.yaw, 0), p.body.quaternion);
  pos.y += propHalfHeight(p) + 0.05;
  p.body.position.set(pos.x, pos.y, pos.z);
  syncProp(p);
  undoStack.push(p);
  beep(660, 0.06, 'square', 0.04);
  updateCount();
}
// how far the physics shape reaches below the body's centre (the mesh's box is wrong for skinned models like the statue)
function propHalfHeight(p) {
  const b = p.body, y = b.position.y;
  b.position.y = 0; b.aabbNeedsUpdate = true; b.updateAABB();
  const h = -b.aabb.lowerBound.y;
  b.position.y = y; b.aabbNeedsUpdate = true;
  return h;
}
function removeProp(p, puff = true) {
  if (p.dead) return;
  p.dead = true;
  if (tools.grab && tools.grab.prop === p) tools.release();
  world.removeBody(p.body); scene.remove(p.mesh);
  const shared = p.isApe || p.kind === 'shelf' || p.kind === 'speaker';   // geometry shared with a template
  p.mesh.traverse(o => { if (o.isMesh && !shared) { o.geometry.dispose(); } });
  props.splice(props.indexOf(p), 1); propByBody.delete(p.body);
  if (puff) spawnPuff(p.mesh.position, '#ffffff', 0.8);
  updateCount();
}
function syncProp(p) { p.mesh.position.copy(p.body.position); p.mesh.quaternion.copy(p.body.quaternion); }
function setFrozen(p, on) {
  p.frozen = on;
  p.body.type = on ? CANNON.Body.STATIC : CANNON.Body.DYNAMIC;
  p.body.velocity.set(0, 0, 0); p.body.angularVelocity.set(0, 0, 0);
  if (!on) p.body.wakeUp();
  p.mesh.traverse(o => { if (o.isMesh && o.material.emissive) { o.material = o.material.clone(); o.material.emissive.set(on ? '#0a2a44' : '#000000'); } });
}
function updateCount() { $('count').textContent = 'Props: ' + props.length; }

// ---------------------------------------------------------------- explosions & effects
const effects = [];
function spawnPuff(pos, color, size) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }));
  m.position.copy(pos); scene.add(m);
  effects.push({ m, life: 0.4, max: 0.4, grow: 2.5 });
}
const explosionQueue = [];
function queueExplosion(p, delay) { if (!p.dead && !p.queued) { p.queued = true; explosionQueue.push({ p, at: performance.now() + delay * 1000 }); } }
function explode(p) {
  const c = new V3().copy(p.body.position);
  removeProp(p, false);
  const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: '#ffaa33', transparent: true, opacity: 0.9, depthWrite: false }));
  flash.position.copy(c); scene.add(flash);
  const light = new THREE.PointLight('#ffaa55', 60, 25); light.position.copy(c); scene.add(light);
  effects.push({ m: flash, life: 0.5, max: 0.5, grow: 9, light });
  boomSound(0.5);
  const R = 7;
  for (const q of props.slice()) {
    const d = q.body.position.distanceTo(new CANNON.Vec3(c.x, c.y, c.z));
    if (d > R) continue;
    if (q.explosive) { queueExplosion(q, 0.12 + Math.random() * 0.1); continue; }
    if (q.frozen) continue;
    const dir = new CANNON.Vec3(q.body.position.x - c.x, q.body.position.y - c.y + 0.5, q.body.position.z - c.z);
    dir.normalize();
    q.body.wakeUp();
    q.body.applyImpulse(dir.scale(q.body.mass * 22 * (1 - d / R)), new CANNON.Vec3(0, 0, 0));
  }
  const pp = player.body.position, pd = Math.hypot(pp.x - c.x, pp.y + 1 - c.y, pp.z - c.z);
  if (pd < R) {
    const s = 1 - pd / R;
    player.body.velocity.x += (pp.x - c.x) / (pd + 0.01) * 14 * s;
    player.body.velocity.z += (pp.z - c.z) / (pd + 0.01) * 14 * s;
    player.body.velocity.y += 8 * s;
    hurt(Math.round(70 * s));
  }
  for (const kl of killers) kl.blast(c, R);
}
function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i]; e.life -= dt;
    const k = 1 - e.life / e.max;
    e.m.scale.setScalar(1 + k * e.grow);
    e.m.material.opacity = Math.max(0, 0.8 * (1 - k));
    if (e.light) e.light.intensity = 60 * (1 - k);
    if (e.life <= 0) { scene.remove(e.m); if (e.light) scene.remove(e.light); e.m.geometry.dispose(); effects.splice(i, 1); }
  }
  const now = performance.now();
  for (let i = explosionQueue.length - 1; i >= 0; i--)
    if (explosionQueue[i].at <= now) { const { p } = explosionQueue.splice(i, 1)[0]; if (!p.dead) explode(p); }
}

// ---------------------------------------------------------------- aiming
const aimRay = new THREE.Raycaster();
function aimHit(maxDist = 200, includeStatic = false) {
  aimRay.set(camera.position, camForward()); aimRay.far = maxDist;
  const targets = props.map(p => p.mesh);
  if (includeStatic) targets.push(...staticMeshes);
  const hits = aimRay.intersectObjects(targets, true);
  return hits[0] || null;
}
const propOf = hit => hit && hit.object.userData.prop;

// ---------------------------------------------------------------- tools
const beamGeo = new THREE.BufferGeometry().setFromPoints(new Array(24).fill(0).map(() => new V3()));
const beam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color: '#5cf', transparent: true, opacity: 0.9 }));
beam.frustumCulled = false; beam.visible = false; scene.add(beam);
const beamGlow = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: '#9ef' }));
beamGlow.visible = false; scene.add(beamGlow);

const tools = {
  list: ['Physgun', 'Gravity Gun', 'Remover'],
  current: 0,
  grab: null,      // { prop, local: CANNON.Vec3, dist, mode }
  rotating: false,
  holding() { return !!this.grab; },
  select(i) {
    if (i === this.current) return;
    this.release(); this.current = i; beep(520, 0.05, 'square', 0.03); renderTools();
  },
  release(throwVel) {
    if (!this.grab) return;
    if (throwVel) this.grab.prop.body.velocity.copy(throwVel);
    this.grab = null; this.rotating = false;
  },
  mouseDown(button) {
    aimingArm = 0.6;
    const name = this.list[this.current];
    if (name === 'Physgun') {
      if (button === 0) {
        const hit = aimHit(); const p = propOf(hit);
        if (!p) return;
        if (p.frozen) setFrozen(p, false);
        const local = p.body.pointToLocalFrame(new CANNON.Vec3(hit.point.x, hit.point.y, hit.point.z));
        this.grab = { prop: p, local, dist: hit.distance, mode: 'phys' };
        p.body.wakeUp(); beep(300, 0.1, 'sawtooth', 0.03);
      } else if (button === 2 && this.grab) {
        const p = this.grab.prop; this.release(); setFrozen(p, true); toast('Frozen'); beep(900, 0.08, 'sine', 0.05);
      }
    } else if (name === 'Gravity Gun') {
      if (button === 0) {
        if (this.grab) {
          const p = this.grab.prop; this.release(new CANNON.Vec3(...camForward().multiplyScalar(28).toArray()));
          p.armed = true; beep(140, 0.15, 'square', 0.06); return;
        }
        const hit = aimHit(9); const p = propOf(hit);
        if (p && !p.frozen) {
          const f = camForward();
          const rel = new CANNON.Vec3(hit.point.x - p.body.position.x, hit.point.y - p.body.position.y, hit.point.z - p.body.position.z);
          p.body.wakeUp(); p.armed = true;
          p.body.applyImpulse(new CANNON.Vec3(f.x, f.y + 0.15, f.z).scale(Math.min(p.body.mass, 120) * 14), rel);
          beep(140, 0.15, 'square', 0.06);
        } else beep(90, 0.08, 'square', 0.03);
      } else if (button === 2) {
        if (this.grab) { this.release(); return; }
        const hit = aimHit(14); const p = propOf(hit);
        if (p && !p.frozen && p.body.mass <= 150) { this.grab = { prop: p, local: new CANNON.Vec3(), dist: 3.2, mode: 'grav' }; p.body.wakeUp(); beep(400, 0.1, 'triangle', 0.04); }
      }
    } else if (name === 'Remover' && button === 0) {
      const p = propOf(aimHit());
      if (p) { removeProp(p); beep(1200, 0.05, 'sine', 0.05); }
    } else if (name === 'Stick' && button === 0) {
      stick.swing();
    }
  },
  mouseUp(button) { if (button === 0 && this.grab && this.grab.mode === 'phys') this.release(); },
  wheel(dy) { if (this.grab && this.grab.mode === 'phys') this.grab.dist = THREE.MathUtils.clamp(this.grab.dist - dy * 0.01, 1.5, 80); },
  rotate(dx, dy) {
    const b = this.grab.prop.body;
    const r = new V3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    const q = new Q().setFromAxisAngle(new V3(0, 1, 0), dx * 0.006).multiply(new Q().setFromAxisAngle(r, dy * 0.006));
    const cur = new Q(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w).premultiply(q);
    b.quaternion.set(cur.x, cur.y, cur.z, cur.w);
  },
  preStep() {
    if (!this.grab) return;
    const p = this.grab.prop;
    if (p.dead) { this.grab = null; return; }
    const f = camForward();
    const target = camera.position.clone().addScaledVector(f, this.grab.mode === 'grav' ? this.grab.dist + 0.6 : this.grab.dist);
    const wp = p.body.pointToWorldFrame(this.grab.local);
    const k = this.grab.mode === 'grav' ? 9 : 12;
    const v = new V3(target.x - wp.x, target.y - wp.y, target.z - wp.z).multiplyScalar(k);
    if (v.length() > 45) v.setLength(45);
    p.body.velocity.set(v.x, v.y, v.z);
    p.body.angularVelocity.scale(this.rotating || this.grab.mode === 'grav' ? 0.5 : 0.9, p.body.angularVelocity);
    if (this.rotating) p.body.angularVelocity.set(0, 0, 0);
    p.body.wakeUp();
  },
  updateBeam(t) {
    const show = !!this.grab;
    beam.visible = beamGlow.visible = show;
    if (!show || !rig.arms.length) return;
    const handArm = rig.arms.find(a => a.side > 0);
    const start = handArm.fingers[0][2].getWorldPosition(new V3());
    const end = this.grab.prop.body.pointToWorldFrame(this.grab.local);
    const endV = new V3(end.x, end.y, end.z);
    const mid = start.clone().addScaledVector(camForward(), start.distanceTo(endV) * 0.5);
    const curve = new THREE.QuadraticBezierCurve3(start, mid, endV);
    const pos = beamGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const pt = curve.getPoint(i / (pos.count - 1));
      if (i > 0 && i < pos.count - 1) pt.y += Math.sin(t * 30 + i) * 0.02;
      pos.setXYZ(i, pt.x, pt.y, pt.z);
    }
    pos.needsUpdate = true;
    beam.material.color.set(this.grab.mode === 'grav' ? '#fa3' : '#5cf');
    beamGlow.material.color.copy(beam.material.color);
    beamGlow.position.copy(endV);
  },
};
function renderTools() {
  $('tools').innerHTML = tools.list.map((n, i) => `<div class="tool ${i === tools.current ? 'on' : ''}">${i + 1} ${n}</div>`).join('');
}
renderTools();

// ---------------------------------------------------------------- spawn menu
const SPAWNABLES = ['crate', 'small crate', 'big crate', 'barrel', 'explosive barrel', 'ball', 'beach ball', 'melon', 'plank', 'wall panel', 'ramp', 'ape statue', 'shelf', 'speaker'];
$('spawnGrid').innerHTML = SPAWNABLES.map(k => `<button data-k="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('');
$('spawnGrid').addEventListener('click', e => { const k = e.target.dataset.k; if (k) spawnProp(k); });
function openMenu(on) {
  menuOpen = on;
  $('menu').style.display = on ? 'block' : 'none';
  if (unlockedPlay) return;
  if (on) document.exitPointerLock();
  else lockPointer();
}

// ---------------------------------------------------------------- input
const canvas = renderer.domElement;
// Where pointer lock is not allowed (embedded browsers), play unlocked: the mouse still steers the camera.
let unlockedPlay = false;
function lockPointer() {
  if (unlockedPlay) return;
  if (IS_TOUCH) return startUnlocked();     // no mouse to lock: the touch controls steer instead
  try {
    const r = canvas.requestPointerLock();
    if (r && r.catch) r.catch(() => startUnlocked());
  } catch { startUnlocked(); }
}
function startUnlocked() {
  unlockedPlay = locked = true;
  $('start').style.display = 'none';
  if (!IS_TOUCH && !vr.on) toast('Pointer lock unavailable: mouse look follows the cursor');
}
canvas.addEventListener('click', () => { if (!locked && !menuOpen) lockPointer(); });
$('start').addEventListener('click', lockPointer);
document.addEventListener('pointerlockchange', () => {
  if (unlockedPlay) return;
  locked = document.pointerLockElement === canvas;
  $('start').style.display = (!locked && !menuOpen && ready) ? 'flex' : 'none';
});
document.addEventListener('mousemove', e => {
  if (!locked || menuOpen) return;
  if (tools.rotating && tools.grab) { tools.rotate(e.movementX, e.movementY); return; }
  player.yaw -= e.movementX * 0.0022;
  player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY * 0.0022, -1.45, 1.45);
});
addEventListener('mousedown', e => { if (locked && !menuOpen && !player.dead && e.target === canvas) { audio(); tools.mouseDown(e.button); } });
addEventListener('mouseup', e => { if (locked) tools.mouseUp(e.button); });
addEventListener('wheel', e => { if (locked) tools.wheel(e.deltaY); }, { passive: true });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') {             // typing a name on the computer: no game keys
    if (e.code === 'Enter' && e.target.id === 'pcName') computer.setName();
    if (e.code === 'Enter' && e.target.id === 'netCode') net.joinFromPanel();
    if (e.code === 'Escape') { computer.close(); if (soundPanel.open) soundPanel.show(false); if (net.panelOpen) net.openPanel(false); }
    if (e.code === 'KeyP' && soundPanel.open) soundPanel.show(false);
    return;
  }
  if (e.repeat) { keys[e.code] = true; return; }
  keys[e.code] = true;
  if (e.code === 'KeyQ' && !menuOpen && ready) openMenu(true);
  if (e.code === 'KeyV') {
    if (killers.some(kl => kl.state === 'killing')) { killThird = !killThird; toast(killThird ? 'Watching the kill in third person' : 'Back in your eyes'); }
    else player.thirdPerson = !player.thirdPerson;
  }
  if ((e.code === 'KeyK' || e.code === 'KeyB') && net.client && ready) { net.send({ t: 'cmd', c: e.code }); toast('Asked the host'); }
  else if (e.code === 'KeyK') { const on = director.toggle(); toast(on ? 'The killers are coming back' : 'Killers gone'); }
  else if (e.code === 'KeyB' && ready) bloodMoon.toggle();
  if (e.code === 'KeyO' && ready && !shop.open && !computer.open) net.openPanel(true);
  if (e.code === 'KeyP' && ready && !shop.open && !computer.open && !net.panelOpen) soundPanel.show(!soundPanel.open);
  if (e.code === 'KeyH') $('hint').style.display = $('hint').style.display === 'none' ? '' : 'none';
  if (e.code.startsWith('Digit')) { const i = +e.code.slice(5) - 1; if (i >= 0 && i < tools.list.length) tools.select(i); }
  if (e.code === 'KeyE' && tools.grab && tools.grab.mode === 'phys') tools.rotating = true;
  else if (e.code === 'KeyE' && !menuOpen && !player.dead) { if (computer.near()) computer.openPanel(); else shop.talk(); }
  if (e.code === 'Escape' && shop.open) shop.close();
  if (e.code === 'Escape' && net.panelOpen) net.openPanel(false);
  if (e.code === 'Escape' && soundPanel.open) soundPanel.show(false);
  if (e.code === 'Escape' && computer.open) computer.close();
  if (e.code === 'KeyR') { const p = propOf(aimHit()); if (p && p.frozen) { setFrozen(p, false); toast('Unfrozen'); } }
  if (e.code === 'KeyZ') {
    let p; while ((p = undoStack.pop()) && p.dead);
    if (p) { removeProp(p); toast('Undone ' + p.kind); }
  }
  if (e.code === 'KeyC') { ragdolls.clear(); for (const p of props.slice()) removeProp(p, false); undoStack.length = 0; toast('Cleaned up'); }
});
addEventListener('keyup', e => {
  keys[e.code] = false;
  if (e.code === 'KeyQ' && menuOpen && !shop.open) openMenu(false);
  if (e.code === 'KeyE') tools.rotating = false;
});
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// ---------------------------------------------------------------- controller (Xbox / any gamepad)
// Left stick moves, right stick looks. Buttons press the same keys the keyboard would, so everything else just works.
// In menus the D-pad / left stick picks a button, A presses it and B backs out.
const PAD_KEYS = { 0: 'Space', 2: 'KeyE', 4: 'ShiftLeft', 8: 'KeyV', 9: 'KeyH', 11: 'KeyK', 14: 'KeyZ', 15: 'KeyR' };
const pad = {
  move: new THREE.Vector2(), prev: [], focus: 0, navT: 0, wheelT: 0,
  key(code, down) { dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code })); },
  // Xbox Edge drives a mouse cursor with the controller until the page asks for the real gamepad
  takeOver() { if ('gamepadInputEmulation' in navigator) navigator.gamepadInputEmulation = 'gamepad'; },
  menuButtons() {
    const box = ['pcPanel', 'dialog', 'menu'].map($).find(el => el.style.display === 'block');
    return box ? [...box.querySelectorAll('button:not(:disabled), input')].filter(el => el.offsetParent) : [];
  },
  closeMenu() {
    if (computer.open) computer.close(); else if (shop.open) shop.close(); else if (menuOpen) openMenu(false);
  },
  update(dt) {
    const gp = [...(navigator.getGamepads?.() || [])].find(g => g && g.connected);
    this.move.set(0, 0);
    if (!gp) return;
    const dz = v => Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82;
    const btn = i => !!gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.4);
    const pressed = i => btn(i) && !this.prev[i];
    const released = i => !btn(i) && this.prev[i];
    const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0), rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
    if (gp.buttons.some(b => b.pressed)) { footsteps.unlock(); if ($('start').style.display === 'flex') $('start').click(); }

    if (menuOpen) {
      // pick a button with the D-pad or stick, A presses it, B closes, Y also closes the spawn menu
      const list = this.menuButtons();
      this.navT -= dt;
      const step = (btn(13) || btn(15) || ly > 0.5 || lx > 0.5) ? 1 : (btn(12) || btn(14) || ly < -0.5 || lx < -0.5) ? -1 : 0;
      if (!step) this.navT = 0;
      else if (this.navT <= 0 && list.length) { this.focus = (this.focus + step + list.length) % list.length; this.navT = 0.22; }
      if (list.length) { this.focus = Math.min(this.focus, list.length - 1); if (document.activeElement !== list[this.focus]) list[this.focus].focus(); }
      if (pressed(0) && list[this.focus]) list[this.focus].click();
      if (pressed(1) || (pressed(3) && !shop.open && !computer.open)) this.closeMenu();
    } else {
      this.focus = 0;
      this.move.set(lx, -ly);
      // look (or turn a held prop while X is down)
      if (tools.rotating && tools.grab) tools.rotate(rx * 600 * dt, ry * 600 * dt);
      else {
        player.yaw -= rx * 3.2 * dt;
        player.pitch = THREE.MathUtils.clamp(player.pitch - ry * 2.4 * dt, -1.45, 1.45);
      }
      for (const i in PAD_KEYS) { if (pressed(i)) this.key(PAD_KEYS[i], true); else if (released(i)) this.key(PAD_KEYS[i], false); }
      if (pressed(3) && ready) openMenu(true);                                   // Y: spawn menu
      if (pressed(7) && !player.dead) { audio(); tools.mouseDown(0); }          // RT: use tool
      if (released(7)) tools.mouseUp(0);
      if (pressed(6) && !player.dead) tools.mouseDown(2);                       // LT: freeze
      if (released(6)) tools.mouseUp(2);
      if (pressed(5)) tools.select((tools.current + 1) % tools.list.length);    // RB: next tool
      this.wheelT -= dt;                                                        // D-pad up/down: push / pull a held prop
      if ((btn(12) || btn(13)) && this.wheelT <= 0) { tools.wheel(btn(12) ? -100 : 100); this.wheelT = 0.05; }
    }
    // never leave a key stuck down when a menu opens mid-press
    if (menuOpen) for (const i in PAD_KEYS) if (this.prev[i]) keys[PAD_KEYS[i]] = false;
    this.prev = gp.buttons.map((b, i) => btn(i));
  },
};
addEventListener('gamepadconnected', () => toast('Controller connected'));
$('start').addEventListener('click', () => pad.takeOver());

// ---------------------------------------------------------------- phone / tablet (touch)
// A stick on the left moves, dragging anywhere else looks, and buttons on the right do the rest.
// The buttons press the same keys / tool clicks as the keyboard and mouse.
const touch = {
  on: IS_TOUCH, move: new THREE.Vector2(), run: false,
  stickId: null, stickC: { x: 0, y: 0 }, lookId: null, lookAt: { x: 0, y: 0 },
  build() {
    if (!this.on) return;
    document.body.classList.add('touch');
    const ui = document.createElement('div'); ui.id = 'touchUI'; document.body.appendChild(ui);
    ui.innerHTML = `<div id="tStick"><div id="tKnob"></div></div>` +
      [['tUse', 'USE'], ['tJump', 'JUMP'], ['tFreeze', 'FREEZE'], ['tRun', 'RUN'], ['tTool', 'TOOL'], ['tTalk', 'E'], ['tMenu', 'MENU'], ['tView', 'VIEW']]
        .map(([id, t]) => `<button id="${id}" class="tBtn">${t}</button>`).join('');
    const stick = $('tStick'), knob = $('tKnob');
    stick.addEventListener('pointerdown', e => {
      this.stickId = e.pointerId;
      try { stick.setPointerCapture(e.pointerId); } catch {}     // keep the stick if the finger slides off it
      const r = stick.getBoundingClientRect(); this.stickC = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      this.stickMove(e, knob); footsteps.unlock(); audio();
    });
    stick.addEventListener('pointermove', e => { if (e.pointerId === this.stickId) this.stickMove(e, knob); });
    const stickUp = e => { if (e.pointerId !== this.stickId) return; this.stickId = null; this.move.set(0, 0); knob.style.transform = ''; };
    stick.addEventListener('pointerup', stickUp); stick.addEventListener('pointercancel', stickUp);
    // look: drag on the game view
    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || this.lookId !== null) return;
      e.preventDefault();     // no fake mouse click: a drag to look must not fire the tool
      this.lookId = e.pointerId; this.lookAt = { x: e.clientX, y: e.clientY };
    });
    addEventListener('pointermove', e => {
      if (e.pointerId !== this.lookId || menuOpen) return;
      const dx = e.clientX - this.lookAt.x, dy = e.clientY - this.lookAt.y;
      this.lookAt = { x: e.clientX, y: e.clientY };
      if (tools.rotating && tools.grab) { tools.rotate(dx * 2, dy * 2); return; }
      player.yaw -= dx * 0.006;
      player.pitch = THREE.MathUtils.clamp(player.pitch - dy * 0.006, -1.45, 1.45);
    });
    const lookUp = e => { if (e.pointerId === this.lookId) this.lookId = null; };
    addEventListener('pointerup', lookUp); addEventListener('pointercancel', lookUp);
    // buttons: held ones press while the finger is down
    const hold = (id, down, up) => {
      const b = $(id);
      b.addEventListener('pointerdown', e => { e.preventDefault(); b.classList.add('on'); footsteps.unlock(); audio(); down(); });
      const off = () => { b.classList.remove('on'); up && up(); };
      b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
    };
    hold('tUse', () => { if (!player.dead && !menuOpen) tools.mouseDown(0); }, () => tools.mouseUp(0));
    hold('tFreeze', () => { if (!player.dead && !menuOpen) tools.mouseDown(2); });
    hold('tJump', () => pad.key('Space', true), () => pad.key('Space', false));
    hold('tRun', () => { this.run = !this.run; $('tRun').classList.toggle('lit', this.run); });
    hold('tTool', () => tools.select((tools.current + 1) % tools.list.length));
    hold('tTalk', () => pad.key('KeyE', true), () => pad.key('KeyE', false));
    hold('tMenu', () => { if (pad.menuButtons().length && !menuOpen) pad.closeMenu(); else if (ready) openMenu(!menuOpen); });
    hold('tView', () => pad.key('KeyV', true), () => pad.key('KeyV', false));
  },
  stickMove(e, knob) {
    let dx = e.clientX - this.stickC.x, dy = e.clientY - this.stickC.y;
    const R = 55, L = Math.hypot(dx, dy);
    if (L > R) { dx *= R / L; dy *= R / L; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    this.move.set(dx / R, -dy / R);
  },
};
touch.build();

// ---------------------------------------------------------------- VR (WebXR headsets: Quest, PC VR)
// Your head is the ape's head. Left stick walks (left trigger runs), right stick turns in steps, right trigger uses
// the tool you hold, right grip freezes / grabs, A jumps, B changes tool, X spawns a prop, Y spawns the next kind.
const vr = {
  on: false, yaw: 0, move: new THREE.Vector2(), head: new V3(0, 1.6, 0), turnReady: true, prev: {}, spawnI: 0,
  init() {
    if (!navigator.xr) return;
    navigator.xr.isSessionSupported('immersive-vr').then(ok => {
      if (!ok) return;
      const b = VRButton.createButton(renderer);
      b.id = 'vrButton';
      document.body.appendChild(b);
    }).catch(() => {});
    renderer.xr.addEventListener('sessionstart', () => {
      this.on = true; this.yaw = player.yaw; player.thirdPerson = false;
      footsteps.unlock(); audio();
      if (!locked) startUnlocked();
      toast('VR: left stick walk, right stick turn, right trigger use, A jump');
    });
    renderer.xr.addEventListener('sessionend', () => {
      this.on = false; this.move.set(0, 0); keys.ShiftLeft = false;
      xrRig.position.set(0, 0, 0); xrRig.rotation.set(0, 0, 0); xrRig.updateMatrixWorld(true);
    });
  },
  // controller buttons and sticks
  input(dt) {
    this.move.set(0, 0);
    const session = this.on && renderer.xr.getSession();
    if (!session) return;
    const dz = v => Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85;
    for (const src of session.inputSources) {
      const gp = src.gamepad; if (!gp) continue;
      const h = src.handedness, prev = this.prev[h] || [];
      const btn = i => !!gp.buttons[i] && gp.buttons[i].pressed;
      const pressed = i => btn(i) && !prev[i], released = i => !btn(i) && prev[i];
      const ax = dz(gp.axes[2] || 0), ay = dz(gp.axes[3] || 0);
      if (h === 'left') {
        this.move.set(ax, -ay);
        keys.ShiftLeft = btn(0);                                                // trigger: run
        if (pressed(4)) spawnProp(SPAWNABLES[this.spawnI]);                     // X: spawn
        if (pressed(5)) { this.spawnI = (this.spawnI + 1) % SPAWNABLES.length; toast('Spawn: ' + SPAWNABLES[this.spawnI]); }   // Y: next kind
      } else if (h === 'right') {
        if (Math.abs(ax) > 0.7 && this.turnReady) { this.yaw -= Math.sign(ax) * Math.PI / 6; this.turnReady = false; }
        if (Math.abs(ax) < 0.3) this.turnReady = true;
        if (pressed(0) && !player.dead) tools.mouseDown(0);                     // trigger: use the tool
        if (released(0)) tools.mouseUp(0);
        if (pressed(1) && !player.dead) tools.mouseDown(2);                     // grip: freeze / grab
        if (pressed(4)) pad.key('Space', true); if (released(4)) pad.key('Space', false);   // A: jump
        if (pressed(5)) tools.select((tools.current + 1) % tools.list.length); // B: next tool
      }
      this.prev[h] = gp.buttons.map(b => b.pressed);
    }
  },
  // put the rig where the game wants your eyes (or where a kill camera is), turned by the right stick
  preRender() {
    if (!this.on) return;
    let yaw = this.yaw;
    if (killers.some(kl => kl.state === 'killing')) {
      const f = _v1.set(0, 0, -1).applyQuaternion(camera.quaternion);
      yaw = Math.atan2(-f.x, -f.z);
    }
    xrRig.rotation.set(0, yaw, 0);
    xrRig.position.copy(camera.position).sub(_v2.copy(this.head).applyAxisAngle(_v3.set(0, 1, 0), yaw));
    xrRig.updateMatrixWorld(true);
  },
  // after drawing, the camera holds the headset's pose inside the rig: turn it back into a world pose for the game
  postRender() {
    if (!this.on) return;
    this.head.copy(camera.position);
    camera.position.applyMatrix4(xrRig.matrixWorld);
    camera.quaternion.premultiply(xrRig.quaternion);
    xrRig.position.set(0, 0, 0); xrRig.rotation.set(0, 0, 0); xrRig.updateMatrixWorld(true);
    if (!killers.some(kl => kl.state === 'killing')) {
      // you look (and aim, and walk) where your head points
      const f = _v1.set(0, 0, -1).applyQuaternion(camera.quaternion);
      player.yaw = Math.atan2(-f.x, -f.z);
      player.pitch = Math.asin(THREE.MathUtils.clamp(f.y, -1, 1));
    }
  },
};
vr.init();

// ---------------------------------------------------------------- killers (NPCs that hunt the player)
const KILL_SCALE = 1.35;            // saw runner kill scene: its victim ape ~= our ape's size at this scale
function skinnedBounds(obj) {
  obj.updateMatrixWorld(true);
  obj.traverse(o => { if (o.isSkinnedMesh) o.skeleton.update(); });
  return new THREE.Box3().setFromObject(obj, true);
}
const _gltf = new GLTFLoader();
function prepMeshes(root) { root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } }); }
function onceActions(mixer, clips) {
  return clips.map(c => { const a = mixer.clipAction(c); a.setLoop(THREE.LoopOnce); a.clampWhenFinished = true; return a; });
}

// V during a kill: watch it from outside. The camera orbits (mouse / right stick) the middle of the action,
// between the victim's eyes and the killer. Stays on for later kills until V is pressed again.
let killThird = false;
const killCam = { c: new V3(), last: 0 };
function killCameraThird(kl, dt) {
  const k = kl.kill, now = performance.now();
  if (k?.head) { k.head.scale.setScalar(1); k.head.updateMatrixWorld(true); }   // first-person kills hide the victim's head
  const b = kl.body.position;
  const target = camera.position.clone().lerp(_v1.set(b.x, b.y + 1.2, b.z), 0.5);
  if (now - killCam.last > 500) killCam.c.copy(target);                         // a new kill: jump straight there
  else killCam.c.lerp(target, 1 - Math.exp(-5 * dt));
  killCam.last = now;
  const dir = camForward();
  camRay.set(killCam.c, dir.clone().negate()); camRay.far = 4.5;
  const hit = camRay.intersectObjects(staticMeshes, false)[0];
  camera.position.copy(killCam.c).addScaledVector(dir, -(hit ? Math.max(0.4, hit.distance - 0.3) : 4.5));
  camera.up.set(0, 1, 0);
  camera.rotation.set(player.pitch, player.yaw, 0);
  if (camera.fov !== 75) { camera.fov = 75; camera.updateProjectionMatrix(); }
}

// Shared chase / stun / kill logic. Each killer definition supplies load(), moveAnim(), killCamera().
function makeKiller(def) {
  return Object.assign({
    enabled: true, ready: false, state: 'cooldown', timer: 3,
    holder: new THREE.Group(), mixer: null, actions: {}, current: null,
    body: null, stuckT: 0, sideT: 0, sideDir: 1, yaw: 0,
    kill: null, alerted: false, cuesFired: new Set(),
    walkSpeed: 3.2, chaseSpeed: 7.6, accel: 8, killRange: 1.6, bodySpheres: [[0.5, 0.5], [0.5, 1.4]], eyeHeight: 1.8,
    seeRange: 24,      // spots you this far away (in metres, with a clear line of sight); loses you 21 m further out
    killCues: [],
    sounds: Object.fromEntries(Object.entries(def.soundFiles).map(([k, f]) => [k, new Audio(f)])),

    playSound(name, volume = 1) {
      const s = this.sounds[name];
      if (!s) return;
      s.baseVol = THREE.MathUtils.clamp(volume, 0, 1);
      s.volume = Math.min(1, s.baseVol * htmlVol());
      s.currentTime = 0;
      s.play().catch(() => {});
    },
    stopSound(name, fadeSec = 0) {
      const s = this.sounds[name];
      if (!s) return;
      if (!fadeSec) return s.pause();
      const v0 = s.volume, t0 = performance.now();
      const step = () => {
        const k = (performance.now() - t0) / (fadeSec * 1000);
        if (k >= 1) { s.pause(); s.volume = v0; return; }
        s.volume = v0 * (1 - k); requestAnimationFrame(step);
      };
      step();
    },
    canSee(at = apeRoot.position) {
      const b = this.body.position;
      const eye = _v2.set(b.x, b.y + this.eyeHeight, b.z), to = _v3.set(at.x, at.y + 1.2, at.z);
      const d = eye.distanceTo(to);
      camRay.set(eye, to.sub(eye).normalize()); camRay.far = d;
      return camRay.intersectObjects(staticMeshes, false).length === 0;
    },
    makeBody() {
      const b = this.body = new CANNON.Body({ mass: 150, material: mat.player, fixedRotation: true, collisionFilterGroup: G_WORLD });
      for (const [r, y] of this.bodySpheres) b.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, y, 0));
      b.allowSleep = false;
      b.addEventListener('collide', e => {
        const q = propByBody.get(e.body);
        if (q && q.kind === 'shelf' && this.state !== 'killing') this.shove(q);
        if (e.body === player.body || this.state !== 'chase') return;
        const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
        // a very fast killer's own speed doesn't count: running into a prop shouldn't stun it
        const hit = this.chaseSpeed > 10 ? v - Math.hypot(this.body.velocity.x, this.body.velocity.z) : v;
        if (e.body.mass > 3 && hit > 7) this.stun(1.5 + Math.min(2, hit / 10));
      });
      world.addBody(b);
      this.place();
      this.ready = true;
    },
    play(name, timeScale = 1) {
      const a = this.actions[name];
      if (!a) return;
      a.timeScale = timeScale;
      if (this.current === a) return;
      a.reset().play();
      if (this.current) a.crossFadeFrom(this.current, 0.25, false);
      this.current = a;
    },
    place() {
      // about 53 m out from the player (widening the ring if nothing walkable is there)
      const p = player.body.position;
      let nd = null;
      for (let extra = 0; !nd && extra <= 30; extra += 6) {
        const ring = nav.nodes.filter(n => { const d = Math.hypot(n.x - p.x, n.z - p.z); return d >= 53 && d <= 57 + extra && Math.hypot(n.x - SPAWN.x, n.z - SPAWN.z) > 30; });
        if (ring.length) nd = ring[Math.floor(Math.random() * ring.length)];
      }
      nd = nd || (nav.nodes.length ? nav.random() : { x: 60, y: 1, z: 60 });
      this.body.position.set(nd.x, nd.y + 0.2, nd.z); this.body.velocity.set(0, 0, 0);
      this.alerted = false; this.path = null; this.wanderTo = null;
    },
    // knock a shelf out of the way (works on frozen shelves too)
    shove(q) {
      const now = performance.now();
      if (q.shovedAt && now - q.shovedAt < 600) return;
      q.shovedAt = now;
      const v = this.body.velocity;
      let dx = v.x, dz = v.z, L = Math.hypot(dx, dz);
      if (L < 0.5) { dx = Math.sin(this.yaw); dz = Math.cos(this.yaw); L = 1; }
      if (q.frozen) setFrozen(q, false);
      q.body.wakeUp();
      q.body.applyImpulse(new CANNON.Vec3(dx / L * q.body.mass * 5, q.body.mass * 1.5, dz / L * q.body.mass * 5), new CANNON.Vec3(0, 0.8, 0));
      noiseBurst(0.25, 900, 'bandpass', 0.35); beep(120, 0.2, 'square', 0.06);
    },
    // which way to walk to reach a point: straight at it if it's close and in sight, otherwise along the walk graph
    steer(target, dt, direct) {
      const b = this.body.position, here = new V3(b.x, b.y, b.z);
      const dir = new V3(target.x - b.x, 0, target.z - b.z);
      if (direct || !nav.nodes.length) return dir.normalize();
      this.pathT = (this.pathT ?? 0) - dt;
      if (!this.path || this.pathT <= 0) { this.path = nav.path(here, target); this.pathI = 0; this.pathT = 0.5; }
      const path = this.path;
      if (!path || !path.length) return dir.normalize();
      while (this.pathI < path.length - 1 && Math.hypot(path[this.pathI].x - b.x, path[this.pathI].z - b.z) < 0.9) this.pathI++;
      // look a few nodes ahead and cut corners where nothing is in the way
      let wp = path[this.pathI];
      for (let k = Math.min(path.length - 1, this.pathI + 5); k > this.pathI; k--) {
        const c = path[k], o = new V3(b.x, Math.max(b.y, c.y) + 0.8, b.z), d = new V3(c.x - b.x, 0, c.z - b.z), L = d.length();
        camRay.set(o, d.normalize()); camRay.far = L;
        if (!camRay.intersectObjects(staticMeshes, false).length) { wp = c; this.pathI = k; break; }
      }
      if (wp.y - b.y > 0.45 && Math.abs(this.body.velocity.y) < 0.3 && Math.hypot(wp.x - b.x, wp.z - b.z) < 1.6) this.body.velocity.y = 7;   // ledge
      return dir.set(wp.x - b.x, 0, wp.z - b.z).normalize();
    },
    stun(t) {
      this.state = 'stunned'; this.timer = Math.max(this.timer, t);
      if (this.current) this.current.timeScale = 0.15;
      toast(this.name + ' stunned!');
    },
    blast(c, R) {
      if (!this.ready || !this.enabled || this.state === 'killing') return;
      const b = this.body.position, d = Math.hypot(b.x - c.x, b.y + 1 - c.y, b.z - c.z);
      if (d > R) return;
      const s = 1 - d / R;
      this.body.velocity.x += (b.x - c.x) / (d + 0.01) * 16 * s;
      this.body.velocity.z += (b.z - c.z) / (d + 0.01) * 16 * s;
      this.body.velocity.y += 9 * s;
      this.stun(2 + 3 * s);
    },
    setEnabled(on) {
      this.enabled = on;
      if (!this.ready) return;
      if (on) { world.addBody(this.body); this.place(); this.state = 'cooldown'; this.timer = 3; }
      else world.removeBody(this.body);
      this.holder.visible = on;
    },

    update(dt) {
      if (!this.ready) return;
      this.updateBuzz?.();
      if (this.state === 'killing') return this.updateKill(dt);
      if (net.client) return this.netUpdate(dt);      // online and not the host: the host's killers, copied
      if (this.state === 'remote') return this.updateRemoteKill(dt);
      if (!this.enabled) return;
      // online host: go for the closest player who can be reached (you or someone who joined)
      const T = net.host ? net.pickTarget(this.body.position) : null;
      const b = this.body, p = T ? T.p : player.body.position;
      this.mixer.update(dt);
      this.timer -= dt;
      const dx = p.x - b.position.x, dz = p.z - b.position.z, dist = Math.hypot(dx, dz);
      let speed = 0, dir = new V3();

      if (this.state === 'stunned') {
        if (this.timer <= 0) this.state = 'chase';
      } else if (this.state === 'cooldown') {
        speed = 1.5; dir.copy(this.steer(p, dt, false)); this.moveAnim(speed);
        if (this.timer <= 0) this.state = 'chase';
      } else {
        const canReach = T ? T.reach : !player.dead && !shop.isSafe();
        if (canReach) {
          // it spots you: sound, then sprint
          const sees = dist < this.seeRange && this.canSee(p);
          if (!this.alerted && (sees || this.alwaysKnows)) {
            this.alerted = true;
            this.playSound('spotted', Math.max(0.2, 1 - dist / 40));   // still heard when it spots you from far off
            this.onSpot?.();
          } else if (this.alerted && dist > this.seeRange + 21 && !this.alwaysKnows) this.alerted = false;
          speed = (this.alerted ? this.chaseSpeed : this.walkSpeed) * director.speedK;   // a bit faster deep in
          dir.copy(this.steer(p, dt, sees && dist < 7 && Math.abs(p.y - b.position.y) < 1));
        } else {
          // can't get you: roam the building
          if (!this.wanderTo || Math.hypot(this.wanderTo.x - b.position.x, this.wanderTo.z - b.position.z) < 2 || (this.wanderT = (this.wanderT ?? 0) - dt) < 0) {
            this.wanderTo = nav.nodes.length ? nav.random().p : new V3(0, 0, 0); this.wanderT = 15; this.path = null;
          }
          speed = 2; dir.copy(this.steer(this.wanderTo, dt, false));
        }
        // crude obstacle handling: if not getting anywhere, sidestep and hop
        const actual = Math.hypot(b.velocity.x, b.velocity.z);
        this.stuckT = actual < Math.min(speed * 0.35, 2.7) ? this.stuckT + dt : 0;
        if (this.stuckT > 0.7) {
          this.sideT = 1.2; this.sideDir = Math.random() < 0.5 ? -1 : 1; this.stuckT = 0;
          if (Math.abs(b.velocity.y) < 0.2) b.velocity.y = 6.5;
        }
        if (this.sideT > 0) { this.sideT -= dt; dir.applyAxisAngle(new V3(0, 1, 0), this.sideDir * Math.PI / 2.2); }
        this.moveAnim(speed);
        if (canReach && dist < this.killRange && Math.abs(p.y - b.position.y) < 1.8) return T && !T.local ? this.startRemoteKill(T.id) : this.startKill();
      }

      if (this.holdT > 0) { this.holdT -= dt; speed = 0; }   // e.g. stopping to roar
      this.netSpeed = speed;
      const k = 1 - Math.exp(-this.accel * dt);
      b.velocity.x += (dir.x * speed - b.velocity.x) * k;
      b.velocity.z += (dir.z * speed - b.velocity.z) * k;
      if (speed > 0.1 || this.holdT > 0) {
        const want = this.holdT > 0 ? Math.atan2(dx, dz) : Math.atan2(dir.x, dir.z);
        let d = want - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
        this.yaw += d * Math.min(1, dt * 8);
      }
      if (b.position.y < FALL_Y) this.place();
      this.holder.position.set(b.position.x, b.position.y, b.position.z);
      this.holder.rotation.y = this.yaw;   // all killer models face +Z
      this.animate?.(dt, Math.hypot(b.velocity.x, b.velocity.z));
    },

    // online host: a killer reached someone who joined. They watch the kill on their screen; here it stands still, hidden, until it's over
    startRemoteKill(id) {
      this.state = 'remote'; this.timer = (this.kill?.duration ?? 3) + 1;
      this.body.velocity.set(0, 0, 0); this.holder.visible = false; this.netSpeed = 0;
      this.stopSound('spotted');
      net.killed(id, this);
    },
    updateRemoteKill(dt) {
      this.body.velocity.x = this.body.velocity.z = 0;
      if ((this.timer -= dt) > 0) return;
      this.holder.visible = this.enabled; this.place(); this.state = 'cooldown'; this.timer = 4;
    },
    // online, not the host: stand where the host's copy is, play its walk and its sounds
    netUpdate(dt) {
      const s = this.netS;
      if (!s) return;
      if (!!s.en !== this.enabled) this.setEnabled(!!s.en);
      if (!this.enabled) return;
      const b = this.body, k = 1 - Math.exp(-12 * dt);
      b.position.x += (s.x - b.position.x) * k; b.position.z += (s.z - b.position.z) * k;
      if (Math.abs(s.y - b.position.y) > 3) b.position.y = s.y; else b.position.y += (s.y - b.position.y) * k;
      b.velocity.set(s.vx, 0, s.vz);
      let d = s.yaw - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); this.yaw += d * k;
      this.state = s.st;
      if (s.al && !this.alerted) {
        const p = player.body.position;
        this.playSound('spotted', Math.max(0.2, 1 - Math.hypot(p.x - b.position.x, p.z - b.position.z) / 40));
        this.onSpot?.();
      }
      this.alerted = !!s.al;
      this.mixer.update(dt);
      this.moveAnim(s.sp);
      if (this.state === 'stunned' && this.current) this.current.timeScale = 0.15;
      this.holder.position.set(b.position.x, b.position.y, b.position.z);
      this.holder.rotation.y = this.yaw;
      this.animate?.(dt, Math.hypot(s.vx, s.vz));
      this.holder.visible = !!s.vis;
    },

    startKill() {
      const k = this.kill, b = this.body, p = player.body.position;
      this.state = 'killing';
      player.dead = true; tools.release();
      b.velocity.set(0, 0, 0);
      this.holder.visible = false; apeRoot.visible = false;
      $('crosshair').style.display = 'none';
      // line the kill scene up: its killer->victim direction becomes killer->player, victim spot on the player
      const yaw = Math.atan2(p.x - b.position.x, p.z - b.position.z) - Math.atan2(k.dir0.x, k.dir0.z);
      k.root.scale.setScalar(k.scale);
      k.root.rotation.set(0, yaw, 0);
      const v = k.victim0.clone().multiplyScalar(k.scale).applyAxisAngle(new V3(0, 1, 0), yaw);
      k.root.position.set(p.x - v.x, p.y, p.z - v.z);
      k.actions.forEach(a => a.reset().play());
      k.mixer.setTime(0);
      k.root.visible = true;
      if (this.ragdoll) ragdolls.startKill();   // kills with no victim in them: your own ape is the victim, as a ragdoll
      k.root.updateMatrixWorld(true);
      this.timer = k.duration + 1.0;
      this.cuesFired.clear();
      this.stopSound('spotted');
      this.onKillStart?.();
    },
    updateKill(dt) {
      const k = this.kill;
      k.mixer.update(dt);
      k.root.updateMatrixWorld(true);
      this.killCamera(dt);
      ragdolls.pin(camera.position, camera.quaternion, !killThird);
      if (killThird) killCameraThird(this, dt);
      const t = k.duration + 1.0 - this.timer;
      for (const cue of this.killCues)
        if (!this.cuesFired.has(cue) && t >= cue.t) {
          this.cuesFired.add(cue);
          if (cue.run) cue.run(this);
          else if (cue.stop) this.stopSound(cue.stop, 0.12); else this.playSound(cue.sound, cue.volume ?? 1);
        }
      this.timer -= dt;
      $('death').style.opacity = THREE.MathUtils.clamp(1.6 - this.timer, 0, 1);
      if (this.timer <= 0) this.endKill();
    },
    endKill() {
      if (this.ragdoll) ragdolls.endKill();   // your body stays behind
      this.kill.root.visible = false;
      this.kill.actions.forEach(a => a.stop());
      apeRoot.visible = true; this.holder.visible = this.enabled;
      camera.fov = 75; camera.up.set(0, 1, 0); camera.updateProjectionMatrix();
      $('crosshair').style.display = '';
      this.onKillEnd?.();
      player.dead = false; respawn();
      // the hunt starts over: this one goes too (the director brings them back one at a time)
      if (!net.client && !this.eventOnly) { this.state = 'cooldown'; this.setEnabled(false); }
      for (const name in this.sounds) if (name !== 'spotted') this.stopSound(name, 1.5);
      // everyone backs off after a kill
      for (const kl of killers) if (kl.ready && kl.enabled) { kl.place(); kl.state = 'cooldown'; kl.timer = 4; }
      setTimeout(() => $('death').style.opacity = 0, 300);
    },
  }, def);
}

// ---- 1. Saw Runner: Walk/Run animations, kill scene with a camera in the victim's head
const sawRunner = makeKiller({
  name: 'Saw Runner',
  seeRange: 60,
  soundFiles: { spotted: 'assets/sounds/spotted.mp3', kill: 'assets/sounds/kill.mp3' },
  buzz: null,
  async load() {
    const [run, kill] = await Promise.all([_gltf.loadAsync('assets/sawrunner/scene.gltf'), _gltf.loadAsync('assets/kill/kill.glb')]);

    const tl = new THREE.TextureLoader();
    const kt = f => { const t = tl.load('assets/kill/' + f); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; return t; };
    const killTex = { SawRunner: kt('IMG_2366.png'), Fesh: kt('IMG_2365.png'), Saw: kt('IMG_2367.png'), DEAD_APE_1: kt('IMG_3033.png') };
    prepMeshes(kill.scene);
    kill.scene.traverse(o => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        const t = killTex[m.name];
        if (t) { m.map = t; m.color.set('#ffffff'); m.needsUpdate = true; }
      }
    });
    const root = new THREE.Group(); root.add(kill.scene); root.visible = false; scene.add(root);
    const mixer = new THREE.AnimationMixer(kill.scene);
    const actions = onceActions(mixer, kill.animations);
    const cam = kill.cameras[0];
    const head = kill.scene.getObjectByName('head_1');
    actions.forEach(a => a.play()); mixer.setTime(0);
    kill.scene.updateMatrixWorld(true);
    const killerMesh = kill.scene.getObjectByName('LAR_Ape_LOD0');
    const victim0 = cam.getWorldPosition(new V3());
    const killer0 = skinnedBounds(killerMesh).getCenter(new V3());
    const killerH = skinnedBounds(killerMesh).getSize(new V3()).y;
    actions.forEach(a => a.stop());
    this.kill = { root, mixer, actions, cam, head, victim0, dir0: victim0.clone().sub(killer0), scale: KILL_SCALE, duration: Math.max(...kill.animations.map(c => c.duration)) };

    // the roaming saw runner, same size as in the kill scene
    const npc = run.scene;
    prepMeshes(npc);
    let box = skinnedBounds(npc);
    npc.scale.multiplyScalar(killerH * KILL_SCALE / (box.max.y - box.min.y));
    box = skinnedBounds(npc);
    npc.position.y -= box.min.y;
    this.holder.add(npc); scene.add(this.holder);
    this.mixer = new THREE.AnimationMixer(npc);
    for (const c of run.animations) this.actions[c.name] = this.mixer.clipAction(c);
    this.play('Walk');
    this.makeBody();
  },
  moveAnim(speed) { if (speed > 5) this.play('Run', speed / 7); else this.play('Walk', Math.max(0.3, speed / 2.6)); },
  onKillStart() { this.playSound('kill', 1); },
  killCamera() {
    const k = this.kill;
    k.head.scale.setScalar(1);
    k.root.updateMatrixWorld(true);
    k.cam.getWorldPosition(camera.position);
    k.cam.getWorldQuaternion(camera.quaternion);
    // collapse the victim's head (the camera sits inside it) so it doesn't block the view
    k.head.scale.setScalar(0.0001);
    k.head.updateMatrixWorld(true);
    if (camera.fov !== k.cam.fov) { camera.fov = k.cam.fov; camera.updateProjectionMatrix(); }
  },
  updateBuzz() {
    if (!actx) return;
    if (!this.buzz) {
      const o = actx.createOscillator(), f = actx.createBiquadFilter(), g = actx.createGain(), lfo = actx.createOscillator(), lg = actx.createGain();
      o.type = 'sawtooth'; o.frequency.value = 60; f.type = 'lowpass'; f.frequency.value = 1100; g.gain.value = 0;
      lfo.frequency.value = 14; lg.gain.value = 12; lfo.connect(lg).connect(o.frequency);
      o.connect(f).connect(g).connect(bus('monsters')); o.start(); lfo.start();
      this.buzz = { o, g };
    }
    let vol = 0, freq = 60;
    if (this.state === 'killing') { vol = 0.12; freq = 95; }
    else if (this.enabled) {
      const b = this.body.position, d = camera.position.distanceTo(_v1.set(b.x, b.y + 1.2, b.z));
      vol = THREE.MathUtils.clamp(1 - d / 35, 0, 1) * 0.07; freq = this.state === 'stunned' ? 40 : 60 + this.body.velocity.length() * 3;
    }
    this.buzz.g.gain.setTargetAtTime(vol, actx.currentTime, 0.1);
    this.buzz.o.frequency.setTargetAtTime(freq, actx.currentTime, 0.1);
  },
});

// ---- 2. Lethal Ape (taller): walking animation to move, jumpscare to kill; you watch from the floor
const lethalApe = makeKiller({
  name: 'Lethal Ape',
  ragdoll: true,
  soundFiles: { spotted: 'assets/sounds/ape_yell.mp3', splatter: 'assets/sounds/ape_splatter.mp3' },
  walkSpeed: 2.6, chaseSpeed: 6.8, killRange: 2.1, eyeHeight: 2.6,
  bodySpheres: [[0.6, 0.6], [0.6, 1.6], [0.5, 2.5]],
  killCues: [{ t: 3.03, sound: 'splatter' }],     // blood splatter at 03:03 into the jumpscare
  async load() {
    const [walk, jump] = await Promise.all([_gltf.loadAsync('assets/tallape/walk.glb'), _gltf.loadAsync('assets/tallape/jumpscare.glb')]);

    // jumpscare: the ape walks in from -Z, strikes the victim lying at about z=+2.6, then leaps off
    prepMeshes(jump.scene);
    const plane = jump.scene.getObjectByName('Plane');
    if (plane) plane.visible = false;
    const root = new THREE.Group(); root.add(jump.scene); root.visible = false; scene.add(root);
    const mixer = new THREE.AnimationMixer(jump.scene);
    const actions = onceActions(mixer, jump.animations);
    const bone = n => { let f = null; jump.scene.traverse(o => { if (!f && o.isBone && o.name === n) f = o; }); return f; };
    const head = bone('Bone_002_02');
    const hands = [bone('Bone_006_L_05'), bone('Bone_006_R_020')];
    // the victim lies on the floor with its head right by the ape's planted legs (z ~ 1.2)
    const victim0 = new V3(0, 0, 1.9);
    this.kill = { root, mixer, actions, head, hands, victim0, dir0: new V3(0, 0, 1), scale: 1, duration: Math.max(...jump.animations.map(c => c.duration)),
      look: new V3(), eye: new V3(), grabT: 5.15 };

    // The walking ape is a copy of the jumpscare model (the walk file's own mesh skins upside down after
    // conversion), driven by the walk file's animation. Both share one skeleton: walk bones just carry an
    // extra "_NN" suffix, and their rest poses are identical.
    const npc = SkeletonUtils.clone(jump.scene);
    npc.getObjectByName('Plane')?.removeFromParent();
    prepMeshes(npc);
    const bones = new Set();
    npc.traverse(o => { if (o.isBone) bones.add(o.name); });
    const walkClip = walk.animations[0].clone();
    walkClip.tracks = walkClip.tracks
      .map(t => { t.name = t.name.replace(/_\d+(\.\w+)$/, '$1'); return t; })
      .filter(t => bones.has(t.name.split('.')[0]) && !t.name.endsWith('.scale') && t.name !== 'Bone_00.position');
    this.holder.add(npc); scene.add(this.holder);
    this.mixer = new THREE.AnimationMixer(npc);
    this.actions.walk = this.mixer.clipAction(walkClip);
    // stand it on the ground in its walking pose
    this.actions.walk.play(); this.mixer.update(0);
    npc.position.y -= skinnedBounds(npc).min.y - this.holder.position.y;
    this.actions.walk.stop();
    this.play('walk');
    this.makeBody();
  },
  moveAnim(speed) { this.play('walk', Math.max(0.3, speed / 2.6)); },
  onKillStart() {
    this.playSound('spotted', 1);
    const k = this.kill;
    k.head.getWorldPosition(k.look);
    k.eye.copy(k.victim0).setY(0.22); k.root.localToWorld(k.eye);
  },
  killCamera(dt) {
    // Your head lies on the floor by the ape's legs, looking up at it. When it grabs down at you
    // (~5.15 s) your head is pulled along with its hands, dangling below them.
    const k = this.kill;
    const t = k.mixer.time;
    const want = _v2;
    if (t < k.grabT) {
      want.copy(k.victim0).setY(0.22); k.root.localToWorld(want);
    } else {
      const a = k.hands[0].getWorldPosition(_v3), b = k.hands[1].getWorldPosition(new V3());
      want.copy(a).add(b).multiplyScalar(0.5);
      want.y = Math.max(0.22, want.y - 0.9);
    }
    k.eye.lerp(want, 1 - Math.exp(-(t < k.grabT ? 8 : 14) * dt));
    camera.position.copy(k.eye);
    k.look.lerp(k.head.getWorldPosition(_v1), 1 - Math.exp(-6 * dt));
    camera.up.set(0, 1, 0);
    camera.lookAt(k.look);
    camera.rotateZ(t < k.grabT ? 0.35 : 0.35 + Math.sin(t * 9) * 0.25);   // tilted on the ground, then thrashing
    if (camera.fov !== 85) { camera.fov = 85; camera.updateProjectionMatrix(); }
  },
});

// ---- 3. Blade Ape: walking animation from the model file; the kill file has the ape + a victim but no camera
const BLADE_SCALE = 2.3;              // both files are about 0.7 m tall

// little synthesized sounds (the Blade Ape came without any)
function noiseBurst(dur, freq, type = 'lowpass', vol = 0.3, delay = 0) {
  const a = audio(), len = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  f.type = type; f.frequency.value = freq; g.gain.value = vol;
  s.buffer = buf; s.connect(f).connect(g).connect(bus('effects')); s.start(a.currentTime + delay);
}
const thumpSound = () => { noiseBurst(0.12, 300, 'lowpass', 0.5); beep(70, 0.12, 'square', 0.12); };
const crunchSound = () => { for (let i = 0; i < 4; i++) noiseBurst(0.07, 1800, 'highpass', 0.35, i * 0.07); noiseBurst(0.4, 250, 'lowpass', 0.4); };

// blood drops that fall and leave little splats on the ground
const blood = {
  list: [], geo: new THREE.SphereGeometry(0.035, 6, 4), mat: new THREE.MeshBasicMaterial({ color: '#7a0000' }),
  spurt(pos, dir, n = 18, speed = 3) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.geo, this.mat); m.position.copy(pos); scene.add(m);
      const v = dir.clone().multiplyScalar(speed * (0.5 + Math.random())).add(new V3((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2));
      this.list.push({ m, v, life: 6 + Math.random() * 3, landed: false });
    }
  },
  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      if (!d.landed) {
        d.v.y -= 12 * dt; d.m.position.addScaledVector(d.v, dt);
        const gy = groundHeightAt(d.m.position.x, d.m.position.z, d.m.position.y + 0.3) ?? 0;
        if (d.m.position.y <= gy + 0.01) { d.landed = true; d.m.position.y = gy + 0.01; d.m.scale.set(2.2, 0.15, 2.2); }
      }
      if ((d.life -= dt) <= 0) { scene.remove(d.m); this.list.splice(i, 1); }
    }
  },
};

const bladeApe = makeKiller({
  name: 'Blade Ape',
  seeRange: 81,
  soundFiles: { spotted: 'assets/sounds/blade_scream.mp3', splatter: 'assets/sounds/blade_splatter.mp3', death: 'assets/sounds/blade_death.mp3' },
  walkSpeed: 3.0, chaseSpeed: 7.2, accel: 8, killRange: 2.2, eyeHeight: 1.4,
  bodySpheres: [[0.5, 0.5], [0.5, 1.2]],
  shake: 0,
  killCues: [
    { t: 1.75, run: kl => kl.hit(crunchSound, 24) },    // run through and lifted overhead
    { t: 2.48, run: kl => kl.hit(thumpSound, 10) },     // slammed face first
    { t: 3.0, run: kl => kl.hit(thumpSound, 6) },
    { t: 7.98, run: kl => kl.hit(thumpSound, 8) },      // thrown away
    { t: 2.81, sound: 'splatter' },
    { t: 6.53, sound: 'death' },
  ],
  async load() {
    const [walk, jump] = await Promise.all([_gltf.loadAsync('assets/bladeape/walk.glb'), _gltf.loadAsync('assets/bladeape/kill.glb')]);

    // kill scene: the ape at z=0, the victim facing it at z=+0.8. Both skeletons share bone names, the victim's get "_1".
    prepMeshes(jump.scene);
    jump.scene.getObjectByName('Plane')?.removeFromParent();    // floor tile
    const root = new THREE.Group(); root.add(jump.scene); root.visible = false; scene.add(root);
    const mixer = new THREE.AnimationMixer(jump.scene);
    const actions = onceActions(mixer, jump.animations);
    const head = jump.scene.getObjectByName('Bone002_03_21_1'), apeHead = jump.scene.getObjectByName('Bone002_03_21');
    actions.forEach(a => a.play()); mixer.setTime(0);
    jump.scene.updateMatrixWorld(true);
    const victim0 = head.getWorldPosition(new V3()), killer0 = apeHead.getWorldPosition(new V3());
    // no camera in the file, so ride the victim's head: at the start it looks straight at the ape's head
    const look = new Q().setFromRotationMatrix(new THREE.Matrix4().lookAt(victim0, killer0, new V3(0, 1, 0)));
    const camFix = head.getWorldQuaternion(new Q()).invert().multiply(look);
    actions.forEach(a => a.stop());
    this.kill = { root, mixer, actions, head, victim0, dir0: victim0.clone().sub(killer0), scale: BLADE_SCALE, camFix,
      duration: Math.max(...jump.animations.map(c => c.duration)) };

    // the walking ape
    const npc = walk.scene;
    npc.getObjectByName('Plane')?.removeFromParent();
    prepMeshes(npc);
    npc.scale.setScalar(BLADE_SCALE);
    this.holder.add(npc); scene.add(this.holder);
    this.mixer = new THREE.AnimationMixer(npc);
    this.actions.walk = this.mixer.clipAction(walk.animations[0]);
    this.actions.walk.play(); this.mixer.update(0);
    npc.position.y -= skinnedBounds(npc).min.y - this.holder.position.y;     // stand it on the ground
    this.actions.walk.stop();
    this.play('walk');
    this.makeBody();
  },
  moveAnim(speed) { this.play('walk', THREE.MathUtils.clamp(speed / 3, 0.35, 6)); },
  onKillStart() { this.playSound('spotted', 1); },   // screams when it sees you (shared chase code) and when it kills
  hit(sound, drops) {
    sound(); this.shake = 1;
    blood.spurt(this.kill.head.getWorldPosition(new V3()), new V3(0, 1, 0), drops, 2.5);
  },
  killCamera(dt) {
    const k = this.kill;
    k.head.scale.setScalar(1); k.root.updateMatrixWorld(true);
    k.head.getWorldPosition(camera.position);
    k.head.getWorldQuaternion(camera.quaternion).multiply(k.camFix);
    camera.position.add(_v1.set(0, 0.3, -0.25).applyQuaternion(camera.quaternion));   // the bone is at the neck: up to the eyes, clear of the chest
    camera.position.y = Math.max(camera.position.y, k.root.position.y + 0.08);
    // collapse the victim's head (the camera sits inside it) so it doesn't block the view
    k.head.scale.setScalar(0.0001); k.head.updateMatrixWorld(true);
    this.shake = Math.max(0, this.shake - dt * 3);
    camera.position.add(new V3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(this.shake * 0.08));
    if (camera.fov !== 75) { camera.fov = 75; camera.updateProjectionMatrix(); }
  },
});

// ---------------------------------------------------------------- ragdoll ape
// The Lethal Ape's and Blood Moon Gus's kills have no victim in them, so your ape (in your colour) goes floppy
// instead: its head rides the kill camera and the body dangles from it. When the kill ends it drops and stays
// lying there as a body. Spheres only, because cannon-es only collides spheres with the map.
const G_RAG = 4;
const ragdolls = {
  list: [], live: null, MAX: 4,
  spawn() {
    const c = SkeletonUtils.clone(apeSource);
    const src = [], dst = [];
    apeSource.traverse(o => src.push(o)); c.traverse(o => dst.push(o));
    src.forEach((o, i) => { dst[i].position.copy(o.position); dst[i].quaternion.copy(o.quaternion); dst[i].scale.copy(o.scale); });
    const bone = {};
    c.traverse(o => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; } if (o.isBone && !bone[o.name]) bone[o.name] = o; });
    c.traverse(o => { if (o.name === 'hatHolder') o.visible = true; });   // your hat comes along (it's hidden on you in first person)
    apeRoot.updateMatrixWorld(true);
    const g = new THREE.Group(); g.matrixAutoUpdate = false;
    g.matrix.copy(apeSource.parent.matrixWorld); g.add(c); scene.add(g); g.updateMatrixWorld(true);

    const wp = b => b.getWorldPosition(new V3());
    const pelvis = wp(bone.Bone_001), neck = wp(bone.Bone_002), up = neck.clone().sub(pelvis).normalize();
    const bodies = [], joints = [];
    const make = (centre, spheres, mass) => {
      const b = new CANNON.Body({ mass, material: mat.prop, collisionFilterGroup: G_RAG, collisionFilterMask: G_WORLD, linearDamping: 0.1, angularDamping: 0.4, allowSleep: false });
      for (const [p, r] of spheres) b.addShape(new CANNON.Sphere(r), new CANNON.Vec3(p.x - centre.x, p.y - centre.y, p.z - centre.z));
      b.position.set(centre.x, centre.y, centre.z);
      const v = player.body.velocity; b.velocity.set(v.x, v.y, v.z);
      world.addBody(b); bodies.push(b);
      return b;
    };
    const join = (a, b, at) => {
      const j = new CANNON.PointToPointConstraint(a, new CANNON.Vec3(at.x - a.position.x, at.y - a.position.y, at.z - a.position.z),
        b, new CANNON.Vec3(at.x - b.position.x, at.y - b.position.y, at.z - b.position.z));
      world.addConstraint(j); joints.push(j);
    };
    // bodies start unrotated, so each bone's offset from its body is just its world rotation now
    const drive = [];
    const torso = make(pelvis.clone().lerp(neck, 0.5), [[pelvis.clone().addScaledVector(up, 0.15), 0.3], [neck.clone().addScaledVector(up, -0.12), 0.28]], 30);
    const headC = neck.clone().addScaledVector(up, 0.2);
    const head = make(headC, [[headC, 0.2]], 6);
    join(torso, head, neck);
    drive.push({ bone: bone.Bone_002, body: head, off: bone.Bone_002.getWorldQuaternion(new Q()) });
    for (const s of APE_SPEC.arms) {
      const S = wp(bone[s.up]), E = wp(bone[s.fore]), W = wp(bone[s.hand]);
      const upper = make(S.clone().lerp(E, 0.5), [[S.clone().lerp(E, 0.25), 0.1], [S.clone().lerp(E, 0.75), 0.09]], 4);
      const fore = make(E.clone().lerp(W, 0.5), [[E.clone().lerp(W, 0.3), 0.08], [W, 0.11]], 3);
      join(torso, upper, S); join(upper, fore, E);
      for (const [n, b] of [[s.up, upper], [s.fore, fore], [s.hand, fore]]) drive.push({ bone: bone[n], body: b, off: bone[n].getWorldQuaternion(new Q()) });
    }
    // the eyes, in the ape's own (yaw) frame, so the head can be stuck onto a camera
    const yawQ = apeRoot.quaternion.clone(), yawInv = yawQ.clone().invert();
    const eye = neck.clone().add(new V3(0, EYE_UP, 0)).add(new V3(-Math.sin(player.faceYaw), 0, -Math.cos(player.faceYaw)).multiplyScalar(EYE_FWD));
    const rd = {
      g, bodies, joints, torso, head, drive, headBone: bone.Bone_002, yawInv,
      torso0: new THREE.Matrix4().makeTranslation(torso.position.x, torso.position.y, torso.position.z).invert().multiply(g.matrix),
      headFromEye: headC.clone().sub(eye).applyQuaternion(yawInv),
    };
    this.list.push(rd);
    return rd;
  },
  // stick the live ragdoll's head on the kill camera (first person: hide the head so it doesn't block your eyes)
  pin(pos, q, hideHead) {
    const rd = this.live; if (!rd) return;
    rd.hideHead = hideHead;
    if (rd.severed) return;     // the head is flying on its own now
    const h = rd.head;
    if (h.type !== CANNON.Body.KINEMATIC) { h.type = CANNON.Body.KINEMATIC; h.updateMassProperties(); }
    const p = rd.headFromEye.clone().applyQuaternion(q).add(pos);
    h.position.set(p.x, p.y, p.z); h.velocity.set(0, 0, 0);
    const hq = q.clone().multiply(rd.yawInv);
    h.quaternion.set(hq.x, hq.y, hq.z, hq.w); h.angularVelocity.set(0, 0, 0);
  },
  startKill() { this.live = this.spawn(); },
  // cut the live ragdoll's head off: the neck joint goes, the head flies, and a copy of its mesh follows it
  sever(vel) {
    const rd = this.live; if (!rd || rd.severed) return rd;
    rd.severed = true;
    world.removeConstraint(rd.joints.shift());    // the first joint is torso-head
    const h = rd.head;
    h.type = CANNON.Body.DYNAMIC; h.mass = 6; h.updateMassProperties();
    h.velocity.set(vel.x, vel.y, vel.z);
    rd.headMesh = this.bakeHead(rd); scene.add(rd.headMesh);
    rd.stump = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), blood.mat); scene.add(rd.stump);
    return rd;
  },
  // bones can't leave their skeleton, so copy the head's triangles out of the skinned mesh as they are now
  bakeHead(rd) {
    rd.headBone.scale.setScalar(1); rd.g.updateMatrixWorld(true);
    const headBones = new Set(); rd.headBone.traverse(o => headBones.add(o));
    const hb = rd.head, inv = new THREE.Matrix4().compose(_v1.set(hb.position.x, hb.position.y, hb.position.z), _q1.set(hb.quaternion.x, hb.quaternion.y, hb.quaternion.z, hb.quaternion.w), _v2.set(1, 1, 1)).invert();
    const out = new THREE.Group(), p = new V3();
    rd.g.traverse(o => {
      if (!o.isSkinnedMesh) return;
      o.skeleton.update();
      const g = o.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, uv = g.attributes.uv, idx = g.index;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const onHead = i => { let w = 0; for (let k = 0; k < 4; k++) if (headBones.has(o.skeleton.bones[si.getComponent(i, k)])) w += sw.getComponent(i, k); return w > 0.5; };
      const groups = g.groups.length ? g.groups : [{ start: 0, count: idx ? idx.count : g.attributes.position.count, materialIndex: 0 }];
      for (const gr of groups) {
        const pts = [], uvs = [];
        for (let t = gr.start; t + 2 < gr.start + gr.count; t += 3) {
          const tri = [t, t + 1, t + 2].map(i => idx ? idx.getX(i) : i);
          if (!tri.every(onHead)) continue;
          for (const v of tri) {
            o.getVertexPosition(v, p); o.localToWorld(p).applyMatrix4(inv);
            pts.push(p.x, p.y, p.z); if (uv) uvs.push(uv.getX(v), uv.getY(v));
          }
        }
        if (!pts.length) continue;
        const bg = new THREE.BufferGeometry();
        bg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        if (uv) bg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        bg.computeVertexNormals();
        const mesh = new THREE.Mesh(bg, mats[gr.materialIndex] || mats[0]);
        mesh.castShadow = true; mesh.frustumCulled = false;
        out.add(mesh);
      }
    });
    return out;
  },
  // the kill is over: whatever is left of you drops where it is
  endKill() {
    const rd = this.live || this.spawn();
    this.live = null;
    const h = rd.head;
    if (h.type !== CANNON.Body.DYNAMIC) { h.type = CANNON.Body.DYNAMIC; h.mass = 6; h.updateMassProperties(); }
    rd.hideHead = false;
    for (const b of rd.bodies) { b.allowSleep = true; b.wakeUp(); }
    while (this.list.length > this.MAX) this.remove(this.list[0]);
  },
  remove(rd) {
    for (const j of rd.joints) world.removeConstraint(j);
    for (const b of rd.bodies) world.removeBody(b);
    scene.remove(rd.g);
    if (rd.headMesh) { scene.remove(rd.headMesh); scene.remove(rd.stump); }
    this.list.splice(this.list.indexOf(rd), 1);
  },
  clear() { for (const rd of this.list.slice()) if (rd !== this.live) this.remove(rd); },
  // move the meshes to the physics bodies
  update() {
    const m = new THREE.Matrix4(), q = new Q();
    for (const rd of this.list.slice()) {
      const t = rd.torso;
      if (t.position.y < FALL_Y && rd !== this.live) { this.remove(rd); continue; }
      m.compose(_v1.set(t.position.x, t.position.y, t.position.z), q.set(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w), _v2.set(1, 1, 1));
      rd.g.matrix.multiplyMatrices(m, rd.torso0);
      rd.headBone.scale.setScalar(rd.hideHead || rd.severed ? 1e-4 : 1);
      rd.g.updateMatrixWorld(true);
      for (const d of rd.drive) {
        const b = d.body.quaternion;
        setWorldQ(d.bone, q.set(b.x, b.y, b.z, b.w).multiply(d.off));
      }
      if (rd.headMesh) {
        const h = rd.head;
        rd.headMesh.position.set(h.position.x, h.position.y, h.position.z);
        rd.headMesh.quaternion.set(h.quaternion.x, h.quaternion.y, h.quaternion.z, h.quaternion.w);
        rd.headMesh.visible = !rd.hideHead;
        rd.headBone.getWorldPosition(rd.stump.position);
      }
    }
  },
};

// ---- 4. Gus: running animation from the model file; the kill file has Gus + a victim, with a camera in the victim's head
const GUS_HEIGHT = 2.9;
const gus = makeKiller({
  name: 'Gus',
  soundFiles: { spotted: 'assets/sounds/gus_scream.mp3', gruesome: 'assets/sounds/gus_gruesome.mp3', k096: 'assets/sounds/gus_096.mp3' },
  walkSpeed: 2.8, chaseSpeed: 7.0, killRange: 2.2, eyeHeight: 2.4,
  bodySpheres: [[0.55, 0.55], [0.55, 1.5], [0.45, 2.3]],
  // gruesome sound at 0.21 s; SCP-096 sound from 1.43 s, cut off at 2.77 s
  killCues: [{ t: 0.21, sound: 'gruesome' }, { t: 1.43, sound: 'k096' }, { t: 2.77, stop: 'k096' }],
  async load() {
    const mgr = new THREE.LoadingManager();
    mgr.setURLModifier(u => (u.startsWith('blob:') || u.startsWith('data:') || u.endsWith('.fbx')) ? u : 'assets/gusnew/Gus_Base_color.png');
    const [run, jump] = await Promise.all([new FBXLoader(mgr).loadAsync('assets/gusnew/run.fbx'), _gltf.loadAsync('assets/gusnew/kill.glb')]);

    // kill scene: three strips the dots from node names ("Camera.001_05" -> "Camera001_05")
    prepMeshes(jump.scene);
    for (const n of ['Icosphere', 'Icosphere001']) jump.scene.getObjectByName(n).visible = false;   // big see-through balls
    const root = new THREE.Group(); root.add(jump.scene); root.visible = false; scene.add(root);
    const mixer = new THREE.AnimationMixer(jump.scene);
    const actions = onceActions(mixer, jump.animations);
    const head = jump.scene.getObjectByName('head_032_030'), gusHead = jump.scene.getObjectByName('Bone_004_07_065');
    const cam = jump.scene.getObjectByName('Camera001_05');
    actions.forEach(a => a.play()); mixer.setTime(0);
    jump.scene.updateMatrixWorld(true);
    const gusMesh = jump.scene.getObjectByName('Object_26');
    const victim0 = head.getWorldPosition(new V3()), killer0 = gusHead.getWorldPosition(new V3());
    const killH = skinnedBounds(gusMesh).getSize(new V3()).y;
    actions.forEach(a => a.stop());
    this.kill = { root, mixer, actions, cam, victim: jump.scene.getObjectByName('Object_88'), hatHead: head, victim0, dir0: victim0.clone().sub(killer0), scale: GUS_HEIGHT / killH,
      duration: Math.max(...jump.animations.map(c => c.duration)),
      // the camera node looks down its +X with its +Z up, not the -Z and +Y a three.js camera uses
      camFix: new Q().setFromAxisAngle(new V3(0, 1, 0), -Math.PI / 2).multiply(new Q().setFromAxisAngle(new V3(0, 0, 1), -Math.PI / 2)) };

    // running Gus, the same height as in the kill
    const npc = run;
    npc.traverse(o => {
      if (!o.isMesh) return;
      const mk = m => /teeth/i.test(m.name) ? new THREE.MeshStandardMaterial({ color: '#efe9d6', roughness: 0.5 }) : new THREE.MeshStandardMaterial({ map: m.map, roughness: 0.9 });
      o.material = Array.isArray(o.material) ? o.material.map(mk) : mk(o.material);
      for (const m of [].concat(o.material)) if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
    });
    prepMeshes(npc);
    this.mixer = new THREE.AnimationMixer(npc);
    const clip = run.animations.find(c => /\|ArmatureAction$/.test(c.name));
    clip.duration = 0.63;      // the stride ends here; the rest of the clip holds still, which would stall the run
    this.actions.walk = this.mixer.clipAction(clip);
    this.actions.walk.play(); this.mixer.update(0);
    let box = skinnedBounds(npc);
    npc.scale.multiplyScalar(GUS_HEIGHT / (box.max.y - box.min.y));
    box = skinnedBounds(npc);
    const c = box.getCenter(new V3());
    npc.position.x -= c.x; npc.position.z -= c.z; npc.position.y -= box.min.y;
    this.npcTurn = new THREE.Group(); this.npcTurn.add(npc);
    this.holder.add(this.npcTurn); scene.add(this.holder);
    this.actions.walk.stop(); this.current = null;
    this.play('walk');
    this.makeBody();
  },
  moveAnim(speed) { this.play('walk', Math.max(0.35, speed / 7)); },
  // the scream starts when it sees you and keeps looping until it loses you, you reach the shop, or it kills you
  updateBuzz() {
    const s = this.sounds.spotted, b = this.body?.position;
    if (!s || !b) return;
    s.loop = true;
    const want = this.enabled && this.state !== 'killing' && this.alerted && !player.dead && !shop.isSafe();
    if (!want) { if (!s.paused) s.pause(); return; }
    const p = player.body.position;
    s.baseVol = THREE.MathUtils.clamp(1 - Math.hypot(b.x - p.x, b.z - p.z) / 40, 0.1, 1);
    s.volume = Math.min(1, s.baseVol * htmlVol());
    if (s.paused) s.play().catch(() => {});
  },
  killCamera() {
    const k = this.kill;
    k.cam.getWorldPosition(camera.position);
    k.cam.getWorldQuaternion(camera.quaternion).multiply(k.camFix);
    // the camera sits inside the victim, whose arms and chest would fill the screen: only show it from outside
    k.victim.visible = killThird;
    if (camera.fov !== 65) { camera.fov = 65; camera.updateProjectionMatrix(); }
  },
});

// ---- 5. The Mimic: the blue model knuckle-walks (it came without animations, so it's posed by code like the player),
// the other model plays the kill, seen through the victim's eyes
const MIMIC_HEIGHT = 2.1;
const MIMIC_SPEC = {
  spine: 'Bone_001_03', head: 'head_05',
  // glTF bone names carry a number suffix; the model faces +Z, so its left arm is on +X
  arms: [
    { side: 1, up: 'upperarm_L_08', fore: 'lowerarm_L_09', hand: 'hand_L_010',
      fingers: [['index1_L_011', 'index2_L_012', 'index3_L_013'], ['pinkie1_L_014', 'pinkie2_L_015', 'pinkie3_L_00'], ['thumb1_L_016', 'thumb2_L_017', 'thumb3_L_018']] },
    { side: -1, up: 'upperarm_R_01', fore: 'lowerarm_R_020', hand: 'hand_R_021',
      fingers: [['index1_R_022', 'index2_R_023', 'index3_R_024'], ['pinkie1_R_025', 'pinkie2_R_026', 'pinkie3_R_027'], ['thumb1_R_028', 'thumb2_R_029', 'thumb3_R_030']] },
  ],
};
// the walker's dark red skin turned blue (red and blue swapped, a little brighter)
function blueTexture(t) {
  const img = t.image, c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i], gr = p[i + 1], b = p[i + 2];
    p[i] = Math.min(255, b * 0.9); p[i + 1] = Math.min(255, gr * 1.3 + r * 0.25); p[i + 2] = Math.min(255, r * 1.9 + 25);
  }
  g.putImageData(d, 0, 0);
  const nt = new THREE.CanvasTexture(c);
  nt.flipY = t.flipY; nt.colorSpace = THREE.SRGBColorSpace; nt.wrapS = t.wrapS; nt.wrapT = t.wrapT;
  return nt;
}
function mimicScreech() {
  const a = audio(), o = a.createOscillator(), o2 = a.createOscillator(), f = a.createBiquadFilter(), g = a.createGain();
  o.type = 'sawtooth'; o2.type = 'square';
  o.frequency.setValueAtTime(380, a.currentTime); o.frequency.exponentialRampToValueAtTime(900, a.currentTime + 0.35); o.frequency.exponentialRampToValueAtTime(160, a.currentTime + 1.1);
  o2.frequency.setValueAtTime(393, a.currentTime); o2.frequency.exponentialRampToValueAtTime(930, a.currentTime + 0.35); o2.frequency.exponentialRampToValueAtTime(150, a.currentTime + 1.1);
  f.type = 'bandpass'; f.frequency.value = 1200; f.Q.value = 0.8;
  g.gain.setValueAtTime(0.0001, a.currentTime); g.gain.exponentialRampToValueAtTime(0.25, a.currentTime + 0.05); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 1.2);
  o.connect(f); o2.connect(f); f.connect(g).connect(bus('monsters'));
  o.start(); o2.start(); o.stop(a.currentTime + 1.2); o2.stop(a.currentTime + 1.2);
  noiseBurst(0.9, 2500, 'highpass', 0.12);
}
// every distance at which a ray crosses a triangle soup (positions P, optional index I), nearest first
function rayHits(P, I, n, o, d) {
  const out = [];
  for (let t = 0; t < n; t += 3) {
    const a = (I ? I[t] : t) * 3, b = (I ? I[t + 1] : t + 1) * 3, c = (I ? I[t + 2] : t + 2) * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const hx = d.y * e2z - d.z * e2y, hy = d.z * e2x - d.x * e2z, hz = d.x * e2y - d.y * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-12) continue;
    const f = 1 / det, sx = o.x - P[a], sy = o.y - P[a + 1], sz = o.z - P[a + 2];
    const u = f * (sx * hx + sy * hy + sz * hz); if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = f * (d.x * qx + d.y * qy + d.z * qz); if (v < 0 || u + v > 1) continue;
    const dist = f * (e2x * qx + e2y * qy + e2z * qz);
    if (dist > 1e-6) out.push(dist);
  }
  return out.sort((x, y) => x - y);
}

const mimic = makeKiller({
  name: 'The Mimic',
  soundFiles: { gruesome: 'assets/sounds/gus_gruesome.mp3' },
  walkSpeed: 3.0, chaseSpeed: 7.4, killRange: 1.9, eyeHeight: 1.6,
  bodySpheres: [[0.5, 0.5], [0.5, 1.3]],
  mixer: { update() {} },
  body3: new THREE.Group(),
  R: null, phase: 0, spotT: 0,
  killCues: [{ t: 0.15, sound: 'gruesome' }],
  async load() {
    const mgr = new THREE.LoadingManager();
    mgr.setURLModifier(u => {
      if (u.startsWith('blob:') || u.startsWith('data:')) return u;
      const f = u.split(/[\\/]/).pop();
      if (f === 'MimicKill.fbx') return 'assets/mimic/kill/' + f;
      return 'assets/mimic/kill/' + (/^Ape \(1\)|^DeadApe/i.test(f) ? 'DeadApeC.png' : 'ba2f4413.png');
    });
    const [walk, kfbx] = await Promise.all([_gltf.loadAsync('assets/mimic/mimic.gltf'), new FBXLoader(mgr).loadAsync('MimicKill.fbx')]);

    // ---- kill scene: two armatures (the Mimic and its victim) share bone names, so each gets its own mixer
    prepMeshes(kfbx);
    // plain matte materials (the FBX ones come out fully emissive); teeth and eyeballs had no textures in the download
    const killMat = m => {
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
      if (/^Tooth/.test(m.name)) return stdMat({ name: m.name, color: '#e8e0c8', roughness: 0.5 });
      if (/^1\.001$/.test(m.name)) return stdMat({ name: m.name, color: '#f4f0e8', roughness: 0.3 });
      return stdMat({ name: m.name, map: m.map, side: THREE.DoubleSide });
    };
    kfbx.traverse(o => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(killMat) : killMat(o.material); });
    const armOf = mesh => { let o = mesh.skeleton.bones[0]; while (o.parent && !/^Armature/.test(o.name)) o = o.parent; return o; };
    const mimicMesh = kfbx.getObjectByName('LAR_Ape_LOD0'), victimMesh = kfbx.getObjectByName('LAR_Ape_LOD0001');
    const mimicArm = armOf(mimicMesh), victimArm = armOf(victimMesh);
    const clip = (arm) => kfbx.animations.find(c => c.name === `${arm.name.replace('001', '.001')}|Armature.001Action`);
    const mixers = [new THREE.AnimationMixer(mimicArm), new THREE.AnimationMixer(victimArm)];
    const actions = [...onceActions(mixers[0], [clip(mimicArm)]), ...onceActions(mixers[1], [clip(victimArm)])];
    const root = new THREE.Group(); root.add(kfbx); root.visible = false; scene.add(root);
    let cam = null; kfbx.traverse(o => { if (o.isCamera) cam = o; });
    let head = null; victimArm.traverse(o => { if (!head && o.isBone && o.name === 'head') head = o; });
    const mixer = { update: dt => mixers.forEach(m => m.update(dt)), setTime: t => mixers.forEach(m => m.setTime(t)) };
    actions.forEach(a => a.play()); mixer.setTime(0);
    kfbx.updateMatrixWorld(true);
    const vb = skinnedBounds(victimMesh), mb = skinnedBounds(mimicMesh);
    const victim0 = cam.getWorldPosition(new V3()), killer0 = mb.getCenter(new V3());
    actions.forEach(a => a.stop());
    this.kill = { root, mixer, actions, cam, head, victim0, dir0: victim0.clone().sub(killer0),
      scale: MIMIC_HEIGHT / mb.getSize(new V3()).y,
      duration: Math.max(...actions.map(a => a.getClip().duration)),
      camFix: new Q().setFromAxisAngle(new V3(0, 1, 0), -Math.PI / 2) };    // FBX cameras look down +X
    console.log('[mimic] kill', this.kill.duration.toFixed(2), 's, victim h', vb.getSize(new V3()).y.toFixed(2), 'mimic h', mb.getSize(new V3()).y.toFixed(2));
    this.fitCamera([mimicMesh, kfbx.getObjectByName('LAR_Eyes')].filter(Boolean));

    // ---- the walking Mimic: blue, turned to face +Z, sized by its body (not its arms)
    const npc = walk.scene;
    npc.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.frustumCulled = false;
      for (const m of [].concat(o.material)) { if (m.map) m.map = blueTexture(m.map); m.color.set('#ffffff'); m.roughness = 0.8; m.metalness = 0; m.needsUpdate = true; }
    });
    const bone = n => { let f = null; npc.traverse(o => { if (!f && o.isBone && o.name === n) f = o; }); return f; };
    npc.updateMatrixWorld(true);
    const wp = n => bone(n).getWorldPosition(new V3());
    const up = wp('head_05').sub(wp('neck_02')).normalize();
    const left = wp('upperarm_L_08').sub(wp('upperarm_R_01'));
    left.sub(up.clone().multiplyScalar(left.dot(up))).normalize();
    const fwd = new V3().crossVectors(left, up);
    npc.quaternion.premultiply(new Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, fwd)).invert());
    const isArm = b => /_[LR]_/.test(b.name);
    const bodyBox = () => {
      npc.updateMatrixWorld(true);
      const box = new THREE.Box3(), p = new V3();
      npc.traverse(o => {
        if (!o.isSkinnedMesh) return;
        o.skeleton.update();
        const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight;
        for (let i = 0; i < si.count; i++) {
          let w = 0;
          for (let k = 0; k < 4; k++) if (isArm(o.skeleton.bones[si.getComponent(i, k)])) w += sw.getComponent(i, k);
          if (w > 0.3) continue;
          o.getVertexPosition(i, p); box.expandByPoint(o.localToWorld(p));
        }
      });
      return box;
    };
    this.holder.add(this.body3); this.body3.add(npc); scene.add(this.holder);
    let box = bodyBox();
    npc.scale.multiplyScalar(MIMIC_HEIGHT / (box.max.y - box.min.y));
    box = bodyBox();
    const c = box.getCenter(new V3());
    npc.position.x -= c.x; npc.position.z -= c.z; npc.position.y -= box.min.y;
    this.R = buildRig(npc, this.holder, MIMIC_SPEC);
    console.log('[mimic] reach', this.R.reach.toFixed(2), 'shoulder', this.R.shoulderY.toFixed(2));
    this.makeBody();
  },
  moveAnim() {},
  onSpot() { this.spotT = this.holdT = 0.9; mimicScreech(); },
  resetPose() {
    for (const [b, q] of this.R.local0) b.quaternion.copy(q);
    this.holder.updateMatrixWorld(true);
  },
  // knuckle-walk like the player's ape; arms thrown up and twitching when it spots you, limp when stunned
  animate(dt, speed) {
    if (!this.R) return;
    const R = this.R, t = time, H = this.holder;
    this.spotT = Math.max(0, this.spotT - dt);
    const running = speed > 5, sf = THREE.MathUtils.clamp(speed / 7.4, 0, 1), stride = 0.4 + 0.6 * sf;
    if (speed > 0.3) this.phase += Math.PI * speed / (2 * stride) * dt;
    const ph = this.phase, stunned = this.state === 'stunned', spot = this.spotT > 0;
    this.body3.position.set(0, spot ? 0.2 : (running ? Math.abs(Math.sin(ph)) * 0.2 : Math.abs(Math.sin(ph)) * 0.06 * sf), 0);
    this.body3.rotation.set(spot ? -0.25 : 0.18 * sf, 0, stunned ? Math.sin(t * 6) * 0.15 : (running ? 0 : Math.sin(ph) * 0.09 * sf));
    this.resetPose();
    // head: tracks you once it has seen you, with a nasty little twitch
    const lp = H.worldToLocal(apeRoot.position.clone().add(new V3(0, 1.2, 0)));
    const yaw = THREE.MathUtils.clamp(Math.atan2(lp.x, lp.z), -0.9, 0.9);
    const pitch = -THREE.MathUtils.clamp(Math.atan2(lp.y - 1.6, Math.hypot(lp.x, lp.z)), -0.6, 0.6);
    const twitch = Math.sin(t * 23) * Math.sin(t * 3.1) > 0.85 ? 0.35 : 0;
    const look = stunned ? new THREE.Euler(0.4 + Math.sin(t * 5) * 0.2, Math.sin(t * 3) * 0.6, Math.sin(t * 4) * 0.3, 'YXZ')
      : new THREE.Euler(this.alerted ? pitch : 0.1, (this.alerted ? yaw : Math.sin(t * 0.6) * 0.5), twitch, 'YXZ');
    setWorldQ(R.head, H.quaternion.clone().multiply(new Q().setFromEuler(look)).multiply(R.rest.get(R.head).q));
    for (const a of R.arms) {
      const S = H.worldToLocal(a.up.getWorldPosition(new V3()));
      let target, pole = new V3(a.side * 0.7, 1, -0.5), bend = 0.9;
      if (stunned) {
        target = S.clone().add(new V3(a.side * 0.5, -1, 0.3).normalize().multiplyScalar(R.reach * 0.8));
        target.y = Math.max(target.y, 0.12); bend = 0.3;
      } else if (spot) {
        target = S.clone().add(new V3(a.side * 0.6, 0.9 + Math.sin(t * 25 + a.side) * 0.2, 0.7).normalize().multiplyScalar(R.reach * 0.92));
        pole.set(a.side, 0.2, -1); bend = 0.1;
      } else {
        const pha = running ? ph : ph + (a.side > 0 ? Math.PI : 0);
        const amp = speed > 0.3 ? stride : 0;
        const forward = Math.min(R.reach * 0.55, 1.2) + 0.3 * sf;
        target = new V3(S.x + a.side * 0.3, 0, forward - amp * Math.cos(pha));
        const lift = Math.max(0, Math.sin(pha)) * (running ? 0.5 : 0.3) * (amp > 0 ? 1 : 0);
        const tw = H.localToWorld(target.clone());
        const gy = groundHeightAt(tw.x, tw.z, H.position.y + 1.5);
        target.y = (gy == null ? 0 : THREE.MathUtils.clamp(gy - H.position.y, -1, 1.2)) + 0.12 + lift;
      }
      solveArm(a, target, pole, bend, R);
    }
  },
  // The Mimic pushes its face into the victim's, which put the camera (in the victim's eyes) inside the Mimic's head.
  // Work out once, through the kill, how far the camera has to slide back to be outside the Mimic again (every 0.05 s).
  async fitCamera(meshes) {
    const k = this.kill, step = 0.05, push = [];
    const dirs = [];                      // even spread of directions, in the camera's frame
    for (let i = 0; i < 40; i++) {
      const y = 1 - (i + 0.5) / 20, r = Math.sqrt(1 - y * y), a = i * 2.39996;
      dirs.push(new V3(Math.cos(a) * r, y, Math.sin(a) * r));
    }
    k.actions.forEach(a => a.play());
    for (let t = 0; t <= k.duration + 1e-6; t += step) {
      k.mixer.setTime(t); k.root.updateMatrixWorld(true);
      const tris = [];
      for (const m of meshes) {
        const g = m.geometry, n = g.attributes.position.count, P = new Float32Array(n * 3), v = new V3();
        for (let i = 0; i < n; i++) { m.getVertexPosition(i, v); m.localToWorld(v); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; }
        tris.push({ P, I: g.index ? g.index.array : null, n: g.index ? g.index.count : n });
      }
      const o0 = k.cam.getWorldPosition(new V3()), q = k.cam.getWorldQuaternion(new Q()).multiply(k.camFix), o = o0.clone();
      // the meshes have holes (mouth, eyes), so "inside" = most rays cross the surface an odd number of times
      for (let tries = 0; tries < 4; tries++) {
        const rays = dirs.map(dl => { const d = dl.clone().applyQuaternion(q); return { back: dl.z, d, hits: tris.map(m => rayHits(m.P, m.I, m.n, o, d)) }; });
        const inside = tris.map((_, mi) => rays.filter(r => r.hits[mi].length % 2).length > rays.length / 2);
        if (!inside.some(Boolean)) break;
        // way out: straight back is best (you end up just under its face, still looking at it), never through the floor
        let best = null;
        for (const r of rays) {
          if (r.back < 0) continue;
          let out = 0, ok = true;
          inside.forEach((ins, mi) => { if (ins) { if (r.hits[mi].length % 2) out = Math.max(out, r.hits[mi][0]); else ok = false; } });
          if (!ok || o.y + r.d.y * (out + 5) < 4) continue;
          const score = (out + 5) * (2 - r.back);
          if (!best || score < best.score) best = { out, d: r.d, score };
        }
        if (!best) break;
        o.addScaledVector(best.d, best.out + 5);
      }
      // keep it in the kill scene's own space (the scene gets turned and scaled to fit you)
      push.push(o.sub(o0));
      if (push.length % 5 === 0) await new Promise(r => setTimeout(r, 0));   // don't freeze the game while working it out
    }
    k.actions.forEach(a => a.stop());
    k.push = push; k.pushStep = step;
    console.log('[mimic] camera fit', push.filter(p => p.lengthSq()).length + '/' + push.length, 'samples pushed out');
  },
  killCamera() {
    const k = this.kill;
    if (k.head) { k.head.scale.setScalar(1); k.root.updateMatrixWorld(true); }
    k.cam.getWorldPosition(camera.position);
    k.cam.getWorldQuaternion(camera.quaternion).multiply(k.camFix);
    if (k.push) {
      const f = k.actions[0].time / k.pushStep, i = Math.min(Math.floor(f), k.push.length - 1), j = Math.min(i + 1, k.push.length - 1);
      const off = k.push[i].clone().lerp(k.push[j], f - i).applyQuaternion(k.root.quaternion).multiplyScalar(k.root.scale.x);
      // get out of the Mimic's head straight away, drift back into the victim's eyes slowly
      k.camOff = k.camOff && k.actions[0].time > 0.05 && off.length() < k.camOff.length() ? k.camOff.lerp(off, 0.15) : off;
      camera.position.add(k.camOff);
    }
    // collapse the victim's head (the camera sits inside it) so it doesn't block the view
    if (k.head) { k.head.scale.setScalar(0.0001); k.head.updateMatrixWorld(true); }
    if (camera.fov !== 70) { camera.fov = 70; camera.updateProjectionMatrix(); }
  },
});

// ---- 6. The Claw: walks upside down along the ceilings (walking animation from the model file) and jumps at you
// (the jumpscare file: the Claw lunges at a still camera, no victim, so your own ape hangs off the camera as a ragdoll).
// Its physics body only marks where it is on the floor below (walks the nav graph, touches nothing); the model hangs above it.
const CLAW_HEIGHT = 2.05;   // as tall as in the jumpscare file
const crawScreech = () => {
  for (let i = 0; i < 5; i++) { beep(900 + i * 260, 0.09, 'sawtooth', 0.07); noiseBurst(0.08, 3200, 'bandpass', 0.2, i * 0.06); }
  noiseBurst(0.5, 1800, 'bandpass', 0.3);
};

const craw = makeKiller({
  name: 'Claw',
  soundFiles: {},
  walkSpeed: 8, chaseSpeed: 16, accel: 14, killRange: 2.0, eyeHeight: 1.6,
  ragdoll: true, silentSteps: true,
  phase: 0, flip: 0, surfY: 0, ceilT: 0,
  killCues: [{ t: 0.02, run: () => crawScreech() }, { t: 0.75, run: () => crunchSound() }],
  async load() {
    const [walk, jump] = await Promise.all([_gltf.loadAsync('assets/claw/move.glb'), _gltf.loadAsync('assets/claw/kill.glb')]);

    // kill scene: the file's origin is up at head height, so lift it until the Claw's feet are on the floor
    prepMeshes(jump.scene);
    const lift = new THREE.Group(); lift.add(jump.scene);
    const root = new THREE.Group(); root.add(lift); root.visible = false; scene.add(root);
    const mixer = new THREE.AnimationMixer(jump.scene);
    const actions = onceActions(mixer, jump.animations);
    actions.forEach(a => a.play()); mixer.setTime(1);
    lift.position.y = -skinnedBounds(jump.scene).min.y;
    root.updateMatrixWorld(true);
    // the "Camera" node holds still; aim it at the Claw's face as it lands in front of you
    const cam = jump.scene.getObjectByName('Camera');
    const eye = cam.getWorldPosition(new V3()), face = jump.scene.getObjectByName('Bone_003_04').getWorldPosition(new V3());
    mixer.setTime(0); root.updateMatrixWorld(true);
    const killer0 = jump.scene.getObjectByName('Bone_01').getWorldPosition(new V3());
    actions.forEach(a => a.stop());
    this.kill = { root, mixer, actions, cam, victim0: eye.clone(), dir0: eye.clone().sub(killer0), scale: 1,
      look: new Q().setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, face, new V3(0, 1, 0))),
      duration: Math.min(3, Math.max(...jump.animations.map(c => c.duration))) };    // it lunges in the first second, then just stares

    // the walking Claw: it faces -X in the file, killers face +Z
    const npc = walk.scene;
    prepMeshes(npc);
    this.mixer = new THREE.AnimationMixer(npc);
    this.actions.walk = this.mixer.clipAction(walk.animations[0]);
    this.actions.walk.play(); this.mixer.update(0);
    let box = skinnedBounds(npc);
    npc.scale.multiplyScalar(CLAW_HEIGHT / (box.max.y - box.min.y));
    box = skinnedBounds(npc);
    const c = box.getCenter(new V3());
    npc.position.x -= c.x; npc.position.z -= c.z; npc.position.y -= box.min.y;
    this.model = new THREE.Group(); this.model.rotation.y = Math.PI / 2; this.model.add(npc);
    this.holder.rotation.order = 'YXZ';
    this.holder.add(this.model); scene.add(this.holder);
    this.actions.walk.stop(); this.current = null;
    this.play('walk');
    this.makeBody();
  },
  makeBody() {
    const b = this.body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, collisionFilterGroup: G_RAG, collisionFilterMask: 0 });
    b.addShape(new CANNON.Sphere(0.5), new CANNON.Vec3(0, 0.5, 0));
    world.addBody(b);
    this.place();
    this.surfY = b.position.y;
    this.ready = true;
  },
  moveAnim(speed) { this.play('walk', THREE.MathUtils.clamp(speed / 4, 0.4, 4)); },
  onSpot() { crawScreech(); },
  animate(dt, speed) {
    const b = this.body;
    // stay on the floor below it (stairs included): the body isn't in the physics fight
    b.velocity.y = 0;
    camRay.set(_v1.set(b.position.x, b.position.y + 1.6, b.position.z), _v2.set(0, -1, 0)); camRay.far = 5;
    const ground = camRay.intersectObjects(staticMeshes, false)[0];
    const gy = ground ? ground.point.y : (this.path?.[this.pathI]?.y ?? b.position.y);
    b.position.y += (gy - b.position.y) * Math.min(1, dt * 12);
    // a ceiling above? go up there. None in reach (open sky, huge hall): walk on the floor instead
    if ((this.ceilT -= dt) <= 0) {
      this.ceilT = 0.1;
      camRay.set(_v1.set(b.position.x, b.position.y + 1.2, b.position.z), _v2.set(0, 1, 0)); camRay.far = 9;
      const c = camRay.intersectObjects(staticMeshes, false)[0];
      this.onCeil = !!c;
      if (c) this.ceilY = c.point.y;
    }
    this.flip += ((this.onCeil ? 1 : 0) - this.flip) * (1 - Math.exp(-6 * dt));
    if (this.onCeil) this.surfY += (this.ceilY - this.surfY) * (1 - Math.exp(-10 * dt));
    this.holder.position.y = b.position.y + (this.surfY - b.position.y) * this.flip;
    this.holder.rotation.z = this.flip * Math.PI;
    // quick clicks you can hear coming
    const before = Math.floor(this.phase / Math.PI);
    this.phase += Math.min(speed * 1.6, 32) * dt;
    if (Math.floor(this.phase / Math.PI) !== before) {
      const v = THREE.MathUtils.clamp(1 - camera.position.distanceTo(this.holder.position) / 28, 0, 1);
      if (v > 0) noiseBurst(0.025, 2600, 'highpass', 0.3 * v);
    }
    // a thrown prop can still knock it off the ceiling (aimed at its middle, a metre from the surface)
    if (this.state === 'chase') {
      const mid = _v2.copy(this.holder.position); mid.y += this.flip > 0.5 ? -1 : 1;
      for (const q of props) {
        const v = q.body.velocity;
        if (q.body.mass > 3 && v.lengthSquared() > 36 && mid.distanceTo(_v1.set(q.body.position.x, q.body.position.y, q.body.position.z)) < 1.6) {
          this.stun(2.5); break;
        }
      }
    }
  },
  onKillEnd() { this.flip = 0; this.surfY = this.body.position.y; },
  killCamera() {
    const k = this.kill;
    k.cam.getWorldPosition(camera.position);
    camera.quaternion.copy(k.root.quaternion).multiply(k.look);
    camera.up.set(0, 1, 0);
    if (camera.fov !== 75) { camera.fov = 75; camera.updateProjectionMatrix(); }
  },
});

// ---- 7. Blood Moon Gus: only out during the blood moon. Walk animation from the model file, kill animation (with its own camera) from the kill file
const bloodGus = makeKiller({
  name: 'Blood Moon Gus',
  eventOnly: true,
  alwaysKnows: true,      // the moon shows it where you are: it never has to see you first, and never loses you
  ragdoll: true,
  soundFiles: { gruesome: 'assets/sounds/gus_gruesome.mp3', k096: 'assets/sounds/gus_096.mp3' },
  walkSpeed: 8, chaseSpeed: 8,    // always at a run: the moon tells it where you are
  killRange: 2.2, eyeHeight: 2.4,
  bodySpheres: [[0.55, 0.55], [0.55, 1.5], [0.45, 2.3]],
  // gruesome sound at 0.21 s; SCP-096 sound from 1.43 s, cut off at 2.77 s
  killCues: [{ t: 0.21, sound: 'gruesome' }, { t: 1.43, sound: 'k096' }, { t: 2.77, stop: 'k096' }],
  async load() {
    const killFiles = ['Gus_Walking.fbx', 'Gus_Walking_goose2_BaseMap.png', 'Gus_Walking_Handle1Mtl_Roughness_BaseMap_1.png', 'Tiles002_2K-JPG_Color.png', 'fur_blood.png', 'gorillaface.png'];
    const mgr = new THREE.LoadingManager();
    mgr.setURLModifier(u => {
      if (u.startsWith('blob:') || u.startsWith('data:')) return u;
      const f = u.split(/[\\/]/).pop();
      if (killFiles.includes(f)) return 'assets/gus/kill/' + f;
      if (/^Gus_Walking_Handle1Mtl_Roughness_BaseMap/.test(f)) return 'assets/gus/kill/Gus_Walking_Handle1Mtl_Roughness_BaseMap_1.png';
      if (/^gorillaface/i.test(f)) return 'assets/gus/kill/gorillaface.png';
      if (/^GorillaFur\.png$/i.test(f)) return 'assets/GorillaFur.png';
      return 'assets/gus/kill/fur_blood.png';            // missing extras (normal maps are dropped below)
    });
    const [walk, kfbx] = await Promise.all([_gltf.loadAsync('assets/gus/gus.glb'), new FBXLoader(mgr).loadAsync('Gus_Walking.fbx')]);

    // kill scene: Gus (with the chainsaw, the "Arms_*" meshes) + an animated camera at the victim's eyes
    prepMeshes(kfbx);
    kfbx.traverse(o => {
      if (o.isMesh) for (const m of [].concat(o.material)) { m.normalMap = null; m.bumpMap = null; if (m.map) m.map.colorSpace = THREE.SRGBColorSpace; m.needsUpdate = true; }
    });
    for (const n of ['Cube', 'Cube_1']) { const o = kfbx.getObjectByName(n); if (o) o.visible = false; }   // eye marker, floor tile
    const root = new THREE.Group(); root.add(kfbx); root.visible = false; scene.add(root);
    const mixer = new THREE.AnimationMixer(kfbx);
    const actions = onceActions(mixer, kfbx.animations);
    let cam = null; kfbx.traverse(o => { if (o.isCamera) cam = o; });
    actions.forEach(a => a.play()); mixer.setTime(0);
    kfbx.updateMatrixWorld(true);
    const gusMesh = kfbx.getObjectByName('Gus');
    gusMesh.skeleton.update();
    const gb = new THREE.Box3().expandByObject(gusMesh, true);
    const victim0 = cam.getWorldPosition(new V3()), killer0 = gb.getCenter(new V3());
    actions.forEach(a => a.stop());
    this.kill = { root, mixer, actions, cam, victim0, dir0: victim0.clone().sub(killer0), scale: GUS_HEIGHT / gb.getSize(new V3()).y,
      duration: Math.max(...kfbx.animations.map(c => c.duration)),
      camFix: new Q().setFromAxisAngle(new V3(0, 1, 0), -Math.PI / 2) };    // FBX cameras look down +X

    // walking Gus, the same height as in the kill
    const npc = walk.scene;
    prepMeshes(npc);
    this.mixer = new THREE.AnimationMixer(npc);
    this.actions.walk = this.mixer.clipAction(walk.animations[0]);
    this.actions.walk.play(); this.mixer.update(0);
    let box = skinnedBounds(npc);
    npc.scale.multiplyScalar(GUS_HEIGHT / (box.max.y - box.min.y));
    box = skinnedBounds(npc);
    const c = box.getCenter(new V3());
    npc.position.x -= c.x; npc.position.z -= c.z; npc.position.y -= box.min.y;
    this.npcTurn = new THREE.Group(); this.npcTurn.add(npc);
    this.npcTurn.rotation.y = Math.PI / 2;     // the model faces -X; killers face +Z
    this.holder.add(this.npcTurn); scene.add(this.holder);
    this.actions.walk.stop(); this.current = null;
    this.play('walk');
    this.makeBody();
    this.setEnabled(false);
  },
  moveAnim(speed) { this.play('walk', Math.max(0.35, speed / 2.8)); },
  killCamera() {
    const k = this.kill;
    k.cam.getWorldPosition(camera.position);
    k.cam.getWorldQuaternion(camera.quaternion).multiply(k.camFix);
    if (camera.fov !== 65) { camera.fov = 65; camera.updateProjectionMatrix(); }
  },
});

const killers = [sawRunner, lethalApe, bladeApe, gus, mimic, craw, bloodGus];

// ---------------------------------------------------------------- save data, coins, faces
const SAVE_KEY = 'apeSandbox.save';
const save = (() => {
  const def = { coins: 20, owned: ['face0'], face: 0, hat: -1 };
  try { return Object.assign(def, JSON.parse(localStorage.getItem(SAVE_KEY) || '{}')); } catch { return def; }
})();
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch {} }
function updateCoins() { $('coins').textContent = save.coins + ' coins'; }
function addCoins(n, why) {
  save.coins += n; persist(); updateCoins();
  if (why) toast(`+${n} coins: ${why}`);
}

// face pack: same layout as the ape's own face texture, so they swap straight onto its face material
const FACES = [['Classic', 0], ['Shocked', 20], ['Hairy', 30], ['Crying', 25], ['Creepy', 40], ['Cute', 35], ['Blank', 20], ['Bloody', 60], ['Grin', 30]];
const faceTex = FACES.map((_, i) => {
  const t = new THREE.TextureLoader().load(`assets/faces/face${i}.png`);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
});
// ---------------------------------------------------------------- plush hats (the Big Scary Plush hats by @maaahhh9)
// Bought and worn at the Ape Shop. The hat sits on your ape's head, stays on your ragdoll, and every kill with a
// victim of its own puts it on that victim too, so you keep your hat when a killer gets you.
const HATS = [['Default_Hat', 'Plush Hat', 40], ['Frog_Hat', 'Frog Hat', 60], ['Cat_Ears_Hat', 'Cat Ears Hat', 60]];
const hats = {
  templates: [], wearers: [], loaded: false, player: null,
  async load() {
    const mgr = new THREE.LoadingManager();
    mgr.setURLModifier(u => (u.startsWith('blob:') || u.startsWith('data:') || u.endsWith('.fbx')) ? u : 'assets/hats/fur.png');
    const f = await new FBXLoader(mgr).loadAsync('assets/hats/hats.fbx');
    f.updateMatrixWorld(true);
    for (const [name] of HATS) {
      const m = f.getObjectByName(name).clone();
      const mats = [].concat(m.material).map(x => {
        if (x.map) x.map.colorSpace = THREE.SRGBColorSpace;
        return new THREE.MeshStandardMaterial({ color: x.color, map: x.map || null, roughness: 0.95 });
      });
      m.material = mats.length === 1 ? mats[0] : mats;
      m.castShadow = true;
      // 1 wide, bottom in the middle at the origin, front along +Z
      const fit = new THREE.Group(); fit.add(m);
      m.position.set(0, 0, 0); fit.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(fit), size = box.getSize(new V3()), c = box.getCenter(new V3());
      const s = 1 / Math.max(size.x, size.z);
      fit.scale.setScalar(s); fit.position.set(-c.x * s, -box.min.y * s, -c.z * s);
      this.templates.push(new THREE.Group().add(fit));
    }
    this.loaded = true;
  },
  // fit a hat holder onto a head bone from the pose it is in now: on top of the head's vertices, as wide as the
  // head, facing `front` (world). It rides the bone from then on. Returns the wearer, or null if there's no head.
  register(headBone, front) {
    const heads = new Set(); headBone.traverse(o => heads.add(o));
    let root = headBone; while (root.parent) root = root.parent;
    root.updateMatrixWorld(true);
    const box = new THREE.Box3(), v = new V3();
    root.traverse(o => {
      if (!o.isSkinnedMesh) return;
      o.skeleton.update();
      const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight;
      for (let i = 0; i < si.count; i += 2) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (heads.has(o.skeleton.bones[si.getComponent(i, k)])) w += sw.getComponent(i, k);
        if (w > 0.5) { o.getVertexPosition(i, v); box.expandByPoint(o.localToWorld(v)); }
      }
    });
    if (box.isEmpty()) return null;
    const size = box.getSize(new V3()), c = box.getCenter(new V3());
    const holder = new THREE.Group(); holder.name = 'hatHolder';
    holder.position.set(c.x, box.max.y - size.y * 0.22, c.z);         // sunk onto the head, clear of the eyes
    holder.rotation.set(0, Math.atan2(front.x, front.z), 0);
    holder.scale.setScalar(Math.max(size.x, size.z) * 1.2);
    scene.add(holder); holder.updateMatrixWorld(true);
    headBone.attach(holder);
    const w = { holder };
    this.wearers.push(w);
    return w;
  },
  dress(w) {
    w.holder.clear();
    if (save.hat >= 0 && this.templates[save.hat]) w.holder.add(this.templates[save.hat].clone());
  },
  wearAll() { for (const w of this.wearers) this.dress(w); },
};

function setFace(obj, i) {
  obj.traverse(o => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material])
      if (/_2$/.test(m.name)) { m.map = faceTex[i]; m.needsUpdate = true; }
  });
}

const coinPickups = {
  list: [],
  geo: new THREE.CylinderGeometry(0.3, 0.3, 0.07, 24).rotateX(Math.PI / 2),
  mat: new THREE.MeshStandardMaterial({ color: '#ffcc33', emissive: '#7a5200', metalness: 0.8, roughness: 0.3 }),
  ray: new THREE.Raycaster(),
  spawnAll(n) { for (let i = 0; i < n; i++) { const m = new THREE.Mesh(this.geo, this.mat); m.castShadow = true; scene.add(m); const c = { m, wait: 0 }; this.place(c); this.list.push(c); } },
  place(c) {
    const nd = nav.random();
    c.base = new V3(nd.x, nd.y + 0.7, nd.z);
    c.m.position.copy(c.base); c.m.visible = true; c.wait = 0;
  },
  update(dt, t) {
    const p = player.body.position, r = save.owned.includes('magnet') ? 6 : 1.5;
    for (const c of this.list) {
      if (!c.m.visible) { if ((c.wait -= dt) <= 0) this.place(c); continue; }
      c.m.rotation.y += dt * 3; c.m.position.y = c.base.y + Math.sin(t * 2 + c.base.x) * 0.15;
      if (player.dead) continue;
      if (Math.hypot(c.base.x - p.x, c.base.y - (p.y + 0.8), c.base.z - p.z) < r) {
        c.m.visible = false; c.wait = 25;
        addCoins(5); beep(1300, 0.06, 'square', 0.04); setTimeout(() => beep(1750, 0.08, 'square', 0.04), 60);
      }
    }
  },
};

// ---------------------------------------------------------------- the Gorilla Tag stick
const stick = {
  template: null, held: null, swingT: 0, hitDone: false,
  async load() {
    const g = await _gltf.loadAsync('assets/shop/stick.glb');
    const wood = new THREE.MeshStandardMaterial({ color: '#7a5532', roughness: 0.9 });
    g.scene.traverse(o => { if (o.isMesh) { o.material = wood; o.castShadow = true; } });
    // turn its long axis to +Y and stand it on its base, about 1.25 m long
    const size0 = new THREE.Box3().setFromObject(g.scene).getSize(new V3());
    if (size0.x >= size0.y && size0.x >= size0.z) g.scene.rotation.z = Math.PI / 2;
    else if (size0.z >= size0.y) g.scene.rotation.x = Math.PI / 2;
    g.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g.scene), size = box.getSize(new V3());
    const s = 1.25 / size.y;
    g.scene.scale.setScalar(s);
    g.scene.position.set(-(box.min.x + size.x / 2) * s, -box.min.y * s, -(box.min.z + size.z / 2) * s);
    this.template = new THREE.Group(); this.template.add(g.scene);
    this.held = this.template.clone(); this.held.visible = false; scene.add(this.held);
  },
  // right hand target (character space) while the stick is out; swings across on click
  armTarget(S) {
    let dir = new V3(0.45, -0.15, -0.85);
    if (this.swingT > 0) {
      const k = 1 - this.swingT / 0.35, e = 1 - (1 - k) * (1 - k);
      dir = new V3().lerpVectors(new V3(0.9, 0.9, -0.3), new V3(-0.6, -0.45, -0.75), e);
    }
    return S.clone().add(dir.normalize().multiplyScalar(rig.reach * 0.8));
  },
  swing() {
    if (this.swingT > 0) return;
    this.swingT = 0.35; this.hitDone = false;
    beep(220, 0.12, 'triangle', 0.05);
  },
  hit() {
    const p = player.body.position, fwd = new V3(-Math.sin(player.faceYaw), 0, -Math.cos(player.faceYaw));
    for (const kl of killers) {
      if (!kl.ready || !kl.enabled || kl.state === 'killing') continue;
      const b = kl.body.position, to = new V3(b.x - p.x, 0, b.z - p.z), d = to.length();
      if (d > 3.8 || to.normalize().dot(fwd) < 0.3) continue;
      const fresh = kl.state !== 'stunned';
      kl.stun(3);
      kl.body.velocity.x += to.x * 10; kl.body.velocity.z += to.z * 10; kl.body.velocity.y += 4;
      boomSound(0.15);
      if (fresh) addCoins(10, `bonked the ${kl.name}!`);
    }
    for (const q of props) {
      if (q.frozen) continue;
      const to = new V3(q.body.position.x - p.x, 0, q.body.position.z - p.z), d = to.length();
      if (d > 3.2 || to.normalize().dot(fwd) < 0.3) continue;
      q.body.wakeUp();
      q.body.applyImpulse(new CANNON.Vec3(to.x, 0.4, to.z).scale(Math.min(q.body.mass, 60) * 8), new CANNON.Vec3());
    }
  },
  update(dt) {
    if (!this.held) return;
    const out = tools.list[tools.current] === 'Stick' && !player.dead && apeRoot.visible;
    this.held.visible = out;
    if (this.swingT > 0) {
      this.swingT -= dt;
      if (!this.hitDone && this.swingT < 0.17) { this.hitDone = true; this.hit(); }
    }
    if (out) {
      const arm = rig.arms.find(a => a.side > 0);
      const h = arm.hand.getWorldPosition(new V3()), e = arm.fore.getWorldPosition(new V3());
      placeStick(this.held, h, h.clone().sub(e).normalize());
    }
  },
};
function placeStick(obj, at, dir) { obj.position.copy(at); obj.quaternion.setFromUnitVectors(new V3(0, 1, 0), dir); }
function giveStickTool() {
  if (!tools.list.includes('Stick')) { tools.list.push('Stick'); renderTools(); }
}

// ---------------------------------------------------------------- the shop + shopkeeper
const SHOP_ITEMS = [
  { id: 'stick', name: 'Gorilla Tag Stick', price: 50, desc: 'Tool 4. Bonk the killers to stun them (+10 coins each bonk).' },
  { id: 'magnet', name: 'Coin Magnet', price: 120, desc: 'Pick up coins from much farther away.' },
  ...FACES.map(([n, price], i) => ({ id: 'face' + i, face: i, name: n + ' face', price, desc: 'Wear it on your ape.' })),
  ...HATS.map(([, n, price], i) => ({ id: 'hat' + i, hat: i, name: n, price, desc: 'You want to look cool? It stays on, even when a killer gets you.' })),
];
const shop = {
  C: new V3(14, 0, 6), open: false, npcRoot: new THREE.Group(), npcRig: null, npcStick: null, waveT: 0, typeTimer: 0,
  build() {
    const C = this.C, wood = stdMat({ map: tex.wood }), wall = stdMat({ map: tex.wall }), roof = stdMat({ color: '#3d6b45' });
    addStatic([0.8, 1.0, 3.6], [C.x - 0.2, 0.5, C.z], wood);                  // counter
    addStatic([0.3, 3.3, 4.6], [C.x + 2.1, 1.65, C.z], wall);                 // back wall
    addStatic([2.6, 3.3, 0.3], [C.x + 0.9, 1.65, C.z - 2.2], wall);           // sides
    addStatic([2.6, 3.3, 0.3], [C.x + 0.9, 1.65, C.z + 2.2], wall);
    addStatic([3.6, 0.3, 5.2], [C.x + 0.7, 3.45, C.z], roof);                 // roof
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#2b1a0e'; g.fillRect(0, 0, 512, 128);
    g.fillStyle = '#ffcc33'; g.font = 'bold 84px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('APE SHOP', 256, 68);
    const signTex = new THREE.CanvasTexture(c); signTex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshBasicMaterial({ map: signTex }));
    sign.position.set(C.x - 1.12, 3.0, C.z); sign.rotation.y = -Math.PI / 2;
    scene.add(sign);
  },
  // shopkeeper = a copy of the player's ape, behind the counter, holding the stick
  initNpc() {
    const npc = SkeletonUtils.clone(apeSource);
    const byName = {};
    npc.traverse(o => {
      if (o.isBone) byName[o.name] = o;
      if (o.isMesh) { o.frustumCulled = false; o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); }
    });
    for (const [b, q] of rig.local0) byName[b.name]?.quaternion.copy(q);   // undo the player's live pose
    npc.position.set(apeSource.position.x, apeSource.position.y, apeSource.position.z);
    setFace(npc, 8);
    this.npcRoot.add(npc);
    this.npcRig = buildRig(npc, this.npcRoot);
    this.npcRoot.position.set(this.C.x + 0.9, 0, this.C.z);
    this.npcRoot.rotation.y = Math.PI / 2;      // faces -X, over the counter
    scene.add(this.npcRoot);
  },
  attachStick() { this.npcStick = stick.template.clone(); scene.add(this.npcStick); },
  isSafe() { return Math.hypot(player.body.position.x - this.C.x, player.body.position.z - this.C.z) < 7; },
  nearNpc() { return Math.hypot(player.body.position.x - this.npcRoot.position.x, player.body.position.z - this.npcRoot.position.z) < 3.8; },

  update(dt, t) {
    const R = this.npcRig;
    if (!R) return;
    const canAct = !this.open && !menuOpen && !player.dead;
    const what = !canAct ? null : computer.near() ? 'Use the computer' : this.nearNpc() ? 'Talk to the Shopkeeper' : null;
    $('prompt').style.display = what ? 'block' : 'none';
    if (what && $('promptText').textContent !== what) $('promptText').textContent = what;
    // pose: reset, look at the player, one hand on the counter, the other holding the stick (or waving)
    for (const [b, q] of R.local0) b.quaternion.copy(q);
    this.npcRoot.updateMatrixWorld(true);
    const lp = this.npcRoot.worldToLocal(camera.position.clone());
    const yaw = THREE.MathUtils.clamp(Math.atan2(-lp.x, -lp.z), -0.9, 0.9);
    const pitch = THREE.MathUtils.clamp(Math.atan2(lp.y - 1.4, Math.hypot(lp.x, lp.z)), -0.5, 0.5) * 0.7;
    const look = new Q().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    setWorldQ(R.head, this.npcRoot.quaternion.clone().multiply(look).multiply(R.rest.get(R.head).q));
    this.waveT = Math.max(0, this.waveT - dt);
    for (const a of R.arms) {
      let target, pole = new V3(a.side, 0.5, 0.6), bend = 0.6;
      if (a.side < 0) target = new V3(-0.35, 1.08 + Math.sin(t * 1.7) * 0.02, -0.85);
      else if (this.waveT > 0) { target = new V3(0.75, 2.0 + Math.sin(t * 12) * 0.12, -0.2 + Math.sin(t * 12) * 0.15); bend = 0; }
      else target = new V3(0.5, 1.05 + Math.sin(t * 1.3) * 0.03, -0.55);
      solveArm(a, target, pole, bend, R);
    }
    if (this.npcStick) {
      const arm = R.arms.find(a => a.side > 0);
      const up = new V3(0.1, 1, -0.25).applyQuaternion(this.npcRoot.quaternion).normalize();
      placeStick(this.npcStick, arm.hand.getWorldPosition(new V3()).addScaledVector(up, -0.35), up);
    }
  },

  // ---- dialog
  talk() {
    if (!this.npcRig || !this.nearNpc()) return;
    this.open = true; menuOpen = true; this.waveT = 1.2;
    $('dialog').style.display = 'block';
    if (!unlockedPlay) document.exitPointerLock();
    beep(500, 0.06, 'sine', 0.05); setTimeout(() => beep(650, 0.08, 'sine', 0.05), 80);
    this.home(['Ooh ooh! Welcome to the Ape Shop. Got coins? I got stuff.', 'Ah, a customer! The killers never come in here. Safe and sound. What do you need?', 'Hoo hoo! Fresh faces, fine sticks. Have a look!'][Math.floor(Math.random() * 3)]);
  },
  close() {
    this.open = false; menuOpen = false;
    $('dialog').style.display = 'none';
    lockPointer();
  },
  say(text) {
    const el = $('say'); let i = 0;
    clearInterval(this.typeTimer);
    this.typeTimer = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(this.typeTimer); }, 18);
  },
  options(list) {
    $('opts').innerHTML = '';
    for (const [label, fn] of list) {
      const b = document.createElement('button'); b.textContent = label; b.onclick = fn; $('opts').append(b);
    }
  },
  home(greeting) {
    $('items').innerHTML = '';
    this.say(greeting);
    this.options([
      ['Show me the shop', () => this.showShop('Take your pick!')],
      ['Who are you?', () => this.home("I'm just an ape with a stick. Nothing that hunts you can come within seven metres of my shop. You're safe here.")],
      ['How do I get coins?', () => this.home('Gold coins are scattered all over the place, 5 each. Bonk a killer with my stick and you get 10 more!')],
      ['Bye', () => this.close()],
    ]);
  },
  showShop(line) {
    this.say(line);
    this.options([['Back', () => this.home('Anything else?')], ['Bye', () => this.close()]]);
    const box = $('items'); box.innerHTML = '';
    for (const it of SHOP_ITEMS) {
      const owned = save.owned.includes(it.id), worn = it.face !== undefined && save.face === it.face;
      const wornHat = it.hat !== undefined && save.hat === it.hat, wearable = it.face !== undefined || it.hat !== undefined;
      const row = document.createElement('div'); row.className = 'item';
      row.innerHTML = (it.face !== undefined ? `<img src="assets/faces/face${it.face}.png" alt="">` : `<div class="ico">${it.hat !== undefined ? ['🧢', '🐸', '🐱'][it.hat] : it.id === 'stick' ? '🪵' : '🧲'}</div>`) +
        `<div class="txt"><b>${it.name}</b><span>${it.desc}</span></div>`;
      const btn = document.createElement('button');
      if (worn) { btn.textContent = 'Wearing'; btn.disabled = true; }
      else if (wornHat) { btn.textContent = 'Take off'; btn.onclick = () => this.wear({ hat: -1, name: 'hat' }, 'Back to the natural look. Hoo!'); }
      else if (owned && wearable) { btn.textContent = 'Wear'; btn.onclick = () => this.wear(it); }
      else if (owned) { btn.textContent = 'Owned'; btn.disabled = true; }
      else { btn.textContent = it.price + ' coins'; btn.onclick = () => this.buy(it); }
      row.append(btn); box.append(row);
    }
  },
  buy(it) {
    if (save.coins < it.price) { beep(150, 0.15, 'square', 0.05); return this.showShop(`That's ${it.price} coins. You need ${it.price - save.coins} more. Go grab some gold!`); }
    save.coins -= it.price; save.owned.push(it.id); persist(); updateCoins();
    beep(900, 0.07, 'square', 0.05); setTimeout(() => beep(1200, 0.1, 'square', 0.05), 90);
    this.waveT = 1.2;
    if (it.face !== undefined || it.hat !== undefined) return this.wear(it, `Pleasure doing business! The ${it.name} looks great on you.`);
    if (it.id === 'stick') { giveStickTool(); tools.select(tools.list.indexOf('Stick')); }
    this.showShop(it.id === 'stick' ? "A fine stick! It's tool 4. Click to bonk anything that chases you." : 'Coins will practically fly to you now. Hoo hoo!');
  },
  wear(it, line) {
    if (it.hat !== undefined) { save.hat = it.hat; persist(); hats.wearAll(); }
    else { save.face = it.face; persist(); setFace(apeSource, it.face); }
    this.showShop(line || `Looking sharp in the ${it.name}!`);
  },
};

// ---------------------------------------------------------------- the computer (name + colour)
// A Gorilla Tag style computer in the spawn room: walk up, press E, type a name and pick a colour.
// The name floats over your ape and the colour tints its fur. Both are saved with the rest of your progress.
const COLOR_PRESETS = [['Green', [0, 9, 0]], ['Red', [9, 1, 1]], ['Blue', [1, 3, 9]], ['Orange', [9, 5, 0]], ['Purple', [6, 1, 9]], ['Pink', [9, 4, 7]], ['Yellow', [9, 9, 1]], ['White', [9, 9, 9]], ['Black', [2, 2, 2]]];
const rgbOf = c => new THREE.Color(c[0] / 9, c[1] / 9, c[2] / 9);
const computer = {
  group: new THREE.Group(), front: new V3(), open: false, screen: null, screenCanvas: null, tag: null,
  async load() {
    const mgr = new THREE.LoadingManager();
    mgr.setURLModifier(u => (u.startsWith('blob:') || u.startsWith('data:')) ? u : 'assets/computer/' + u.split(/[\\/]/).pop());
    const fbx = await new FBXLoader(mgr).loadAsync('Computer.fbx');
    fbx.scale.setScalar(0.01);                            // centimetres -> metres: ~2 m wide screen, keyboard in front (+X)
    fbx.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(fbx);
    fbx.position.y -= box.min.y;                          // stand on the floor
    fbx.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
    this.group.add(fbx);
    // the screen: a canvas over the teal panel (the monitor's front face is at x = +0.125, centre y = 0.84 + lift)
    const c = this.screenCanvas = document.createElement('canvas'); c.width = 512; c.height = 340;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    this.screen = new THREE.Mesh(new THREE.PlaneGeometry(1.86, 1.24), new THREE.MeshBasicMaterial({ map: tex }));
    this.screen.position.set(0.13, 0.84 - box.min.y, 0); this.screen.rotation.y = Math.PI / 2;   // faces +X
    this.group.add(this.screen);
    this.size = box.getSize(new V3());
    this.minY = box.min.y;
    // name tag over the player's ape
    const tc = document.createElement('canvas'); tc.width = 512; tc.height = 96;
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(tc), depthWrite: false }));
    this.tag.material.map.colorSpace = THREE.SRGBColorSpace;
    this.tag.userData.canvas = tc;
    this.tag.scale.set(1.6, 0.3, 1); this.tag.position.y = APE_HEIGHT + 0.45;
    apeRoot.add(this.tag);
    this.apply();
  },
  // stand it on a floor spot, keyboard side towards `face`
  place(nd, face) {
    const yaw = Math.atan2(-(face.z - nd.z), face.x - nd.x);   // local +X -> towards `face`
    this.group.position.set(nd.x, nd.y, nd.z); this.group.rotation.y = yaw;
    scene.add(this.group);
    this.group.updateMatrixWorld(true);
    this.front.set(1.6, 0, 0).applyMatrix4(this.group.matrixWorld);   // where you stand to type
    // solid: a box around the screen + keyboard
    const s = this.size, b = new CANNON.Body({ mass: 0, material: mat.ground, shape: new CANNON.Box(new CANNON.Vec3(s.x / 2, s.y / 2, s.z / 2)) });
    const centre = new V3(s.x / 2 - 0.125, s.y / 2, 0).applyMatrix4(this.group.matrixWorld);
    b.position.set(centre.x, centre.y, centre.z); b.quaternion.copy(this.group.quaternion);
    world.addBody(b);
    this.group.traverse(o => { if (o.isMesh && o !== this.screen) staticMeshes.push(o); });
  },
  near() {
    if (!this.group.parent) return false;
    const p = player.body.position;
    return Math.hypot(p.x - this.front.x, p.z - this.front.z) < 1.8 && Math.abs(p.y - this.front.y) < 1.5;
  },
  // fur tint, name tag and the computer screen from the saved choices
  apply() {
    const col = rgbOf(save.color || [9, 9, 9]);
    apeSource.traverse(o => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) if (!/_2$/.test(m.name)) m.color.copy(col);   // fur only, not the face
    });
    const name = save.name || 'GORILLA';
    const tc = this.tag.userData.canvas, g = tc.getContext('2d');
    g.clearRect(0, 0, tc.width, tc.height);
    g.font = 'bold 64px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = '#000'; g.strokeText(name, 256, 50);
    g.fillStyle = '#fff'; g.fillText(name, 256, 50);
    this.tag.material.map.needsUpdate = true;
    this.drawScreen();
  },
  drawScreen() {
    const c = this.screenCanvas, g = c.getContext('2d'), col = save.color || [9, 9, 9];
    g.fillStyle = '#123f45'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#9ff3e8'; g.font = 'bold 30px monospace'; g.textBaseline = 'top';
    g.fillText('GORILLA OS', 24, 20);
    g.font = '26px monospace';
    g.fillText('NAME:  ' + (save.name || 'GORILLA'), 24, 90);
    g.fillText(`COLOR: R${col[0]} G${col[1]} B${col[2]}`, 24, 140);
    g.fillStyle = '#' + rgbOf(col).getHexString(); g.fillRect(380, 120, 100, 70);
    g.strokeStyle = '#9ff3e8'; g.lineWidth = 3; g.strokeRect(380, 120, 100, 70);
    g.fillStyle = '#9ff3e8'; g.font = '22px monospace';
    g.fillText('PRESS E TO USE', 24, 280);
    this.screen.material.map.needsUpdate = true;
  },

  // ---- panel
  openPanel() {
    this.open = true; menuOpen = true;
    if (!unlockedPlay) document.exitPointerLock();
    const col = save.color || [9, 9, 9];
    $('pcName').value = save.name || '';
    ['R', 'G', 'B'].forEach((k, i) => { $('pc' + k).value = col[i]; });
    $('pcPresets').innerHTML = COLOR_PRESETS.map(([n, c]) => `<button data-c="${c.join(',')}" style="border-color:#${rgbOf(c).getHexString()}">${n}</button>`).join('');
    this.preview();
    $('pcPanel').style.display = 'block';
    $('pcName').focus();
    beep(800, 0.05, 'square', 0.04);
  },
  close() {
    this.open = false; menuOpen = false;
    $('pcPanel').style.display = 'none';
    $('pcName').blur();
    lockPointer();
  },
  sliders() { return ['R', 'G', 'B'].map(k => +$('pc' + k).value); },
  preview() {
    const c = this.sliders();
    $('pcSwatch').style.background = '#' + rgbOf(c).getHexString();
    $('pcRGB').textContent = `R${c[0]} G${c[1]} B${c[2]}`;
  },
  setName() {
    const name = $('pcName').value.toUpperCase().replace(/[^A-Z0-9 _-]/g, '').trim().slice(0, 12);
    $('pcName').value = name;
    save.name = name; persist(); this.apply();
    toast(name ? `Your name is now ${name}` : 'Name cleared');
    beep(1000, 0.06, 'square', 0.04);
  },
  setColor(c) {
    ['R', 'G', 'B'].forEach((k, i) => { $('pc' + k).value = c[i]; });
    save.color = c; persist(); this.preview(); this.apply();
    beep(600 + c[1] * 40, 0.06, 'square', 0.04);
  },
};
$('pcSetName').addEventListener('click', () => computer.setName());
$('pcDone').addEventListener('click', () => { computer.setName(); computer.close(); });
['R', 'G', 'B'].forEach(k => $('pc' + k).addEventListener('input', () => computer.setColor(computer.sliders())));
$('pcPresets').addEventListener('click', e => { const c = e.target.dataset.c; if (c) computer.setColor(c.split(',').map(Number)); });

// ---------------------------------------------------------------- footsteps
// One step sound for everyone: a step each time a hand/foot lands, quieter the further the walker is from you,
// pitched a little lower for the big killers and slightly varied so it doesn't sound like a machine gun.
const footsteps = {
  buf: null, loading: false,
  player: { dist: 0 }, killer: new Map(),
  load() {
    if (this.buf || this.loading || !actx) return;
    this.loading = true;
    fetch('assets/sounds/footstep.mp3').then(r => r.arrayBuffer()).then(b => actx.decodeAudioData(b)).then(buf => { this.buf = buf; })
      .catch(err => console.error('footstep sound', err));
  },
  play(vol, rate) {
    if (!this.buf || vol < 0.01) return;
    const a = audio(), s = a.createBufferSource(), g = a.createGain();
    s.buffer = this.buf; s.playbackRate.value = rate * (0.92 + Math.random() * 0.16);
    g.gain.value = Math.min(1, vol);
    s.connect(g).connect(bus('monsters')); s.start();
  },
  // browsers only allow sound after a click or key press, so start the audio on the first one
  unlock() { audio(); if (actx.state === 'suspended') actx.resume(); },
  update(dt) {
    this.load();
    if (!this.buf) return;
    // the player: a step every ~0.9 m on the ground (closer together when running)
    const pl = this.player;
    if (!player.dead && player.grounded && player.speed > 0.5) {
      pl.dist += player.speed * dt;
      const len = player.speed > 6 ? 1.3 : 0.9;
      if (pl.dist >= len) { pl.dist = 0; this.play(player.speed > 6 ? 0.55 : 0.4, 1); }
    } else pl.dist = 0.6;    // first step comes quickly after you start moving
    // the killers: heavier, lower steps you hear from up to ~30 m away
    for (const kl of killers) {
      if (!kl.ready || !kl.enabled || kl.state === 'killing' || kl.silentSteps) continue;
      const v = kl.body.velocity, sp = Math.hypot(v.x, v.z);
      if (sp < 0.5 || Math.abs(v.y) > 1.5) continue;
      const d = (this.killer.get(kl) || 0) + sp * dt;
      const len = sp > 5 ? 1.8 : 1.2;
      if (d >= len) {
        const b = kl.body.position, far = camera.position.distanceTo(_v1.set(b.x, b.y, b.z));
        this.play(Math.pow(THREE.MathUtils.clamp(1 - far / 30, 0, 1), 1.5) * (sp > 5 ? 0.9 : 0.6), 0.75);
        this.killer.set(kl, 0);
      } else this.killer.set(kl, d);
    }
  },
};

// ---------------------------------------------------------------- dread
// The closer a hunting killer gets, the more it feels like you're about to die: a pounding heartbeat that speeds up,
// panicked breathing, red closing in at the edges, the colour draining out, tunnel vision and shaky hands.
const dread = {
  level: 0, beatT: 0, breathT: 0, pulse: 0, noise: null, fov: 75, filter: '',
  // how scared you should be right now, 0..1
  threat() {
    if (player.dead) return 0;
    let t = (1 - player.health / 100) * 0.6;
    for (const kl of killers) {
      if (!kl.ready || !kl.enabled || kl.state === 'killing') continue;
      const b = kl.body.position, p = player.body.position, d = Math.hypot(b.x - p.x, b.z - p.z);
      let k = kl.alerted ? Math.pow(THREE.MathUtils.clamp(1 - d / 40, 0, 1), 0.7) : THREE.MathUtils.clamp(1 - d / 20, 0, 1) * 0.45;
      if (kl.state === 'stunned') k *= 0.5; else if (kl.state === 'cooldown') k *= 0.3;
      t = Math.max(t, k);
    }
    return shop.isSafe() ? t * 0.3 : t;
  },
  heartbeat(vol) {
    const a = audio(), now = a.currentTime;
    for (const [at, v] of [[0, 1], [0.17, 0.65]]) {      // lub-dub
      const o = a.createOscillator(), g = a.createGain();
      o.frequency.setValueAtTime(62, now + at); o.frequency.exponentialRampToValueAtTime(34, now + at + 0.16);
      g.gain.setValueAtTime(0.0001, now + at); g.gain.exponentialRampToValueAtTime(vol * v, now + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.2);
      o.connect(g).connect(bus('ambience')); o.start(now + at); o.stop(now + at + 0.25);
    }
  },
  breath(vol, inhale) {
    const a = audio(), now = a.currentTime, len = inhale ? 0.38 : 0.5;
    if (!this.noise) {
      this.noise = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = this.noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    s.buffer = this.noise; f.type = 'bandpass'; f.frequency.value = inhale ? 1400 : 800; f.Q.value = 0.9;
    g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(vol, now + len * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, now + len);
    s.connect(f).connect(g).connect(bus('ambience')); s.start(now, Math.random() * 0.4, len);
  },
  update(dt) {
    const want = this.threat();
    this.level += (want - this.level) * (1 - Math.exp(-(want > this.level ? 3 : 0.7) * dt));   // fear comes fast, fades slowly
    const L = this.level, killing = killers.some(kl => kl.state === 'killing');
    // heartbeat: 70 bpm when uneasy, up to 170 when it's right behind you
    if (actx && L > 0.12 && !killing) {
      this.beatT -= dt;
      if (this.beatT <= 0) { this.beatT = 60 / (70 + 100 * L); this.heartbeat(0.15 + 0.45 * L); this.pulse = 1; }
      if (L > 0.4) {
        this.breathT -= dt;
        if (this.breathT <= 0) { this.inhale = !this.inhale; this.breathT = (this.inhale ? 0.42 : 0.55) * (1.4 - L * 0.6); this.breath(0.03 + 0.06 * L, this.inhale); }
      }
    } else this.beatT = 0.3;
    this.pulse = Math.max(0, this.pulse - dt * 4);
    // red closing in at the edges, throbbing with each heartbeat
    $('dread').style.opacity = killing ? 0 : Math.min(1, L * (0.75 + 0.35 * this.pulse)).toFixed(3);
    // colour drains out
    const filter = L > 0.05 ? `saturate(${(1 - 0.65 * L).toFixed(2)}) contrast(${(1 + 0.15 * L).toFixed(2)})` : '';
    if (filter !== this.filter) renderer.domElement.style.filter = this.filter = filter;
    if (killing) return;
    // tunnel vision and shaking
    const fov = 75 - 9 * L;
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }
    const shake = L * L * 0.012 + this.pulse * L * 0.006;
    camera.rotation.x += (Math.sin(time * 37) + Math.sin(time * 23.7)) * shake;
    camera.rotation.y += (Math.sin(time * 31.3) + Math.sin(time * 17.1)) * shake;
  },
};

addEventListener('pointerdown', () => footsteps.unlock());
addEventListener('keydown', () => footsteps.unlock());

// ---------------------------------------------------------------- the blood moon
// Every few minutes (or press B) the fog goes red, a moon rises and Blood Moon Gus comes out until it sets.
// The map has no windows, so the moon is on the screen: big as it rises, then small in the corner.
const bloodMoon = {
  active: false, k: 0, timer: 75, left: 0, bannerT: 0,
  LENGTH: 60,
  sky: { bg: scene.background.clone(), fog: scene.fog.color.clone(), near: scene.fog.near, far: scene.fog.far, hemi: hemi.color.clone(), ground: hemi.groundColor.clone(), hemiI: hemi.intensity, sun: sun.color.clone(), sunI: sun.intensity },
  red: { bg: new THREE.Color('#5c0707'), fog: new THREE.Color('#6e0909'), near: 3, far: 36, hemi: new THREE.Color('#ff8a78'), ground: new THREE.Color('#4a0a0a'), hemiI: 1.25, sun: new THREE.Color('#ff3a28'), sunI: 1.5 },
  toggle() {
    if (!this.active && !director.on) return toast('Turn the killers on first (K)');
    if (this.active) this.left = 0; else this.start();
  },
  start() {
    if (this.active || !bloodGus.ready) return;
    this.active = true; this.left = this.LENGTH; this.bannerT = 4.5; this.spawnT = 3;
    $('bloodBanner').style.opacity = 1;
    $('bloodIcon').className = 'on';
    for (let i = 0; i < 3; i++) setTimeout(() => { beep(55, 1.6, 'sine', 0.22); noiseBurst(1.4, 140, 'lowpass', 0.35); }, i * 1100);
  },
  update(dt) {
    if (this.bannerT > 0 && (this.bannerT -= dt) <= 0) {
      $('bloodBanner').style.opacity = 0;
      if (this.active) $('bloodIcon').className = 'on small';
    }
    if (this.active) {
      if (this.spawnT > 0 && (this.spawnT -= dt) <= 0 && director.on && !net.client) {
        bloodGus.setEnabled(true); bloodGus.state = 'chase'; bloodGus.timer = 0;
        toast('Blood Moon Gus is hunting you');
      }
      this.left -= dt;
      if (!director.on && !net.client) this.left = 0;
      // the moon can't set in the middle of its kill
      if (this.left <= 0 && bloodGus.state !== 'killing') {
        this.active = false; this.bannerT = 0;
        $('bloodBanner').style.opacity = 0; $('bloodIcon').className = '';
        if (bloodGus.enabled) bloodGus.setEnabled(false);
        toast('The blood moon sets');
      }
    } else if (!net.client && bloodGus.ready && director.on && !player.dead && $('start').style.display === 'none' && (this.timer -= dt) <= 0) {
      this.timer = 150 + Math.random() * 90;
      this.start();
    }
    // under the moon: how close it is getting
    const sense = this.active && bloodGus.enabled && !player.dead, el = $('bloodSense');
    el.style.opacity = sense ? 1 : 0;
    if (sense) {
      const b = bloodGus.body.position, p = player.body.position;
      const text = 'Blood Moon Gus knows where you are · ' + Math.round(Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z)) + ' m';
      if (el.textContent !== text) el.textContent = text;
    }
    const was = this.k;
    this.k = THREE.MathUtils.clamp(this.k + (this.active ? dt : -dt) / 3, 0, 1);
    if (this.k === was) return;
    const k = this.k, S = this.sky, R = this.red;
    scene.background.copy(S.bg).lerp(R.bg, k);
    scene.fog.color.copy(S.fog).lerp(R.fog, k);
    scene.fog.near = S.near + (R.near - S.near) * k;
    scene.fog.far = S.far + (R.far - S.far) * k;
    hemi.color.copy(S.hemi).lerp(R.hemi, k); hemi.groundColor.copy(S.ground).lerp(R.ground, k);
    hemi.intensity = S.hemiI + (R.hemiI - S.hemiI) * k;
    sun.color.copy(S.sun).lerp(R.sun, k); sun.intensity = S.sunI + (R.sunI - S.sunI) * k;
  },
};

// ---------------------------------------------------------------- the director: killers come one at a time
// None at the start. The first one comes after a short while, somewhere away from the spawn room; then one more
// joins for every 30 m you get from the spawn (the deeper you go, the more of them, the sooner, and a bit faster).
// Dying puts you back at the start and the hunt starts over. K turns the whole thing off and on.
const director = {
  on: true, depth: 0, maxDepth: 0, nextT: 25, speedK: 1, FIRST: 25,
  pool() { return killers.filter(k => !k.eventOnly && k.ready); },
  // how far the deepest player has got from the spawn
  measure() {
    let d = player.dead ? 0 : player.body.position.distanceTo(SPAWN);
    if (net.host) for (const r of net.remotes.values()) if (r.s && !r.s.dead) d = Math.max(d, Math.hypot(r.s.x - SPAWN.x, r.s.y - SPAWN.y, r.s.z - SPAWN.z));
    return d;
  },
  level() { return Math.min(this.pool().length, 1 + Math.floor(this.maxDepth / 30)); },
  update(dt) {
    if (!ready || net.client) return;
    const pool = this.pool();
    for (const k of pool) if (!k.dirSeen) { k.dirSeen = true; if (k.enabled) k.setEnabled(false); }   // wait for their turn
    this.depth = this.measure();
    this.maxDepth = Math.max(this.maxDepth, this.depth);
    this.speedK = 1 + Math.min(0.25, this.maxDepth / 400);
    this.hud();
    if (!this.on || player.dead || $('start').style.display !== 'none') return;
    const active = pool.filter(k => k.enabled);
    if (active.length >= this.level()) return;
    if ((this.nextT -= dt) > 0) return;
    const waiting = pool.filter(k => !k.enabled && k.state !== 'killing' && k.state !== 'remote');
    if (!waiting.length) return;
    const kl = waiting[Math.floor(Math.random() * waiting.length)];
    kl.setEnabled(true);
    kl.playSound('spotted', 0.35);    // heard far off: something is coming
    (net.host ? m => net.toastAll(m) : toast)('The ' + kl.name + ' is hunting you');
    this.nextT = Math.max(8, 30 - this.maxDepth / 6);
  },
  reset() {
    this.maxDepth = 0; this.nextT = this.FIRST;
    if (net.client) return;
    for (const k of this.pool()) if (k.enabled && k.state !== 'killing') k.setEnabled(false);
  },
  toggle() {
    this.on = !this.on;
    if (!this.on) for (const k of killers) if (k.ready && k.enabled && k.state !== 'killing') k.setEnabled(false);
    else this.nextT = Math.min(this.nextT, 3);
    return this.on;
  },
  hud() {
    const t = this.on ? 'Depth ' + Math.round(this.depth) + ' m · Danger ' + this.level() : 'Killers off';
    if ($('danger').textContent !== t) $('danger').textContent = t;
  },
};

// ---------------------------------------------------------------- sound settings (P, or SOUND on the start screen)
const soundPanel = {
  open: false,
  show(on) {
    this.open = on;
    $('soundPanel').style.display = on ? 'block' : 'none';
    menuOpen = on;
    if (on) {
      if (document.pointerLockElement) document.exitPointerLock();
      $('start').style.display = 'none';
      for (const c of VOL_CATS) $('vol_' + c).value = Math.round(volume[c] * 100);
      $('volMute').checked = volume.muted;
      this.labels();
    } else if (ready) { if (unlockedPlay) locked = true; else lockPointer(); }
  },
  labels() { for (const c of VOL_CATS) $('volv_' + c).textContent = Math.round(volume[c] * 100) + '%'; },
};
for (const c of VOL_CATS) $('vol_' + c).addEventListener('input', e => {
  volume[c] = e.target.value / 100; applyVolume(); soundPanel.labels();
  if (c !== 'monsters' && c !== 'ambience') beep(520, 0.08, 'sine', 0.08);   // a test blip at the new level
});
$('volMute').addEventListener('change', e => { volume.muted = e.target.checked; applyVolume(); });
$('soundClose').addEventListener('click', () => soundPanel.show(false));
$('soundOpen').addEventListener('click', e => { e.stopPropagation(); if (ready) soundPanel.show(true); });

// ---------------------------------------------------------------- security cameras (the Lethal Ape camera model)
// Up on the walls around the building. Each one sweeps left and right; when it sees you it stops, turns to follow
// you (left / right and up / down) and its light goes red. Lose it for 2 s and it goes back to sweeping.
const SECCAM_SCALE = 0.02;                              // the file is in centimetres x2: about 1 m long like this
const SECCAM_LENS = new V3(-0.04, -0.09, 0.86);         // the lens, in the pan pivot's space
const SECCAM_TILT = 0.43;                               // the lens already looks this far down
const secCams = {
  list: [], src: null, beepT: 0,
  async load() {
    const f = await new FBXLoader().loadAsync('assets/seccam/Camera.fbx');
    f.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.material = [].concat(o.material).map(m => new THREE.MeshStandardMaterial({ color: m.color, roughness: 0.55, metalness: 0.2 }));
    });
    // looks down its +Z; put its back (where the bracket meets the wall) on the pivot
    f.scale.setScalar(SECCAM_SCALE);
    f.position.z = 26 * SECCAM_SCALE;
    this.src = f;
  },
  // a wall about 3 m up, near a walkable spot: returns where to bolt the camera and which way it faces
  wallSpot(nd) {
    const up = _v1.set(nd.x, nd.y + 1.5, nd.z);
    camRay.set(up, _v2.set(0, 1, 0)); camRay.far = 8;
    const ceil = camRay.intersectObjects(staticMeshes, false)[0];
    const y = nd.y + Math.min(ceil ? ceil.distance + 1.5 - 0.6 : 3.2, 3.2);
    let best = null;
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2, dir = new V3(Math.sin(a), 0, Math.cos(a));
      camRay.set(new V3(nd.x, y, nd.z), dir); camRay.far = 5;
      const hit = camRay.intersectObjects(staticMeshes, false)[0];
      if (!hit || !hit.face || (best && hit.distance > best.hit.distance)) continue;
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (Math.abs(n.y) > 0.3) continue;                   // a wall, not a slope
      best = { hit, n };
    }
    if (!best) return null;
    const n = best.n.setY(0).normalize();
    return { pos: best.hit.point.clone().addScaledVector(n, 0.04), yaw: Math.atan2(n.x, n.z) };
  },
  make(spot) {
    const base = new THREE.Group(); base.position.copy(spot.pos); base.rotation.y = spot.yaw;
    const pan = new THREE.Group(), tilt = new THREE.Group();
    base.add(pan); pan.add(tilt); tilt.add(this.src.clone());
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: '#3f6' }));
    led.position.set(0.12, 0.3, 0.72); tilt.add(led);
    scene.add(base);
    const c = { base, pan, tilt, led, phase: Math.random() * Math.PI * 2, speed: 0.6 + Math.random() * 0.3, yaw: 0, pitch: 0, seeT: 0, lookT: 0, sees: false };
    this.list.push(c);
    return c;
  },
  // one right by the spawn (so you meet one straight away), the rest spread over the building
  placeAll(count = 16) {
    const spawn = player.body.position, spots = [];
    const tryNode = nd => {
      if (!nd || spots.some(s => s.pos.distanceTo(_v3.set(nd.x, nd.y, nd.z)) < 18)) return false;
      const s = this.wallSpot(nd); if (!s) return false;
      spots.push(s); return true;
    };
    const near = nav.nodes.filter(n => Math.hypot(n.x - spawn.x, n.z - spawn.z) < 9 && Math.abs(n.y - spawn.y) < 1).sort(() => Math.random() - 0.5);
    for (const nd of near) if (tryNode(nd)) break;
    for (let i = 0; i < 400 && spots.length < count; i++) tryNode(nav.random(n => n.open > 15));
    for (const s of spots) this.make(s);
  },
  update(dt) {
    if (!this.list.length) return;
    const eye = _v1.set(apeRoot.position.x, apeRoot.position.y + 1.3, apeRoot.position.z);
    this.beepT -= dt;
    for (const c of this.list) {
      // where are you, seen from this camera's mount?
      const local = c.base.worldToLocal(_v2.copy(eye));
      const aYaw = Math.atan2(local.x, local.z), flat = Math.hypot(local.x, local.z), dist = local.length();
      if ((c.lookT -= dt) <= 0) {
        c.lookT = 0.12;
        c.sees = false;
        if (!player.dead && apeRoot.visible && dist < 28 && Math.abs(aYaw) < 1.35 && Math.abs(aYaw - c.yaw) < 0.75) {
          const lens = c.tilt.localToWorld(_v3.copy(SECCAM_LENS));
          const to = eye.clone().sub(lens), L = to.length();
          camRay.set(lens, to.normalize()); camRay.far = L;
          c.sees = camRay.intersectObjects(staticMeshes, false).length === 0;
        }
        if (c.sees) {
          if (c.seeT <= 0 && this.beepT <= 0) { beep(1400, 0.08, 'square', 0.04); setTimeout(() => beep(1000, 0.1, 'square', 0.04), 110); this.beepT = 1.5; }
          c.seeT = 2;
        }
      }
      c.seeT -= dt;
      let wantYaw, wantPitch;
      if (c.seeT > 0) {
        // watching you: turn and tilt to keep you in the middle
        wantYaw = THREE.MathUtils.clamp(aYaw, -1.3, 1.3);
        wantPitch = THREE.MathUtils.clamp(Math.atan2(-local.y, flat) - SECCAM_TILT, -0.6, 0.9);
      } else {
        // sweeping the room
        c.phase += dt * c.speed;
        wantYaw = Math.sin(c.phase) * 0.95; wantPitch = 0;
      }
      const k = 1 - Math.exp(-(c.seeT > 0 ? 7 : 2.5) * dt);
      c.yaw += (wantYaw - c.yaw) * k; c.pitch += (wantPitch - c.pitch) * k;
      c.pan.rotation.y = c.yaw; c.tilt.rotation.x = c.pitch;
      c.led.material.color.set(c.seeT > 0 ? '#ff2a1a' : '#3f6');
    }
  },
};

// ---------------------------------------------------------------- online: play with friends
// One player hosts and gets a room code; friends type it in (or open the ?join= link). Everyone sees everyone's ape
// (name, colour, face, hat, every arm and head move) and the host's killers hunt all of you: the closest player
// they can reach. Connections are peer to peer (WebRTC through the free PeerJS server), so no game server is needed.
const NET_PREFIX = 'apesbx-';
const NET_KILL_STATES = ['cooldown', 'chase', 'stunned', 'killing', 'remote'];
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
const net = {
  peer: null, host: false, client: false, code: '', conns: new Map(), hostConn: null, myId: '',
  remotes: new Map(), sendT: 0, lookT: 0, lookJSON: '', panelOpen: false, roster: [],
  get on() { return this.host || this.client; },
  async lib() {
    if (!this.Peer) this.Peer = (await import('https://cdn.jsdelivr.net/npm/peerjs@1.5.4/+esm')).Peer;
    return this.Peer;
  },
  look() { return { name: save.name || 'GORILLA', color: save.color || [9, 9, 9], face: save.face || 0, hat: save.hat ?? -1 }; },
  status(text) { $('netStatus').textContent = text; },
  // ---- hosting
  async hostGame() {
    if (this.on || this.busy) return;
    this.busy = true;
    this.status('Making a room…');
    const Peer = await this.lib().catch(() => null);
    if (!Peer) { this.busy = false; return this.status('Could not load the online code (no internet?)'); }
    const code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
    const peer = this.peer = new Peer(NET_PREFIX + code);
    peer.on('open', () => {
      this.busy = false;
      this.host = true; this.code = code; this.myId = 'host';
      this.status('Room open. Tell your friends the code.');
      this.lookJSON = JSON.stringify(this.look());
      this.sendRoster();
      toast('Room ' + code + ' is open');
    });
    peer.on('connection', c => this.addClient(c));
    peer.on('error', err => {
      console.warn('[net]', err);
      if (this.host) return;
      this.busy = false; peer.destroy(); this.peer = null;
      if (err.type === 'unavailable-id') return this.hostGame();
      this.status('Could not open a room: ' + err.type);
    });
  },
  addClient(c) {
    c.on('open', () => { this.conns.set(c.peer, c); });
    c.on('data', m => this.onHostData(c, m));
    const gone = () => {
      if (!this.conns.has(c.peer)) return;
      const r = this.remotes.get(c.peer);
      this.conns.delete(c.peer);
      if (r) toast(r.look.name + ' left');
      this.removeRemote(c.peer);
      this.sendRoster();
    };
    c.on('close', gone); c.on('error', gone);
  },
  onHostData(c, m) {
    if (m.t === 'hi') {
      const isNew = !this.remotes.has(c.peer);
      this.setRemote(c.peer, m.look);
      if (isNew) this.toastAll(m.look.name + ' joined');
      this.sendRoster();
    } else if (m.t === 'p') {
      const r = this.remotes.get(c.peer); if (r) { r.s = m.s; r.seen = performance.now(); }
    } else if (m.t === 'cmd') {
      const who = this.remotes.get(c.peer)?.look.name || 'Someone';
      if (m.c === 'KeyK') { const on = director.toggle(); this.toastAll(who + (on ? ' turned the killers on' : ' turned the killers off')); }
      if (m.c === 'KeyB') { bloodMoon.toggle(); this.toastAll(who + ' pressed the blood moon'); }
    }
  },
  sendRoster() {
    const list = [{ id: 'host', look: this.look() }, ...[...this.remotes].map(([id, r]) => ({ id, look: r.look }))];
    this.roster = list;
    for (const c of this.conns.values()) if (c.open) c.send({ t: 'roster', list });
    this.showRoom();
  },
  toastAll(text) { toast(text); for (const c of this.conns.values()) if (c.open) c.send({ t: 'toast', text }); },
  // a killer reached someone who joined: their screen plays the kill
  killed(id, kl) {
    const r = this.remotes.get(id), c = this.conns.get(id);
    if (r) { r.dead = true; if (r.s) r.s.dead = 1; }
    if (c?.open) c.send({ t: 'die', k: killers.indexOf(kl) });
    this.toastAll((r ? r.look.name : 'Someone') + ' got caught by the ' + kl.name);
  },
  // the closest player a killer can get to (you, or anyone who joined)
  pickTarget(from) {
    const me = { p: player.body.position, local: true, reach: !player.dead && !shop.isSafe() };
    let best = me.reach ? me : null, bestD = best ? Math.hypot(me.p.x - from.x, me.p.z - from.z) : Infinity;
    for (const [id, r] of this.remotes) {
      if (!r.s || r.s.dead || r.s.safe || r.dead) continue;
      const d = Math.hypot(r.s.x - from.x, r.s.z - from.z);
      if (d < bestD) { bestD = d; best = { p: { x: r.s.x, y: r.s.y, z: r.s.z }, local: false, id, reach: true }; }
    }
    return best || me;
  },
  // ---- joining
  async join(code) {
    code = (code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) return this.status('Type the room code first');
    if (this.on || this.busy) return;
    this.busy = true;
    this.status('Joining ' + code + '…');
    const Peer = await this.lib().catch(() => null);
    if (!Peer) { this.busy = false; return this.status('Could not load the online code (no internet?)'); }
    const peer = this.peer = new Peer();
    const fail = msg => { this.busy = false; this.leave(true); this.status(msg); };
    peer.on('open', id => {
      this.myId = id;
      const c = this.hostConn = peer.connect(NET_PREFIX + code, { reliable: true });
      const timer = setTimeout(() => { if (!this.client) fail('No room with code ' + code); }, 15000);
      c.on('open', () => {
        clearTimeout(timer);
        this.busy = false; this.client = true; this.code = code; this.hostSeen = performance.now();
        c.send({ t: 'hi', look: this.look() }); this.lookJSON = JSON.stringify(this.look());
        this.status('Joined room ' + code);
        toast('Joined room ' + code + ': the host\'s killers hunt everyone');
        for (const kl of killers) kl.netS = null;
        this.showRoom();
        setTimeout(() => { if (this.panelOpen) this.openPanel(false); }, 1200);
      });
      c.on('data', m => this.onClientData(m));
      c.on('close', () => { if (this.client) { toast('The host left the game'); this.leave(); } });
    });
    peer.on('error', err => {
      console.warn('[net]', err);
      if (this.client) return;
      fail(err.type === 'peer-unavailable' ? 'No room with code ' + code : 'Could not join: ' + err.type);
    });
  },
  joinFromPanel() { this.join($('netCode').value); },
  onClientData(m) {
    if (m.t === 'roster') {
      this.roster = m.list;
      const ids = new Set(m.list.map(e => e.id));
      for (const id of [...this.remotes.keys()]) if (!ids.has(id)) this.removeRemote(id);
      for (const e of m.list) if (e.id !== this.myId) this.setRemote(e.id, e.look);
      this.showRoom();
    } else if (m.t === 's') {
      this.hostSeen = performance.now();
      for (const id in m.ps) { const r = this.remotes.get(id); if (r && id !== this.myId) r.s = m.ps[id]; }
      m.ks.forEach((k, i) => {
        const kl = killers[i]; if (!kl) return;
        kl.netS = k ? { en: k[0], x: k[1], y: k[2], z: k[3], yaw: k[4], sp: k[5], st: NET_KILL_STATES[k[6]] || 'chase', al: k[7], vis: k[8], vx: k[9], vz: k[10] } : null;
      });
      if (m.moon && !bloodMoon.active) bloodMoon.start();
      else if (!m.moon && bloodMoon.active) bloodMoon.left = 0;
    } else if (m.t === 'die') {
      const kl = killers[m.k];
      if (kl && kl.ready && !player.dead && kl.state !== 'killing') kl.startKill();
    } else if (m.t === 'toast') toast(m.text);
  },
  send(m) { if (this.hostConn?.open) this.hostConn.send(m); },
  leave(quiet) {
    const wasClient = this.client;
    this.host = this.client = false; this.code = '';
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    this.hostConn = null;
    if (this.peer) { this.peer.destroy(); this.peer = null; }
    for (const id of [...this.remotes.keys()]) this.removeRemote(id);
    this.roster = [];
    if (wasClient) for (const kl of killers) if (kl.ready && kl.state !== 'killing') { kl.netS = null; if (kl.enabled) { kl.place(); kl.state = 'cooldown'; kl.timer = 3; } }
    if (!quiet) this.status('Playing alone');
    this.showRoom();
  },
  // ---- other players' apes
  setRemote(id, look) {
    let r = this.remotes.get(id);
    if (!r) {
      const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
      const ape = SkeletonUtils.clone(apeSource);
      ape.traverse(o => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); });
      body.add(ape);
      const R = buildRig(ape, root);                 // same bones in the same order as mine
      const bones = [...R.local0.keys()];
      const hat = ape.getObjectByName('hatHolder');  // the copy brings a hat holder along from my ape
      if (hat) { hat.clear(); hat.visible = true; }   // (mine is hidden in first person)
      const tc = document.createElement('canvas'); tc.width = 512; tc.height = 96;
      const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(tc), depthWrite: false }));
      tag.material.map.colorSpace = THREE.SRGBColorSpace; tag.userData.canvas = tc;
      tag.scale.set(1.6, 0.3, 1); tag.position.y = APE_HEIGHT + 0.45;
      root.add(tag);
      root.visible = false;
      scene.add(root);
      r = { id, root, body, ape, bones, hat, tag, s: null, look: null, hatShown: -2 };
      this.remotes.set(id, r);
    }
    if (JSON.stringify(look) === JSON.stringify(r.look)) return;
    r.look = look;
    const col = rgbOf(look.color);
    r.ape.traverse(o => { if (o.isMesh) for (const m of [].concat(o.material)) if (!/_2$/.test(m.name)) m.color.copy(col); });
    setFace(r.ape, look.face);
    const tc = r.tag.userData.canvas, g = tc.getContext('2d');
    g.clearRect(0, 0, tc.width, tc.height);
    g.font = 'bold 64px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = '#000'; g.strokeText(look.name, 256, 50);
    g.fillStyle = '#fff'; g.fillText(look.name, 256, 50);
    r.tag.material.map.needsUpdate = true;
    r.hatShown = -2;
  },
  removeRemote(id) {
    const r = this.remotes.get(id); if (!r) return;
    scene.remove(r.root);
    r.root.traverse(o => { if (o.isMesh || o.isSprite) [].concat(o.material).forEach(m => m.dispose()); });
    this.remotes.delete(id);
  },
  // my ape, packed small
  myState() {
    const p = player.body.position, q = [];
    for (const b of rig.local0.keys()) q.push(r3(b.quaternion.x), r3(b.quaternion.y), r3(b.quaternion.z), r3(b.quaternion.w));
    return {
      x: r2(p.x), y: r2(p.y), z: r2(p.z), yaw: r3(player.faceYaw),
      by: r3(apeBody.position.y), bx: r3(apeBody.rotation.x), bz: r3(apeBody.rotation.z), q,
      dead: player.dead ? 1 : 0, safe: shop.isSafe() ? 1 : 0, vis: apeRoot.visible && !player.dead ? 1 : 0,
    };
  },
  // 15 times a second on its own timer, so it keeps going (slower) while the game's tab is hidden
  tick() {
    if (!this.on || !ready) return;
    // my look changed (computer, shop): tell the others
    if ((this.lookT -= 1 / 15) <= 0) {
      this.lookT = 1;
      const j = JSON.stringify(this.look());
      if (j !== this.lookJSON) { this.lookJSON = j; if (this.client) this.send({ t: 'hi', look: this.look() }); else this.sendRoster(); }
    }
    {
      const me = this.myState();
      if (this.client) this.send({ t: 'p', s: me });
      else if (this.conns.size) {
        const ps = { host: me };
        for (const [id, r] of this.remotes) if (r.s) ps[id] = r.s;
        const ks = killers.map(kl => kl.ready ? [kl.enabled ? 1 : 0, r2(kl.body.position.x), r2(kl.body.position.y), r2(kl.body.position.z), r3(kl.yaw),
          r2(kl.netSpeed || 0), Math.max(0, NET_KILL_STATES.indexOf(kl.state)), kl.alerted ? 1 : 0, kl.holder.visible ? 1 : 0, r2(kl.body.velocity.x), r2(kl.body.velocity.z)] : null);
        const msg = { t: 's', ps, ks, moon: bloodMoon.active ? 1 : 0 };
        for (const c of this.conns.values()) if (c.open) c.send(msg);
      }
    }
    // nothing heard for a while: they closed the game without saying bye
    const now = performance.now();
    if (this.client && now - this.hostSeen > 20000) { toast('Lost the host'); this.leave(); return; }
    if (this.host) for (const [id, r] of [...this.remotes]) if (r.seen && now - r.seen > 20000) { this.conns.get(id)?.close(); this.conns.delete(id); toast(r.look.name + ' left'); this.removeRemote(id); this.sendRoster(); }
  },
  update(dt) {
    if (!this.on) return;
    // move the other apes toward where they are
    const k = 1 - Math.exp(-14 * dt);
    for (const r of this.remotes.values()) {
      const s = r.s;
      if (!s) continue;
      if (r.dead && !s.dead) r.dead = false;
      const R = r.root;
      if (!R.visible || R.position.distanceTo(_v1.set(s.x, s.y, s.z)) > 6) R.position.set(s.x, s.y, s.z);
      else R.position.lerp(_v1.set(s.x, s.y, s.z), k);
      let d = s.yaw - R.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); R.rotation.y += d * k;
      r.body.position.y += (s.by - r.body.position.y) * k;
      r.body.rotation.x += (s.bx - r.body.rotation.x) * k; r.body.rotation.z += (s.bz - r.body.rotation.z) * k;
      for (let i = 0; i < r.bones.length && i * 4 + 3 < s.q.length; i++)
        r.bones[i].quaternion.slerp(_q1.set(s.q[i * 4], s.q[i * 4 + 1], s.q[i * 4 + 2], s.q[i * 4 + 3]), k);
      R.visible = !!s.vis;
      if (r.hat && hats.loaded && r.hatShown !== r.look.hat) {
        r.hatShown = r.look.hat; r.hat.clear();
        if (r.look.hat >= 0 && hats.templates[r.look.hat]) r.hat.add(hats.templates[r.look.hat].clone());
      }
    }
  },
  // ---- the panel (O key, or the button on the start screen)
  openPanel(on) {
    this.panelOpen = on;
    $('netPanel').style.display = on ? 'block' : 'none';
    menuOpen = on;
    if (on) { if (document.pointerLockElement) document.exitPointerLock(); $('start').style.display = 'none'; this.showRoom(); }
    else if (ready) { if (unlockedPlay) locked = true; else lockPointer(); }
  },
  showRoom() {
    const on = this.on;
    $('netStart').style.display = on ? 'none' : '';
    $('netRoom').style.display = on ? '' : 'none';
    $('netCodeBig').textContent = this.code;
    $('netLink').textContent = this.host ? location.origin + location.pathname + '?join=' + this.code : '';
    $('netCopy').style.display = this.host ? '' : 'none';
    $('netPlayers').innerHTML = this.roster.map(e => '<div>' + (e.id === 'host' ? '👑 ' : '🦍 ') + String(e.look.name).replace(/[<>&"]/g, '') + (e.id === this.myId ? ' (you)' : '') + '</div>').join('');
    $('netBadge').style.display = on ? '' : 'none';
    $('netBadge').textContent = on ? 'ONLINE · ' + this.code + ' · ' + Math.max(1, this.roster.length) + (this.roster.length === 1 ? ' player' : ' players') + ' · O' : '';
  },
  autoJoin() {
    const code = new URLSearchParams(location.search).get('join');
    if (code) { $('netCode').value = code.toUpperCase(); this.openPanel(true); this.join(code); }
  },
};
$('netHost').addEventListener('click', () => net.hostGame());
$('netJoin').addEventListener('click', () => net.joinFromPanel());
$('netLeave').addEventListener('click', () => { net.leave(); toast('Playing alone again'); });
$('netClose').addEventListener('click', () => net.openPanel(false));
$('netCopy').addEventListener('click', () => { navigator.clipboard?.writeText($('netLink').textContent).then(() => toast('Link copied')).catch(() => {}); });
setInterval(() => net.tick(), 1000 / 15);
$('netOpen').addEventListener('click', e => { e.stopPropagation(); if (ready) net.openPanel(true); });

// ---------------------------------------------------------------- main loop
let ready = false;
const clock = new THREE.Clock();
let time = 0;
const perf = { physics: 0, logic: 0, frame: 0 };   // last frame's cost in ms
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05); time += dt;
  const t0 = performance.now();
  pad.update(dt);
  vr.input(dt);
  updatePlayer(dt);
  tools.preStep();
  antiTunnel.before();
  world.step(1 / 60, dt, 4);
  antiTunnel.after();
  perf.physics = performance.now() - t0;
  for (const p of props.slice()) { syncProp(p); if (p.body.position.y < FALL_Y) removeProp(p, false); }
  updateEffects(dt);
  const bp = player.body.position;
  apeRoot.position.set(bp.x, bp.y, bp.z);
  if (!killers.some(kl => kl.state === 'killing')) updateCamera();
  animateApe(dt, time);
  for (const kl of killers) kl.update(dt);
  ragdolls.update();
  footsteps.update(dt);
  dread.update(dt);
  bloodMoon.update(dt);
  director.update(dt);
  secCams.update(dt);
  net.update(dt);
  stick.update(dt);
  shop.update(dt, time);
  if (computer.tag) computer.tag.visible = player.thirdPerson && apeRoot.visible;   // your own name: third person only
  if (hats.player) hats.player.holder.visible = player.thirdPerson && !vr.on;     // your own hat too: it would hang over your eyes
  coinPickups.update(dt, time);
  blood.update(dt);
  tools.updateBeam(time);
  sun.position.set(bp.x + 30, bp.y + 60, bp.z + 20); sun.target.position.set(bp.x, bp.y, bp.z);
  $('health').textContent = player.health;
  perf.logic = performance.now() - t0 - perf.physics;
  vr.preRender();
  renderer.render(scene, camera);
  vr.postRender();
  perf.frame = performance.now() - t0;
}

// put a prop on a walk-graph node (standing on the floor), optionally turned
function placePropAt(kind, nd, yaw = 0) {
  const p = makeProp(kind); if (!p) return null;
  p.body.quaternion.setFromEuler(0, yaw, 0);
  p.body.position.set(nd.x, nd.y + propHalfHeight(p) + 0.05, nd.z);
  syncProp(p);
  return p;
}
// spawn in the most open room; the shop goes in another big room nearby
function layoutWorld() {
  const N = nav.nodes;
  const spawn = N.reduce((a, b) => (b.open > a.open ? b : a));
  SPAWN.set(spawn.x, spawn.y + 0.1, spawn.z);
  player.body.position.copy(SPAWN);
  const away = (nd, lo, hi) => { const d = Math.hypot(nd.x - spawn.x, nd.z - spawn.z); return d > lo && d < hi && Math.abs(nd.y - spawn.y) < 1.5; };
  const shopNd = N.filter(nd => nd.open >= 45 && away(nd, 12, 45)).sort((a, b) => b.open - a.open)[0]
    || N.filter(nd => away(nd, 9, 60)).sort((a, b) => b.open - a.open)[0] || spawn;
  shop.C.set(shopNd.x - 0.9, shopNd.y, shopNd.z);

  // a few props to play with right away, around the spawn
  const near = N.filter(nd => away(nd, 2.5, 8) && nd.open > 30);
  const pick = () => near.splice(Math.floor(Math.random() * near.length), 1)[0];
  for (const k of ['crate', 'crate', 'barrel', 'explosive barrel', 'explosive barrel', 'beach ball', 'ape statue', 'shelf']) { const nd = pick(); if (nd) placePropAt(k, nd, Math.random() * Math.PI); }
  const spk = pick(); if (spk) placePropAt('speaker', spk, Math.atan2(spawn.x - spk.x, spawn.z - spk.z));
  // the name & colour computer, keyboard facing the spawn point
  const pcNd = N.filter(nd => away(nd, 4, 9) && nd.open >= 40).sort((a, b) => b.open - a.open)[0] || pick();
  if (pcNd) computer.place(pcNd, spawn);
  // shelves stand around the corridors; the killers barge them out of the way
  for (let i = 0; i < 16; i++) {
    const nd = nav.random(n => n.open > 12 && n.open < 40 && Math.hypot(n.x - spawn.x, n.z - spawn.z) > 8);
    placePropAt('shelf', nd, Math.random() < 0.5 ? 0 : Math.PI / 2);
  }
  // two more speakers somewhere in the building
  for (let i = 0; i < 2; i++) placePropAt('speaker', nav.random(n => n.open > 30 && Math.hypot(n.x - spawn.x, n.z - spawn.z) > 30), Math.random() * Math.PI * 2);
  updateCount();
}

Promise.all([loadApe(), loadMap(), loadPropModels()]).then(() => computer.load()).then(() => {
  ready = true;
  $('loading').style.display = 'none';
  $('start').style.display = 'flex';
  layoutWorld();
  // face pack, shop, coins
  setFace(apeSource, save.face);
  shop.build();
  shop.initNpc();
  coinPickups.spawnAll(30);
  updateCoins();
  if (save.owned.includes('stick')) giveStickTool();
  window.__ape = { rig, player, props, apeRoot, camera, tools, killers, shop, save, stick, nav, perf, computer, footsteps, dread, pad, ragdolls, bloodMoon, touch, vr, xrRig, secCams, hats, net, director, volume, applyVolume, soundPanel, antiTunnel };
  net.autoJoin();
  const extras = stick.load().then(() => shop.attachStick()).catch(err => { console.error(err); toast('Stick failed to load: ' + err.message); });
  const cams = secCams.load().then(() => secCams.placeAll()).catch(err => { console.error(err); toast('Cameras failed to load: ' + err.message); });
  const hatsReady = hats.load().then(() => hats.wearAll()).catch(err => { console.error(err); toast('Hats failed to load: ' + err.message); });
  // the kills with a victim of their own put your hat on it (the kills that use your ragdoll already carry it)
  const dressVictim = kl => {
    const k = kl.kill, head = k && (k.hatHead || k.head);
    if (!head || !k.dir0) return;
    const w = hats.register(head, new V3(-k.dir0.x, 0, -k.dir0.z).normalize());
    if (w && hats.loaded) hats.dress(w);
  };
  return Promise.all([extras, cams, hatsReady, ...killers.map(kl => kl.load().then(() => dressVictim(kl)).catch(err => { console.error(err); toast(kl.name + ' failed to load: ' + err.message); }))]);
}).catch(err => {
  console.error(err);
  $('loading').textContent = 'Could not load the game: ' + err.message;
});
renderer.setAnimationLoop(frame);     // runs on the headset's clock in VR, like requestAnimationFrame otherwise
