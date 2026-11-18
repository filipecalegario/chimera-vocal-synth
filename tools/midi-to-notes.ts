/**
 * A Standard MIDI File's line → the melody file `chimera render notes` sings:
 * `{"bpm", "t0", "notes": [[midi, beats], ...]}` (midi 0 is a rest; no lyrics: add them with
 * tools/pt-syllables.ts or by hand).
 *
 *   bun tools/midi-to-notes.ts <song.mid>                        lists the tracks and channels
 *   bun tools/midi-to-notes.ts <song.mid> <track>[:<channel>] [--top|--bottom] [--from beat]
 *                              [--to beat] [--grid 0.25] [--out melody.json]
 *
 * A line is one track (and, in a format 0 file, one channel). Where its notes overlap (a chord,
 * a sloppy legato), the highest sounds (`--bottom`: the lowest). Times are rounded to `--grid`
 * beats (a sixteenth by default). `--from`/`--to` cut the song (beats from the file's start, on
 * the grid): an instrumental intro, a second verse. The tempo is the file's first; later changes
 * are ignored (warned).
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface MidiNote {
  track: number;
  channel: number;
  midi: number;
  /** beats from the file's start */
  start: number;
  end: number;
}

export interface MidiFile {
  ppq: number;
  bpm: number;
  tempoChanges: number;
  notes: MidiNote[];
  trackNames: string[];
}

/** Reads note-ons and offs, track names and the tempo from a format 0 or 1 file. */
export function readMidi(buf: Uint8Array): MidiFile {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const str = (o: number, n: number) => String.fromCharCode(...buf.subarray(o, o + n));
  if (str(0, 4) !== "MThd") throw new Error("not a MIDI file");
  const nTracks = v.getUint16(10);
  const div = v.getUint16(12);
  if (div & 0x8000) throw new Error("SMPTE-timed MIDI files are not supported");
  const ppq = div;
  let o = 8 + v.getUint32(4);
  const notes: MidiNote[] = [];
  const trackNames: string[] = [];
  const tempos: { tick: number; bpm: number }[] = [];
  for (let tr = 0; tr < nTracks && o + 8 <= buf.length; tr++) {
    if (str(o, 4) !== "MTrk") throw new Error(`track ${tr}: no MTrk chunk`);
    const end = o + 8 + v.getUint32(o + 4);
    let p = o + 8, tick = 0, status = 0;
    const open = new Map<number, number[]>(); // channel·128+key → start ticks
    trackNames[tr] = "";
    const vlq = () => {
      let x = 0, b;
      do {
        b = buf[p++];
        x = (x << 7) | (b & 0x7f);
      } while (b & 0x80);
      return x;
    };
    const close = (ch: number, key: number) => {
      const s = open.get(ch * 128 + key);
      const t0 = s?.shift();
      if (t0 !== undefined) notes.push({ track: tr, channel: ch, midi: key, start: t0 / ppq, end: tick / ppq });
    };
    while (p < end) {
      tick += vlq();
      let st = buf[p];
      if (st & 0x80) p++;
      else st = status; // running status
      if (st === 0xff) {
        const type = buf[p++], len = vlq();
        if (type === 0x03 && !trackNames[tr]) trackNames[tr] = new TextDecoder("latin1").decode(buf.subarray(p, p + len)).trim();
        if (type === 0x51) tempos.push({ tick, bpm: 60e6 / ((buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2]) });
        p += len;
        continue;
      }
      if (st === 0xf0 || st === 0xf7) {
        p += vlq();
        continue;
      }
      status = st;
      const kind = st & 0xf0, ch = st & 0x0f;
      const d1 = buf[p++], d2 = kind === 0xc0 || kind === 0xd0 ? 0 : buf[p++];
      if (kind === 0x90 && d2 > 0) {
        const k = ch * 128 + d1;
        if (!open.has(k)) open.set(k, []);
        open.get(k)!.push(tick);
      } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) close(ch, d1);
    }
    o = end;
  }
  tempos.sort((a, b) => a.tick - b.tick);
  const distinct = tempos.filter((t, i) => i === 0 || Math.abs(t.bpm - tempos[i - 1].bpm) > 0.5);
  notes.sort((a, b) => a.start - b.start || b.midi - a.midi);
  return { ppq, bpm: tempos[0]?.bpm ?? 120, tempoChanges: Math.max(0, distinct.length - 1), notes, trackNames };
}

export interface LineOptions {
  track: number;
  channel?: number;
  pick?: "top" | "bottom";
  from?: number;
  to?: number;
  grid?: number;
}

/** One monophonic line as `[midi, beats]` with rests (0), starting at `from`. */
export function extractLine(f: MidiFile, o: LineOptions): [number, number][] {
  const grid = o.grid ?? 0.25;
  const q = (x: number) => Math.round(x / grid) * grid;
  const from = o.from ?? 0, to = o.to ?? Infinity;
  const ns = f.notes
    .filter((n) => n.track === o.track && (o.channel === undefined || n.channel === o.channel))
    .map((n) => ({ midi: n.midi, start: q(n.start), end: q(n.end) }))
    .filter((n) => n.end > n.start && n.start >= from - 1e-9 && n.start < to - 1e-9);
  // one note per start: the highest (or lowest)
  const byStart = new Map<number, { midi: number; end: number }>();
  for (const n of ns) {
    const b = byStart.get(n.start);
    if (!b || (o.pick === "bottom" ? n.midi < b.midi : n.midi > b.midi)) byStart.set(n.start, { midi: n.midi, end: n.end });
  }
  const starts = [...byStart.keys()].sort((a, b) => a - b);
  const out: [number, number][] = [];
  let t = starts.length ? starts[0] : from;
  starts.forEach((s, i) => {
    const n = byStart.get(s)!;
    if (s > t + 1e-9) out.push([0, s - t]);
    // a note ends where it ends, or where the next one starts
    const next = i + 1 < starts.length ? starts[i + 1] : Infinity;
    const e = Math.min(n.end, next, to);
    out.push([n.midi, e - s]);
    t = e;
  });
  return out;
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (m: number) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const has = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? (args.splice(i, 1), true) : false;
  };
  const out = flag("out"), from = flag("from"), to = flag("to"), grid = flag("grid");
  const bottom = has("bottom");
  has("top");
  const [file, sel] = args;
  if (!file) {
    console.error("usage: bun tools/midi-to-notes.ts <song.mid> [track[:channel]] [--top|--bottom] [--from beat] [--to beat] [--grid 0.25] [--out melody.json]");
    process.exit(1);
  }
  const f = readMidi(readFileSync(file));
  if (!sel) {
    console.log(`${file}: ${f.bpm.toFixed(1)} bpm${f.tempoChanges ? ` (${f.tempoChanges} tempo changes, ignored)` : ""}, ${f.ppq} ticks per beat`);
    const groups = new Map<string, MidiNote[]>();
    for (const n of f.notes) {
      const k = `${n.track}:${n.channel}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(n);
    }
    for (const [k, ns] of groups) {
      const tr = Number(k.split(":")[0]);
      const lo = Math.min(...ns.map((n) => n.midi)), hi = Math.max(...ns.map((n) => n.midi));
      const drums = k.endsWith(":9") ? " (drums)" : "";
      console.log(`  ${k.padEnd(6)} ${String(ns.length).padStart(5)} notes  ${noteName(lo)}–${noteName(hi)}  beats ${ns[0].start.toFixed(1)}–${ns[ns.length - 1].end.toFixed(1)}  ${f.trackNames[tr] ?? ""}${drums}`);
    }
    process.exit(0);
  }
  const [track, channel] = sel.split(":").map(Number);
  const notes = extractLine(f, { track, channel: Number.isFinite(channel) ? channel : undefined, pick: bottom ? "bottom" : "top", from: from ? Number(from) : undefined, to: to ? Number(to) : undefined, grid: grid ? Number(grid) : undefined });
  if (f.tempoChanges) console.warn(`warning: ${f.tempoChanges} tempo changes ignored; singing at ${f.bpm.toFixed(1)} bpm`);
  const melody = { bpm: Math.round(f.bpm * 10) / 10, t0: 0.3, notes };
  const sounding = notes.filter((n) => n[0] > 0).length;
  if (out) writeFileSync(out, JSON.stringify(melody));
  else console.log(JSON.stringify(melody));
  console.error(`${sounding} sung notes, ${notes.reduce((s, n) => s + n[1], 0).toFixed(2)} beats`);
}
