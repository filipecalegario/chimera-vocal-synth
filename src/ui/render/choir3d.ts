/**
 * The choir stage in 3D, drawn as the face screen draws its head: glowing beams on black
 * (beams3d.ts), no solids. Each singer's head is the face screen's own (Anatomy3D: the skin, the
 * airway with its pressure and airflow, the tongue, the velum, the larynx and the folds), drawn in
 * its own scene with a camera kept where the stage's is, so it sits on the singer's robe. What
 * tells the singers apart (a hat, glasses, a beard, a moustache) is drawn round it in their own
 * control colour, placed from the head's eyes, lips and crown; sound leaves the mouths as amber
 * rings. Lines on a robe's or hat's far side are dimmed, so the wireframe reads front from back.
 *
 * From the voice: the head moves as on the face screen (the articulators, the lids, brows and
 * nods); loudness sends out the rings; the beat sways the bodies; the tenor's beard drops with
 * his jaw, the bass's moustache lifts as he opens, the soprano's propeller spins as loud as she
 * sings.
 */
import * as THREE from "three";
import { Beams } from "./beams3d.ts";
import { Anatomy3D } from "./anatomy3d.ts";
import { V, core } from "../colors.ts";
import type { ViewFlags } from "./anatomy.ts";
import type { VoiceModel } from "../analysis.ts";
import type { HumanArtic } from "../../wasm/engine.ts";
import type { TelemetryMessage } from "../../worklet/protocol.ts";

export type Look = "propeller" | "sunhat" | "viking" | "tophat" | "padre" | "compadecida" | "gonzaga" | "lampiao";

export interface SingerSpec {
  look: Look;
  /** the singer's control colour: what they wear, their words */
  color: string;
  /** the voice's body, as the face screen models it */
  model: VoiceModel;
}

/** what a singer does this frame */
export interface SingerInput {
  /** null while paused: the head holds `artic`, the voice at rest */
  tele: TelemetryMessage | null;
  artic: HumanArtic;
  /** beats since the downbeat (fractional) */
  beat: number;
  /** bumped by a seek: the head forgets its motion */
  epoch: number;
}

const TAU = Math.PI * 2;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const approach = (x: number, to: number, rate: number, dt: number) => x + (to - x) * (1 - Math.exp(-rate * dt));

// ---- shapes, as flat xyz arrays in a part's own frame

/** an ellipse in the xz plane (a ring round y) or the xy plane (facing the viewer), over [a0, a1] */
function ellipse(cx: number, cy: number, cz: number, rx: number, ry: number, plane: "xz" | "xy", n = 32, a0 = 0, a1 = TAU): number[] {
  const p: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n, c = Math.cos(a), s = Math.sin(a);
    if (plane === "xz") p.push(cx + rx * c, cy, cz + ry * s);
    else p.push(cx + rx * c, cy + ry * s, cz);
  }
  return p;
}

/** a surface of revolution's wireframe: rings at the profile's points (every `every`th) and `m` meridians */
function lathe(profile: [number, number][], m: number, every = 1): number[][] {
  const out: number[][] = [];
  profile.forEach(([r, y], i) => {
    if (r > 0.02 && i % every === 0) out.push(ellipse(0, y, 0, r, r, "xz", 40));
  });
  for (let k = 0; k < m; k++) {
    const a = (k / m) * TAU, c = Math.cos(a), s = Math.sin(a);
    out.push(profile.flatMap(([r, y]) => [r * c, y, r * s]));
  }
  return out;
}

/** a sphere's (or a dome's) profile, from the top down to polar angle `to` */
function sphereProfile(r: number, sy: number, to = Math.PI, n = 7): [number, number][] {
  const p: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = (to * i) / n;
    p.push([r * Math.sin(t), r * sy * Math.cos(t)]);
  }
  return p;
}

const ROBE: [number, number][] = [[0.78, 0], [0.72, 0.4], [0.6, 0.9], [0.5, 1.3], [0.38, 1.55], [0.2, 1.68]];
const ROBE_LINES = lathe(ROBE, 10);
const DOME = (r: number, sy: number) => lathe(sphereProfile(r, sy, Math.PI / 2, 4), 8);
const CYL = (r0: number, r1: number, h: number, m = 10) => lathe([[r0, 0], [r1, h]], m);

/** the robe's radius at height y */
function robeR(y: number): number {
  for (let i = 1; i < ROBE.length; i++) {
    const [r0, y0] = ROBE[i - 1], [r1, y1] = ROBE[i];
    if (y <= y1) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
  }
  return ROBE[ROBE.length - 1][0];
}

/** a point on the robe's surface: across (x) at height y, on its front */
const onRobe = (x: number, y: number, out = 0.015): [number, number, number] => {
  const r = robeR(y) + out;
  return [x, y, Math.sqrt(Math.max(0, r * r - x * x))];
};

/** a star of `n` points (n = 6: Solomon's seal, two triangles) facing +z */
function star(cx: number, cy: number, cz: number, r: number, n: number): number[][] {
  if (n === 6) return [0, Math.PI].map((a0) => ellipse(cx, cy, cz, r, r, "xy", 3, Math.PI / 2 + a0, Math.PI / 2 + a0 + TAU));
  const p: number[] = [];
  for (let i = 0; i <= 2 * n; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / n, rr = i % 2 ? 0.45 * r : r;
    p.push(cx + rr * Math.cos(a), cy + rr * Math.sin(a), cz);
  }
  return [p];
}

/** a brim whose front (and back) turn up: the leather hats of the sertão; `front`, `back` how far */
function brim(R: number, depth: number, front: number, back: number): number[] {
  const p: number[] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * TAU, sa = Math.sin(a);
    p.push(R * Math.cos(a), front * Math.max(0, sa) ** 2 + back * Math.max(0, -sa) ** 2, depth * sa);
  }
  return p;
}

/** Draws polylines through a part's matrix, dimming the segments behind a reference point. */
class Pen {
  readonly M = new THREE.Matrix4();
  private readonly cam = new THREE.Vector3();
  private refD = 0;
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();

  constructor(readonly beams: Beams) {}

  /** the camera, and the point past which lines count as the far side */
  view(camera: THREE.Camera, ref: THREE.Vector3): void {
    this.cam.copy(camera.position);
    this.refD = ref.distanceTo(this.cam);
  }

  line(p: number[], color: string, width: number, o: { close?: boolean; hot?: boolean; alpha?: number; flat?: boolean } = {}): void {
    const n = p.length / 3, al = o.alpha ?? 1;
    const hot = o.hot ? core(color) : null;
    const segs = o.close ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = 3 * i, k = 3 * ((i + 1) % n);
      this.a.set(p[j], p[j + 1], p[j + 2]).applyMatrix4(this.M);
      this.b.set(p[k], p[k + 1], p[k + 2]).applyMatrix4(this.M);
      let alpha = al;
      if (!o.flat && 0.5 * (this.a.distanceTo(this.cam) + this.b.distanceTo(this.cam)) > this.refD + 0.02) alpha *= 0.22;
      this.beams.seg(this.a.x, this.a.y, this.a.z, this.b.x, this.b.y, this.b.z, color, width, alpha);
      if (hot) this.beams.seg(this.a.x, this.a.y, this.a.z, this.b.x, this.b.y, this.b.z, hot, width * 0.42, alpha);
    }
  }

  lines(ps: number[][], color: string, width: number, o: { hot?: boolean; alpha?: number; flat?: boolean } = {}): void {
    for (const p of ps) this.line(p, color, width, o);
  }
}

/** the heads as the duet draws them: pressure and airflow in the airway, no measurements */
const VIEW: ViewFlags = { pressure: true, particles: true, grid: false, calipers: false };
/** how high each hat reaches above the crown (head units) */
const HAT_TOP: Record<Look, number> = { propeller: 0.3, sunhat: 0.3, viking: 0.5, tophat: 0.75, padre: 0.25, compadecida: 0.55, gonzaga: 0.45, lampiao: 0.55 };
/** hats are drawn at this size in the head frame (the skull is narrower than the crown is high) */
const HAT = 0.66;

class Singer {
  /** the face screen's head, drawn in its own scene (body cm) with a camera kept on the stage's */
  readonly anat = new Anatomy3D();
  private readonly model: VoiceModel;
  private readonly lm: ReturnType<Anatomy3D["landmarks"]>;
  /** body cm per stage unit, and per head unit (the head frame: the crown at y 0.62, the face to +z) */
  private readonly U: number;
  private readonly Uh: number;
  /** the robe's size (a child's is smaller) */
  private readonly k: number;
  private readonly root = new THREE.Matrix4();
  private readonly bodyM = new THREE.Matrix4();
  /** body cm → stage */
  private readonly anatM = new THREE.Matrix4();
  /** head frame → stage, turning with the head */
  private readonly headM = new THREE.Matrix4();
  private readonly partM = new THREE.Matrix4();
  private readonly localM = new THREE.Matrix4();
  private readonly inv = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly ref = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  /** the eyes and the mouth in the head frame */
  private readonly eyes: THREE.Vector3[];
  private readonly mouth = new THREE.Vector3();
  /** the syllable's place over the hat, on the stage */
  readonly label = new THREE.Vector3();
  private epoch = -1;
  // smoothed state
  private open = 0.05;
  private loud = 0;
  private ringIn = 0;
  private spin = 0;
  /** the accordion's bellows: their phase, going round faster the louder he sings */
  private bellows = 0;
  private readonly rings: number[] = [9, 9, 9, 9, 9, 9];
  private readonly phase: number;

  constructor(readonly spec: SingerSpec, index: number, x: number, z: number, yaw: number) {
    this.phase = index * 1.3;
    this.model = spec.model;
    this.k = spec.model.tract.scale;
    this.lm = this.anat.landmarks(this.model);
    this.anat.centred = true;
    const { center: c, top, bottom } = this.lm;
    this.U = (top - bottom) / (2.1 * this.k);
    this.Uh = (top - c.y) / 0.62;
    this.eyes = this.lm.eyes.map((p) => this.toHead(p[0], p[1], p[2], new THREE.Vector3()));
    this.root.compose(this.v.set(x, 0, z), this.q.setFromEuler(this.e.set(0, yaw, 0)), this.one);
  }

  /** a body-cm point (rest pose) in the head frame */
  private toHead(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const c = this.lm.center;
    return out.set(-(z - c.z) / this.Uh, (y - c.y) / this.Uh, (x - c.x) / this.Uh);
  }

  /** a part's matrix: `parent` · translate · rotate · scale (shared: copy it before making another) */
  private part(parent: THREE.Matrix4, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1): THREE.Matrix4 {
    this.localM.compose(this.v.set(x, y, z), this.q.setFromEuler(this.e.set(rx, ry, rz)), this.sc.setScalar(s));
    return this.partM.multiplyMatrices(parent, this.localM);
  }

  /** the singer's frame for this moment, and the head's camera put where the stage's is */
  place(inp: SingerInput, dt: number, now: number, camera: THREE.PerspectiveCamera): void {
    if (inp.epoch !== this.epoch) {
      this.epoch = inp.epoch;
      this.anat.resetMotion();
    }
    const t = inp.tele?.t;
    const a = inp.artic;
    const sounding = !!t && t.gate > 0.2 && t.outRms > 0.01;
    const openT = clamp01((a.lipAp - 0.02) / 1.8) * (0.45 + 0.55 * clamp01((a.jaw - 0.1) / 1.5));
    const loudT = sounding ? clamp01(t!.outRms / 0.35) : 0;
    this.open = approach(this.open, openT, 30, dt);
    this.loud = approach(this.loud, loudT, loudT > this.loud ? 25 : 6, dt);
    if (this.spec.look === "propeller") this.spin += dt * (1.5 + 30 * this.loud);
    if (this.spec.look === "gonzaga") this.bellows += dt * (inp.tele ? 1.2 + 3 * this.loud : 0.3);
    this.ringIn -= dt;
    if (this.loud > 0.25 && this.ringIn <= 0) {
      const k = this.rings.findIndex((r) => r > 1.2);
      if (k >= 0) this.rings[k] = 0;
      this.ringIn = 0.42 - 0.2 * this.loud;
    }
    for (let k = 0; k < this.rings.length; k++) this.rings[k] += dt;

    // the body sways on the beat (two beats a side); the head sits on the collar
    const sway = inp.tele ? Math.sin((inp.beat * Math.PI) / 2 + this.phase) : 0.3 * Math.sin(now * 0.8 + this.phase);
    this.bodyM.copy(this.part(this.root, 0, 0.03 * this.loud, 0, 0, 0, 0.04 * sway));
    const { center: c, bottom } = this.lm;
    this.anatM.copy(this.part(this.bodyM, 0, 1.45 * this.k + (c.y - bottom) / this.U, 0, 0, -Math.PI / 2, 0, 1 / this.U));
    this.localM.makeTranslation(-c.x, -c.y, -c.z);
    this.anatM.multiply(this.localM);

    // the head's camera: the stage's camera seen from the head's own frame
    const cam = this.anat.camera;
    this.inv.copy(this.anatM).invert();
    cam.position.copy(camera.position).applyMatrix4(this.inv);
    this.inv.decompose(this.v, this.q, this.sc);
    cam.quaternion.copy(this.q).multiply(camera.quaternion);
    if (cam.fov !== camera.fov) {
      cam.fov = camera.fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);

    // the head: its face (lids, brows, nods) from the voice, then its frame
    this.anat.face.update(inp.tele, Math.min(0.5, dt));
    const f = this.model.frame(a);
    this.anat.update(this.model, f, a, inp.tele, VIEW, dt);
    this.headM.multiplyMatrices(this.anatM, this.anat.headTurn);
    this.localM.compose(this.v.copy(c), this.q.setFromEuler(this.e.set(0, Math.PI / 2, 0)), this.sc.setScalar(this.Uh));
    this.headM.multiply(this.localM);
    // the mouth: between the lips' edges
    const ul = f.upperLip[6], ll = f.lowerLip[6];
    this.toHead((ul.x + ll.x) / 2, (ul.y + ll.y) / 2, 0, this.mouth);
    this.label.set(0, 0.62 + HAT_TOP[this.spec.look] + 0.18, 0).applyMatrix4(this.headM);
  }

  draw(pen: Pen, camera: THREE.Camera): void {
    const B = V.blue;
    // the robe and what it holds
    const robe = this.part(this.bodyM, 0, 0, 0, 0, 0, 0, this.k).clone();
    pen.view(camera, this.ref.set(0, 1.0, 0).applyMatrix4(robe));
    pen.M.copy(robe);
    pen.lines(ROBE_LINES, V.blueMid, 1.05);
    pen.line(ellipse(0, 1.62, 0, 0.3, 0.3, "xz", 28), B, 1.3); // collar
    if (this.spec.look !== "gonzaga" && this.spec.look !== "compadecida") {
      // hands holding the songbook
      for (const s of [-1, 1]) pen.line(ellipse(s * 0.33, 1.0, 0.7, 0.08, 0.08, "xy", 14), B, 1.05, { flat: true });
      pen.M.copy(this.part(robe, 0, 1.05, 0.64, -0.75));
      pen.line([-0.31, -0.22, 0, 0.31, -0.22, 0, 0.31, 0.22, 0, -0.31, 0.22, 0], V.white, 1.05, { close: true, alpha: 0.75, flat: true });
      pen.line([0, -0.22, 0, 0, 0.22, 0], V.white, 0.85, { alpha: 0.5, flat: true });
    }

    pen.view(camera, this.ref.set(0, 0, 0).applyMatrix4(this.headM));
    this.drawLook(pen, robe);

    // rings of sound leaving the mouth
    pen.M.copy(this.headM);
    const m = this.mouth;
    for (const age of this.rings) {
      if (age > 1.2) continue;
      const u = age / 1.2, r = 0.08 + 0.4 * u;
      pen.line(ellipse(m.x, m.y + 0.05 * u, m.z + 0.2 + 1.2 * u, r, r, "xy", 28), V.amber, 1.3, { alpha: (1 - u) * (1 - u) * (0.4 + 0.6 * this.loud), flat: true });
    }
  }

  /** what this singer wears, in the head frame (the crown at y 0.62, the face to +z) */
  private drawLook(pen: Pen, robe: THREE.Matrix4): void {
    const c = this.spec.color, H = this.headM, m = this.mouth;
    const eyeR = (1.35 * this.lm.eyeR) / this.Uh;
    switch (this.spec.look) {
      case "propeller": {
        // a beanie with a propeller
        pen.M.copy(this.part(H, 0, 0.3, -0.04, -0.12, 0, 0, HAT));
        pen.lines(DOME(0.66, 0.78), c, 1.05);
        pen.line(ellipse(0, 0.02, 0.42, 0.42, 0.3, "xz", 16, 0, Math.PI), c, 1.3); // visor
        pen.line([0, 0.5, 0, 0, 0.7, 0], c, 1.3);
        for (const s of [0, Math.PI]) {
          const ca = Math.cos(this.spin + s), sa = Math.sin(this.spin + s);
          const blade = ellipse(0.24, 0.7, 0, 0.24, 0.08, "xz", 16);
          for (let i = 0; i < blade.length; i += 3) {
            const x = blade[i], z = blade[i + 2];
            blade[i] = x * ca - z * sa;
            blade[i + 2] = x * sa + z * ca;
          }
          pen.line(blade, c, 1.3, { hot: true });
        }
        break;
      }
      case "sunhat": {
        // a wide hat with a flower, and round glasses
        pen.M.copy(this.part(H, 0, 0.5, -0.04, -0.08, 0, 0.12, HAT));
        pen.line(ellipse(0, 0, 0, 1.18, 1.18, "xz", 48), c, 1.3);
        pen.lines(CYL(0.6, 0.52, 0.42, 8), c, 1.05);
        pen.M.copy(this.part(H, 0.3, 0.62, 0.26, 0, 0.8, 0, HAT));
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * TAU;
          pen.line(ellipse(Math.cos(a) * 0.09, Math.sin(a) * 0.09, 0, 0.06, 0.06, "xy", 10), c, 1.05, { hot: true, flat: true });
        }
        pen.M.copy(H);
        for (const e of this.eyes) pen.line(ellipse(e.x, e.y, e.z + eyeR * 0.9, eyeR, eyeR, "xy", 24), c, 1.3, { flat: true });
        if (this.eyes.length === 2) {
          const [a, b] = this.eyes, z = Math.max(a.z, b.z) + eyeR;
          pen.line([Math.min(a.x, b.x) + eyeR, a.y + 0.02, z, Math.max(a.x, b.x) - eyeR, b.y + 0.02, z], c, 1.05, { flat: true });
        }
        break;
      }
      case "viking": {
        // a horned helmet, and a beard under the lips that drops with the jaw
        pen.M.copy(this.part(H, 0, 0.28, -0.04, 0, 0, 0, HAT));
        pen.lines(DOME(0.66, 0.95), c, 1.05);
        pen.line(ellipse(0, 0, 0, 0.67, 0.67, "xz", 40), c, 1.6);
        for (const s of [-1, 1]) {
          const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(s * 0.58, 0.2, 0), new THREE.Vector3(s * 0.88, 0.35, 0), new THREE.Vector3(s * 1.0, 0.7, 0), new THREE.Vector3(s * 0.92, 0.95, 0)]);
          const pts = curve.getPoints(16);
          const up: number[] = [], dn: number[] = [];
          pts.forEach((p, i) => {
            const q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
            const dx = q.x - o.x, dy = q.y - o.y, l = Math.hypot(dx, dy) || 1, r = 0.09 * (1 - 0.9 * (i / (pts.length - 1)));
            up.push(p.x - (dy / l) * r, p.y + (dx / l) * r, 0);
            dn.unshift(p.x + (dy / l) * r, p.y - (dx / l) * r, 0);
          });
          pen.line([...up, ...dn], c, 1.05, { close: true, flat: true });
        }
        // the beard hangs from below the lower lip, back along the jaw
        pen.M.copy(this.part(H, 0, m.y - 0.08, m.z - 0.04, 0, 0, 0, 0.6));
        const d = -0.12 * this.open;
        pen.line([-0.42, 0.18, -0.3, -0.36, -0.15 + d, -0.1, -0.2, -0.42 + d, 0, -0.15, -0.8 + d, -0.05, -0.05, -0.48 + d, 0.02, 0.05, -0.48 + d, 0.02, 0.15, -0.8 + d, -0.05, 0.2, -0.42 + d, 0, 0.36, -0.15 + d, -0.1, 0.42, 0.18, -0.3], c, 1.3, { flat: true });
        for (const s of [-1, 1]) pen.line([s * 0.22, -0.2 + d, -0.02, s * 0.15, -0.55 + d, -0.04], c, 0.85, { alpha: 0.7, flat: true });
        break;
      }
      case "padre": {
        // a saturno hat; on the cassock a clerical collar, a crucifix and a column of buttons
        pen.M.copy(this.part(H, 0, 0.5, -0.04, -0.05, 0, 0, HAT));
        pen.line(ellipse(0, 0, 0, 1.05, 1.05, "xz", 48), c, 1.3);
        pen.line(ellipse(0, 0.02, 0, 0.98, 0.98, "xz", 48), c, 0.85, { alpha: 0.6 });
        pen.lines(lathe(sphereProfile(0.55, 0.6, Math.PI / 2, 4), 8), c, 1.05);
        pen.M.copy(robe);
        pen.line([-0.07, 1.56, 0.31, 0.07, 1.56, 0.31, 0.07, 1.64, 0.27, -0.07, 1.64, 0.27], c, 1.3, { close: true, hot: true, flat: true });
        const [lx, ly, lz] = onRobe(-0.2, 1.56), [rx, ry, rz] = onRobe(0.2, 1.56), [cx, cy, cz] = onRobe(0, 1.32, 0.05);
        pen.line([lx, ly, lz, cx, cy, cz, rx, ry, rz], c, 0.85, { alpha: 0.6, flat: true });
        pen.line([cx, cy, cz, cx, cy - 0.26, cz + 0.02], c, 1.6, { hot: true, flat: true });
        pen.line([cx - 0.08, cy - 0.08, cz + 0.01, cx + 0.08, cy - 0.08, cz + 0.01], c, 1.6, { hot: true, flat: true });
        for (let y = 0.7; y > 0.08; y -= 0.13) {
          const [bx, by, bz] = onRobe(0, y);
          pen.line(ellipse(bx, by, bz, 0.025, 0.025, "xy", 8), c, 1.05, { flat: true });
        }
        break;
      }
      case "compadecida": {
        // a veil from the crown to the shoulders, leaving the face open; a halo behind; hands
        // together in front; the mantle down the robe
        pen.M.copy(H);
        const drape = (phi: number): number[] => {
          const p: number[] = [];
          for (let i = 0; i <= 14; i++) {
            const u = i / 14, y = 0.72 - 1.25 * u, r = 0.12 + Math.min(1, u * 2.4) * 0.6 + Math.max(0, u - 0.6) * 0.3;
            p.push(r * Math.sin(phi), y, -0.05 + r * Math.cos(phi));
          }
          return p;
        };
        for (let k = 0; k <= 10; k++) pen.line(drape((50 + (k * 260) / 10) * (Math.PI / 180)), c, 1.05);
        // its edge round the face, and its hem on the shoulders
        // the veil's edge framing the face: over the brow and down beside the cheeks
        const edge: number[] = [];
        for (let i = 0; i <= 20; i++) {
          const a = -1.05 + (2.1 * i) / 20, r = 0.7;
          edge.push(r * Math.sin(a), 0.42 - 0.75 * a * a, -0.05 + r * Math.cos(a));
        }
        pen.line(edge, c, 1.6, { hot: true });
        pen.line(ellipse(0, -0.53, -0.05, 0.8, 0.8, "xz", 32, -0.22 * Math.PI, 1.22 * Math.PI), c, 1.3);
        const halo = ellipse(0, 0.55, -0.5, 0.62, 0.62, "xy", 48);
        pen.line(halo, V.amber, 1.6, { hot: true, flat: true, alpha: 0.7 + 0.3 * this.loud });
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * TAU, r0 = 0.67, r1 = 0.77 + 0.05 * this.loud;
          pen.line([r0 * Math.cos(a), 0.55 + r0 * Math.sin(a), -0.5, r1 * Math.cos(a), 0.55 + r1 * Math.sin(a), -0.5], V.amber, 0.85, { alpha: 0.6, flat: true });
        }
        pen.M.copy(robe);
        const [hx, hy, hz] = onRobe(0, 1.22, 0.12);
        for (const s of [-1, 1]) pen.line([hx, hy + 0.14, hz + 0.02, hx + s * 0.08, hy, hz, hx + s * 0.07, hy - 0.12, hz - 0.03, hx, hy - 0.1, hz], V.blue, 1.05, { flat: true });
        for (const s of [-1, 1]) {
          const p: number[] = [];
          for (let y = 1.55; y >= 0; y -= 0.1) p.push(...onRobe(s * (0.2 + 0.2 * (1.55 - y)), y, 0.03));
          pen.line(p, c, 1.05, { flat: true });
        }
        break;
      }
      case "gonzaga": {
        // a leather hat, its front turned up with a star; the accordion in his hands
        pen.M.copy(this.part(H, 0, 0.36, -0.04, -0.08, 0, 0, HAT));
        pen.lines(lathe(sphereProfile(0.6, 0.75, Math.PI / 2, 4), 8), c, 1.05);
        pen.line(brim(0.98, 0.9, 0.62, 0.12), c, 1.6, { hot: true });
        pen.line(ellipse(0, 0.08, 0, 0.61, 0.61, "xz", 32), c, 1.05);
        pen.lines(star(0, 0.36, 0.86, 0.16, 6), c, 1.3, { hot: true, flat: true });
        for (const a of [-0.5, -0.25, 0.25, 0.5]) pen.line(ellipse(0.82 * Math.sin(a), 0.14 + 0.3 * Math.cos(a) ** 2, 0.82 * Math.cos(a), 0.035, 0.035, "xy", 8), c, 1.05, { flat: true });
        // the accordion: the bass side, the bellows (opening and closing), the keyboard side
        pen.M.copy(this.part(robe, 0, -0.3, -0.25, 0, 0, 0, 1.3));
        const open = 0.5 + 0.5 * Math.sin(this.bellows * Math.PI);
        const w = 0.14 + 0.16 * open, y0 = 0.82, y1 = 1.3, z0 = 0.66, z1 = 0.86;
        const box = (x0: number, x1: number, col: string) => {
          pen.line([x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1], col, 1.3, { close: true, flat: true });
          pen.line([x0, y1, z1, x0, y1, z0, x1, y1, z0, x1, y1, z1], col, 1.05, { flat: true });
        };
        const left = -w / 2 - 0.22, right = w / 2;
        box(left, -w / 2, c);
        box(right, right + 0.24, c);
        for (let k = 0; k < 6; k++) pen.line([right + 0.05, y0 + 0.05 + k * 0.075, z1 + 0.005, right + 0.19, y0 + 0.05 + k * 0.075, z1 + 0.005], V.white, 0.85, { alpha: 0.8, flat: true });
        for (let k = 0; k < 4; k++) pen.line(ellipse(left + 0.06 + (k % 2) * 0.09, y0 + 0.12 + Math.floor(k / 2) * 0.2, z1 + 0.005, 0.025, 0.025, "xy", 8), V.white, 0.85, { flat: true });
        const folds = 7, zig = (y: number) => {
          const p: number[] = [];
          for (let k = 0; k <= folds; k++) p.push(-w / 2 + (k * w) / folds, y, k % 2 ? z1 - 0.04 : z1);
          return p;
        };
        pen.line(zig(y0), V.pink, 1.05, { flat: true });
        pen.line(zig(y1), V.pink, 1.05, { flat: true });
        for (let k = 0; k <= folds; k++) pen.line([-w / 2 + (k * w) / folds, y0, k % 2 ? z1 - 0.04 : z1, -w / 2 + (k * w) / folds, y1, k % 2 ? z1 - 0.04 : z1], V.pink, 0.85, { alpha: 0.7, flat: true });
        for (const x of [left - 0.04, right + 0.28]) pen.line(ellipse(x, 1.05, 0.78, 0.07, 0.09, "xy", 12), V.blue, 1.05, { flat: true });
        for (const s of [-1, 1]) pen.line([s * 0.2, y1, z0, s * 0.26, 1.6, 0.12], c, 0.85, { alpha: 0.6 });
        break;
      }
      case "lampiao": {
        // the cangaceiro's half-moon hat with a star and coins, its chin strap; round glasses;
        // a scarf at the neck and two cartridge belts across the chest
        pen.M.copy(this.part(H, 0, 0.36, -0.04, -0.06, 0, 0, HAT));
        pen.lines(lathe(sphereProfile(0.6, 0.8, Math.PI / 2, 4), 8), c, 1.05);
        pen.line(brim(1.12, 0.95, 0.85, 0.55), c, 1.6, { hot: true });
        pen.line(brim(1.02, 0.86, 0.75, 0.48), c, 0.85, { alpha: 0.6 });
        pen.lines(star(0, 0.5, 0.92, 0.2, 5), V.amber, 1.3, { hot: true, flat: true });
        for (const a of [-0.9, -0.62, -0.34, 0.34, 0.62, 0.9]) pen.line(ellipse(0.98 * Math.sin(a), 0.1 + 0.62 * Math.cos(a) ** 2, 0.86 * Math.cos(a), 0.05, 0.05, "xy", 10), V.amber, 1.05, { flat: true });
        pen.M.copy(H);
        for (const s of [-1, 1]) pen.line([s * 0.58, 0.32, 0.05, s * 0.5, m.y - 0.2, 0.15, s * 0.2, m.y - 0.42, m.z - 0.12, 0, m.y - 0.45, m.z - 0.1], c, 0.85, { alpha: 0.75 });
        for (const e of this.eyes) pen.line(ellipse(e.x, e.y, e.z + eyeR * 0.9, eyeR, eyeR, "xy", 24), V.white, 1.3, { flat: true });
        if (this.eyes.length === 2) {
          const [a, b] = this.eyes, z = Math.max(a.z, b.z) + eyeR;
          pen.line([Math.min(a.x, b.x) + eyeR, a.y + 0.02, z, Math.max(a.x, b.x) - eyeR, b.y + 0.02, z], V.white, 1.05, { flat: true });
        }
        pen.M.copy(robe);
        pen.line([...onRobe(-0.26, 1.6, 0.03), ...onRobe(0, 1.3, 0.05), ...onRobe(0.26, 1.6, 0.03)], c, 1.3, { hot: true, flat: true });
        for (const s of [-1, 1]) {
          const p: number[] = [];
          for (let k = 0; k <= 10; k++) {
            const u = k / 10, y = 1.5 - 0.95 * u;
            p.push(...onRobe(s * (0.32 - 0.8 * u), y, 0.03));
            if (k % 2 === 0 && k > 0 && k < 10) {
              const [x, yy, z] = onRobe(s * (0.32 - 0.8 * u), y, 0.04);
              pen.line([x, yy - 0.05, z, x, yy + 0.05, z], V.amber, 1.05, { flat: true });
            }
          }
          pen.line(p, c, 1.3, { flat: true });
        }
        break;
      }
      case "tophat": {
        // a top hat, a walrus moustache over the lips, a monocle, a bow tie
        pen.M.copy(this.part(H, 0, 0.5, -0.04, 0, 0, -0.1, HAT));
        pen.line(ellipse(0, 0, 0, 0.84, 0.84, "xz", 40), c, 1.3);
        pen.lines(CYL(0.5, 0.54, 0.95, 10), c, 1.05);
        pen.line(ellipse(0, 0.16, 0, 0.51, 0.51, "xz", 32), V.red, 1.3);
        pen.M.copy(this.part(H, 0, m.y + 0.08 + 0.03 * this.open, m.z + 0.03, 0, 0, 0, 0.65));
        for (const s of [-1, 1]) pen.line([0, 0.03, 0, s * 0.18, 0.06, -0.01, s * 0.32, -0.05, -0.08, s * 0.36, -0.2, -0.13, s * 0.22, -0.09, -0.04, 0, -0.06, 0], c, 1.6, { hot: true, flat: true });
        pen.M.copy(H);
        const e = this.eyes.reduce((a, b) => (b.x < a.x ? b : a), this.eyes[0]);
        if (e) {
          pen.line(ellipse(e.x, e.y, e.z + eyeR * 0.9, eyeR, eyeR, "xy", 24), V.amber, 1.3, { flat: true });
          pen.line([e.x - eyeR, e.y - 0.03, e.z + eyeR * 0.8, e.x - 1.6 * eyeR, e.y - 0.35, e.z, e.x - 1.2 * eyeR, e.y - 0.7, e.z - 0.06], V.amber, 0.85, { alpha: 0.7, flat: true });
        }
        pen.M.copy(this.part(robe, 0, 1.62, 0.34));
        for (const s of [-1, 1]) pen.line([0, 0, 0, s * 0.24, 0.1, 0, s * 0.24, -0.1, 0], V.red, 1.3, { close: true, flat: true });
        break;
      }
    }
  }

  dispose(): void {
    this.anat.dispose();
  }
}

/** The stage, the four singers on it, and a camera that frames them. */
export class Choir3D {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  readonly singers: Singer[] = [];
  readonly target = new THREE.Vector3(0, 2.0, 0);
  private readonly beams = new Beams();
  private readonly pen = new Pen(this.beams);
  private readonly floor: number[][] = [];
  private w = 1;
  private h = 1;

  constructor(specs: SingerSpec[]) {
    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.beams.group);
    // the stage: rings and spokes on the floor, in the frame's blue
    for (let r = 1.25; r <= 7.5; r += 1.25) this.floor.push(ellipse(0, 0, 0, r, r, "xz", 72));
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU;
      this.floor.push([0, 0, 0, 7.5 * Math.cos(a), 0, 7.5 * Math.sin(a)]);
    }
    const n = specs.length;
    specs.forEach((s, i) => {
      // an arc, its middle a little back; each turns toward the middle of the audience
      const u = n > 1 ? i / (n - 1) - 0.5 : 0;
      this.singers.push(new Singer(s, i, u * 6, -1.2 * Math.cos(u * 2.2) + 1.2 * Math.cos(1.1), -u * 0.5));
    });
    this.home();
  }

  /** where the camera starts, and goes back to */
  homePose(): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const aspect = this.w / this.h;
    const halfW = 4.4, halfH = 2.5;
    const fov = (this.camera.fov * Math.PI) / 180;
    const d = Math.max(halfH / Math.tan(fov / 2), halfW / (Math.tan(fov / 2) * aspect)) + 2;
    return { pos: new THREE.Vector3(0, this.target.y + 0.14 * d, d), target: this.target.clone() };
  }

  home(): void {
    const p = this.homePose();
    this.camera.position.copy(p.pos);
    this.camera.lookAt(p.target);
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.beams.setResolution(w, h);
    for (const s of this.singers) s.anat.resize(w, h);
  }

  /** one frame: call after the camera has moved */
  update(inputs: SingerInput[], dt: number, now: number): void {
    this.camera.updateMatrixWorld(true);
    this.singers.forEach((s, i) => s.place(inputs[i], dt, now, this.camera));
    this.beams.begin();
    this.pen.M.identity();
    this.pen.lines(this.floor, V.frame, 0.85, { flat: true, alpha: 0.7 });
    for (const s of this.singers) s.draw(this.pen, this.camera);
    this.beams.end();
  }

  /** the stage, then each head over it (the beams blend by maximum, so the order doesn't show) */
  render(gl: THREE.WebGLRenderer): void {
    gl.autoClear = false;
    gl.clear();
    gl.render(this.scene, this.camera);
    for (const s of this.singers) gl.render(s.anat.scene, s.anat.camera);
  }

  /** screen position (CSS px) of where singer i's syllable goes */
  project(i: number): [number, number, boolean] {
    const v = this.singers[i].label.clone().project(this.camera);
    return [((v.x + 1) / 2) * this.w, ((1 - v.y) / 2) * this.h, v.z < 1];
  }

  dispose(): void {
    this.beams.dispose();
    for (const s of this.singers) s.dispose();
  }
}
