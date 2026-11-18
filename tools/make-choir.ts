/**
 * Makes a choir show (`?choir=<id>`): four parts (soprano, alto, tenor, bass), each sung by the
 * engine (`chimera render notes … --tele`), mixed into one track, in public/shows/<id>/
 * (gitignored, like every show).
 *
 *   cargo build --release -p chimera-cli
 *   bun tools/make-choir.ts                       the demo: an original chorale, show "choir"
 *   bun tools/make-choir.ts <id> --midi song.mid --track 1[:ch] --lyrics lyrics.txt
 *       [--from beat] [--to beat] [--grid 0.25] [--bpm N] [--every 2] [--title "…"]
 *       [--ti tʃ|t] [--r h] [--final-r] [--voices part:body:look[:name],...]
 *
 * From a MIDI file (paths inside the show's folder): the line (tools/midi-to-notes.ts) is the
 * soprano, moved by octaves into a child's range; the alto, tenor and bass are written under it,
 * one chord every `--every` beats (the key's I IV V ii vi, or i iv V III VI in minor, the one
 * that holds most of the melody there), each voice moving as little as it can. All four sing the
 * soprano's rhythm and words. `--voices` says who sings which part, left to right on the stage:
 * a part is soprano, alto, tenor, bass or melody (the soprano an octave down), a body child,
 * female or male, a look one of the choir page's. The lyrics are Brazilian Portuguese read by tools/pt-syllables.ts;
 * their syllables must match the line's sung notes (it prints both counts, line by line).
 *
 * `--phrase-beats N` fits the words instead, as Sing mode does (src/song/fit.ts): the melody is cut
 * into phrases of N beats from its first note (a note up to half a beat early, a pickup, starts the
 * next phrase), short neighbouring lyric lines join until there are as many lines as phrases, and
 * each line goes onto its phrase: a syllable more than notes splits the longest note, fewer hold a
 * vowel over several (rests inside a phrase are tied over; a phrase ends with a breath before the
 * next).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extractLine, readMidi } from "./midi-to-notes.ts";
import { phrases, readLyrics, type Syllable } from "./pt-syllables.ts";
import { fitLine } from "../src/song/fit.ts";
import type { Syllable as EngineSyllable } from "../src/wasm/types.ts";

const BIN = "target/release/chimera";

type Notes = [number, number][];
interface Part {
  name: string;
  file: string;
  body: "child" | "female" | "male";
  gain: number;
  notes: Notes;
  /** the singer's look on the choir page (src/ui/render/choir3d.ts) */
  look?: string;
}

// ------------------------------------------------------------------ the demo
function demo(): { id: string; title: string; bpm: number; lyrics: string; parts: Part[] } {
  // one chord per syllable, all four parts on the same rhythm (a chorale): C major
  const lines: Record<string, number[][]> = {
    soprano: [[64, 67, 69, 67, 71, 74, 72], [72, 72, 69, 69, 67, 71, 72], [69, 69, 67, 64, 65, 67, 64], [69, 71, 71, 72, 74, 74, 72]],
    alto: [[60, 64, 65, 64, 62, 65, 64], [64, 64, 65, 65, 62, 65, 64], [65, 65, 64, 60, 62, 62, 60], [65, 67, 67, 64, 65, 65, 64]],
    tenor: [[55, 60, 60, 60, 59, 59, 60], [57, 57, 57, 57, 59, 62, 60], [60, 60, 55, 55, 57, 59, 55], [60, 62, 59, 57, 57, 59, 55]],
    bass: [[48, 48, 53, 52, 43, 43, 48], [45, 45, 50, 50, 43, 43, 48], [53, 53, 48, 48, 50, 43, 48], [53, 55, 52, 45, 50, 43, 48]],
  };
  // six quarters and a long note per line; a breath between lines, the last held
  const melody = (ls: number[][]): Notes => {
    const notes: Notes = [];
    ls.forEach((line, li) => {
      const last = li === ls.length - 1;
      line.forEach((m, i) => notes.push([m, i < 6 ? 1 : last ? 4 : 1.5]));
      if (!last) notes.push([0, 0.5]);
    });
    return notes;
  };
  return {
    id: "choir",
    title: "Morning Light, for four voices",
    bpm: Number(process.argv[2] ?? 84),
    lyrics: "Sing with me the morning light, voices rising warm and bright, four of us in harmony, sing the song and set it free",
    parts: VOICES.map((v) => ({ ...v, notes: melody(lines[v.file]) })),
  };
}

const VOICES: Omit<Part, "notes">[] = [
  { name: "Soprano", file: "soprano", body: "child", gain: 0.8 },
  { name: "Alto", file: "alto", body: "female", gain: 0.9 },
  { name: "Tenor", file: "tenor", body: "male", gain: 0.9 },
  { name: "Bass", file: "bass", body: "male", gain: 1.0 },
];

// ------------------------------------------------------------------ harmony
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** the key (tonic pitch class, major?) by the Krumhansl-Kessler profiles, weighted by duration */
function keyOf(notes: Notes): { tonic: number; major: boolean } {
  const h = new Array(12).fill(0);
  for (const [m, b] of notes) if (m > 0) h[m % 12] += b;
  let best = { tonic: 0, major: true, r: -Infinity };
  for (const major of [true, false])
    for (let t = 0; t < 12; t++) {
      const p = major ? MAJOR : MINOR;
      const xs = h.map((_, i) => h[(i + t) % 12]);
      const mx = xs.reduce((a, b) => a + b) / 12, mp = p.reduce((a, b) => a + b) / 12;
      let num = 0, dx = 0, dp = 0;
      for (let i = 0; i < 12; i++) {
        num += (xs[i] - mx) * (p[i] - mp);
        dx += (xs[i] - mx) ** 2;
        dp += (p[i] - mp) ** 2;
      }
      const r = num / Math.sqrt(dx * dp || 1);
      if (r > best.r) best = { tonic: t, major, r };
    }
  return best;
}

interface Chord {
  root: number;
  tones: number[];
  primary: boolean;
}

function chordsOf(key: { tonic: number; major: boolean }): Chord[] {
  const t = key.tonic;
  const at = (deg: number, tri: number[], primary: boolean): Chord => ({ root: (t + deg) % 12, tones: tri.map((x) => (t + deg + x) % 12), primary });
  return key.major
    ? [at(0, [0, 4, 7], true), at(5, [0, 4, 7], true), at(7, [0, 4, 7, 10], true), at(2, [0, 3, 7], false), at(9, [0, 3, 7], false)]
    : [at(0, [0, 3, 7], true), at(5, [0, 3, 7], true), at(7, [0, 4, 7, 10], true), at(3, [0, 4, 7], false), at(8, [0, 4, 7], false)];
}

/** a chord for each sung note: the one that holds most of the melody in its window */
function harmonize(notes: Notes, every: number): Chord[] {
  const key = keyOf(notes);
  const chords = chordsOf(key);
  const total = notes.reduce((s, n) => s + n[1], 0);
  const windows: Chord[] = [];
  let prev: Chord | null = null;
  for (let w0 = 0; w0 < total - 1e-9; w0 += every) {
    const w1 = w0 + every;
    const weight = new Array(12).fill(0);
    let t = 0;
    for (const [m, b] of notes) {
      const a = Math.max(t, w0), e = Math.min(t + b, w1);
      if (m > 0 && e > a) weight[m % 12] += (e - a) * (t >= w0 ? 1.3 : 1); // a note starting here counts more
      t += b;
    }
    const last = w1 >= total - 1e-9;
    let best = chords[0], bs = -Infinity;
    for (const c of chords) {
      let s = 0;
      weight.forEach((x, pc) => (s += c.tones.includes(pc) ? x : -0.6 * x));
      s += c.primary ? 0.15 : 0;
      if (prev && c.root === prev.root) s += 0.1;
      if (last && c !== chords[0]) s -= 10; // end at home
      if (s > bs) {
        bs = s;
        best = c;
      }
    }
    windows.push(best);
    prev = best;
  }
  const out: Chord[] = [];
  let t = 0;
  for (const [m, b] of notes) {
    if (m > 0) out.push(windows[Math.min(windows.length - 1, Math.floor((t + 1e-6) / every))]);
    t += b;
  }
  return out;
}

/** the soprano moved by octaves into a child's range, then alto, tenor and bass under it */
function arrange(line: Notes, every: number): Record<string, Notes> {
  const sung = line.filter((n) => n[0] > 0).map((n) => n[0]);
  const hi = Math.max(...sung), lo = Math.min(...sung);
  let shift = 12 * Math.round((70 - (hi + lo) / 2) / 12);
  while (hi + shift > 79) shift -= 12; // G5: a child's top
  while (lo + shift < 57) shift += 12;
  const sop: Notes = line.map(([m, b]) => [m > 0 ? m + shift : 0, b]);
  const chords = harmonize(sop, every);
  const tonesIn = (c: Chord, lo: number, hi: number) => {
    const out: number[] = [];
    for (let m = lo; m <= hi; m++) if (c.tones.includes(m % 12)) out.push(m);
    return out;
  };
  const alto: Notes = [], tenor: Notes = [], bass: Notes = [];
  let pa = 64, pt = 57, pb = 48, k = 0;
  for (const [s, b] of sop) {
    if (s <= 0) {
      alto.push([0, b]);
      tenor.push([0, b]);
      bass.push([0, b]);
      continue;
    }
    const c = chords[k++];
    // the bass: the root, the octave nearest where it was
    const roots = tonesIn({ ...c, tones: [c.root] }, 40, 55);
    const bb = roots.reduce((a, x) => (Math.abs(x - pb) < Math.abs(a - pb) ? x : a), roots[0]);
    // alto and tenor: chord tones under the soprano, moving least, the third present
    let best = [pa, pt], bc = Infinity;
    for (const a of tonesIn(c, 55, 72))
      for (const t of tonesIn(c, 48, 66)) {
        if (a >= s || t >= a || t <= bb) continue;
        const pcs = new Set([s % 12, a % 12, t % 12, bb % 12]);
        const third = (c.root + (c.tones[1] - c.root + 12)) % 12;
        let cost = Math.abs(a - pa) + Math.abs(t - pt);
        if (!pcs.has(third)) cost += 6;
        if (pcs.size < 3) cost += 3;
        if (s - a > 12) cost += 6;
        if (a - t > 12) cost += 6;
        if (cost < bc) {
          bc = cost;
          best = [a, t];
        }
      }
    [pa, pt, pb] = [best[0], best[1], bb];
    alto.push([pa, b]);
    tenor.push([pt, b]);
    bass.push([pb, b]);
  }
  // the tune itself an octave down, for a man to sing
  const melody: Notes = sop.map(([m, b]) => [m > 0 ? m - 12 : 0, b]);
  return { soprano: sop, alto, tenor, bass, melody };
}

// ------------------------------------------------------------------ audio
/** a 16-bit PCM WAV's samples */
function readWav(path: string): { rate: number; x: Float32Array } {
  const b = readFileSync(path);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 12, rate = 48000;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4), len = v.getUint32(o + 4, true);
    if (id === "fmt ") rate = v.getUint32(o + 12, true);
    if (id === "data") {
      const x = new Float32Array(len / 2);
      for (let i = 0; i < x.length; i++) x[i] = v.getInt16(o + 8 + 2 * i, true) / 32768;
      return { rate, x };
    }
    o += 8 + len + (len & 1);
  }
  throw new Error(`${path}: no data chunk`);
}

function writeWav(path: string, x: Float32Array, rate: number): void {
  const b = Buffer.alloc(44 + 2 * x.length);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + 2 * x.length, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(2 * x.length, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + 2 * i);
  writeFileSync(path, b);
}

/** renders each part with its telemetry, mixes them and writes show.json */
function make(id: string, title: string, bpm: number, parts: Part[], words: { lyrics: string } | { syllables: Syllable[] }): void {
  const out = `public/shows/${id}`;
  mkdirSync(out, { recursive: true });
  const tracks: { x: Float32Array; gain: number }[] = [];
  let rate = 48000;
  for (const p of parts) {
    writeFileSync(`${out}/${p.file}.json`, JSON.stringify({ bpm, t0: 0.3, vibrato: 30, ...words, notes: p.notes }));
    const r = spawnSync(BIN, ["render", "notes", `${out}/${p.file}.json`, `${out}/${p.file}`, p.body, "--tele", `${out}/${p.file}.tele`], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`render of ${p.file} failed`);
    const w = readWav(`${out}/${p.file}.wav`);
    rate = w.rate;
    tracks.push({ x: w.x, gain: p.gain });
  }
  const n = Math.max(...tracks.map((t) => t.x.length));
  const mix = new Float32Array(n);
  for (const t of tracks) for (let i = 0; i < t.x.length; i++) mix[i] += t.gain * t.x[i];
  let peak = 0;
  for (const s of mix) peak = Math.max(peak, Math.abs(s));
  const k = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < n; i++) mix[i] *= k;
  writeWav(`${out}/mix.wav`, mix, rate);
  writeFileSync(`${out}/show.json`, JSON.stringify({ title, audio: "mix.wav", bpm, downbeat: 0.3, voices: parts.map((p) => ({ name: p.name, tele: `${p.file}.tele`, melody: `${p.file}.json`, ...(p.look ? { look: p.look } : {}) })) }, null, 2));
  console.log(`${out}: ${(n / rate).toFixed(1)} s, peak ${peak.toFixed(2)} before normalising; open ?choir=${id}`);
}

// ------------------------------------------------------------------ fitting words
/** the melody cut into phrases of `size` beats from its first note, a pickup starting the next */
function windows(line: Notes, size: number): { lead: number; phrases: Notes[] } {
  const out: Notes[] = [];
  let t = 0, first = -1;
  for (const [m, b] of line) {
    if (m > 0) {
      if (first < 0) first = t;
      const k = Math.floor((t - first + 0.5) / size);
      while (out.length <= k) out.push([]);
      out[k].push([m, b]);
    } else if (first >= 0 && out.length) {
      // a rest inside a phrase: tied over by the note before
      const ph = out[out.length - 1];
      if (ph.length) ph[ph.length - 1] = [ph[ph.length - 1][0], ph[ph.length - 1][1] + b];
    }
    t += b;
  }
  return { lead: Math.max(0, first), phrases: out.filter((p) => p.length) };
}

/** Sing mode's fit, line by line onto phrases of `size` beats (see the file's comment). */
function fitWords(line: Notes, syllables: Syllable[], perLine: number[], size: number): { notes: Notes; syllables: Syllable[] } {
  const { lead, phrases: ph } = windows(line, size);
  // the lyrics' lines as syllable runs; short neighbours join until they are as many as the phrases
  const runs: Syllable[][] = [];
  let k = 0;
  for (const n of perLine) {
    runs.push(syllables.slice(k, k + n));
    k += n;
  }
  while (runs.length > ph.length) {
    let best = 0;
    for (let i = 1; i < runs.length - 1; i++) if (runs[i].length + runs[i + 1].length < runs[best].length + runs[best + 1].length) best = i;
    runs.splice(best, 2, [...runs[best].map((s, j, a) => (j === a.length - 1 ? { ...s, phraseEnd: false } : s)), ...runs[best + 1]]);
  }
  console.log(`melody: ${ph.length} phrases of ${size} beats, notes ${ph.map((p) => p.length).join(" ")}`);
  console.log(`lyrics: ${runs.length} lines, syllables ${runs.map((r) => r.length).join(" ")}`);
  if (runs.length < ph.length) console.warn(`warning: ${ph.length - runs.length} phrases at the end have no words and are left out`);
  const notes: Notes = [];
  const out: Syllable[] = [];
  void lead; // the line already starts at its first note
  runs.forEach((r, i) => {
    const phrase = ph[i];
    const f = fitLine(r as EngineSyllable[], phrase);
    // a breath: the phrase's last note gives up to a quarter beat to a rest, if it is long enough
    f.notes.forEach((n, j) => {
      const last = j === f.notes.length - 1, gap = last && n.beats >= 1 ? 0.25 : 0;
      notes.push([n.midi, n.beats - gap]);
      if (gap) notes.push([0, gap]);
      out.push(n.syl as Syllable);
    });
    // the phrase's span: the next one starts where its first note does
    const used = phrase.reduce((s, x) => s + x[1], 0);
    const span = i + 1 < ph.length ? phraseStart(line, ph, i + 1) - phraseStart(line, ph, i) : used;
    if (span > used + 1e-6) notes.push([0, span - used]);
  });
  return { notes, syllables: out };
}

/** the beat where phrase i's first note starts in the line */
function phraseStart(line: Notes, ph: Notes[], i: number): number {
  let count = 0;
  for (let j = 0; j < i; j++) count += ph[j].length;
  let t = 0, n = 0;
  for (const [m, b] of line) {
    if (m > 0) {
      if (n === count) return t;
      n++;
    }
    t += b;
  }
  return t;
}

// ------------------------------------------------------------------ main
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const has = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args.splice(i, 1), true) : false;
};
const midiPath = flag("midi");
if (!midiPath) {
  const d = demo();
  make(d.id, d.title, d.bpm, d.parts, { lyrics: d.lyrics });
} else {
  const id = args[0];
  if (!id || !/^[\w-]+$/.test(id)) throw new Error("a show id (a folder name under public/shows) comes first");
  const dir = `public/shows/${id}`;
  const sel = flag("track") ?? "0";
  const lyricsPath = flag("lyrics") ?? "letra.txt";
  const from = flag("from"), to = flag("to"), grid = flag("grid"), every = Number(flag("every") ?? 2), bpmArg = flag("bpm"), phraseBeats = flag("phrase-beats");
  const title = flag("title") ?? id;
  const ti = flag("ti"), r = flag("r"), finalR = has("final-r");
  const f = readMidi(readFileSync(`${dir}/${midiPath}`));
  const [track, channel] = sel.split(":").map(Number);
  const line = extractLine(f, { track, channel: Number.isFinite(channel) ? channel : undefined, from: from ? Number(from) : undefined, to: to ? Number(to) : undefined, grid: grid ? Number(grid) : undefined });
  if (!line.length) throw new Error(`track ${sel} has no notes in that range (bun tools/midi-to-notes.ts ${dir}/${midiPath} lists them)`);
  const { syllables, perLine } = readLyrics(readFileSync(`${dir}/${lyricsPath}`, "utf8"), { ti: ti === "t" ? "t" : "tʃ", r, finalR });
  let melody = line, sungSyl: Syllable[] = syllables;
  if (phraseBeats) {
    const fitted = fitWords(line, syllables, perLine, Number(phraseBeats));
    melody = fitted.notes;
    sungSyl = fitted.syllables;
  } else {
    const sung = line.filter((n) => n[0] > 0).length;
    console.log(`lyrics: ${syllables.length} syllables, per line ${perLine.join(" ")}`);
    console.log(`melody: ${sung} sung notes, per phrase ${phrases(line).join(" ")}`);
    if (sung !== syllables.length) {
      console.error("the syllables and the notes must match: split (-) or hold (_) syllables in the lyrics, cut the melody (--from/--to beats), or fit them (--phrase-beats)");
      process.exit(1);
    }
  }
  const voices = arrange(melody, every);
  const bpm = bpmArg ? Number(bpmArg) : Math.round(f.bpm * 10) / 10;
  // who sings: part:body:look[:name], in order across the stage (default: the four parts)
  const cast = flag("voices");
  const parts: Part[] = cast
    ? cast.split(",").map((spec, i) => {
        const [part, body, look, name] = spec.split(":");
        if (!voices[part]) throw new Error(`--voices: no part "${part}" (soprano, alto, tenor, bass, melody)`);
        if (!["child", "female", "male"].includes(body)) throw new Error(`--voices: body "${body}" is child, female or male`);
        return { name: name ?? part[0].toUpperCase() + part.slice(1), file: `v${i}-${part}`, body: body as Part["body"], gain: 0.9, notes: voices[part], look };
      })
    : VOICES.map((v) => ({ ...v, notes: voices[v.file] }));
  make(id, title, bpm, parts, { syllables: sungSyl });
}
