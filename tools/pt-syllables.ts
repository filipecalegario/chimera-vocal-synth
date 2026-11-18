/**
 * Brazilian Portuguese lyrics → the sung syllables `chimera render notes` takes (`"syllables"`,
 * docs/language-front-ends.md "The one format"), by spelling rules. Not a front end of the
 * engine: a local tool for singing a Portuguese song now; a native ear checks what it reads.
 *
 *   bun tools/pt-syllables.ts <lyrics.txt> [--out syllables.json] [--melody m.json --sung out.json]
 *                             [--show] [--ti tʃ|t] [--r h|x|ʁ] [--final-r]
 *
 * The lyrics: one phrase per line (the line's end is a breath). Words split into syllables by
 * the rules below; a hyphen inside a word forces the split ("can-ta"). A lone `_` is one more
 * note on the vowel before (a melisma). With `--melody`, the syllables are put on its notes and
 * written to `--sung`; the counts must match. It prints only counts per line (the lyrics stay out
 * of logs); `--show` prints what it read.
 *
 * Rules (a general Brazilian reading; `--ti t` keeps t and d before i, as much of the Northeast):
 *  - syllables: V-CV; a stop or f/v + l/r start a syllable together; lh nh ch rr ss qu gu are one
 *    sound; falling diphthongs (ai ei oi ui au eu ou iu ão ãe õe) stay together, other vowel pairs
 *    split, and i/u before nh or a final r l m n z split too (ra-i-nha, ca-ir).
 *  - stress: an accent mark; else words ending in a e o (s), am em ens on the second-last; else the
 *    last. Short function words (de, que, o, a, os, me, se, lhe, em, um, com, por, pra...) have none.
 *  - vowels: é ó open, ê ô closed; unstressed final a e o are ɐ i u; a vowel before m/n in its
 *    syllable is nasal (the consonant goes), as is a stressed a before m n nh (cama); final am is
 *    ɐ̃w, em ẽj, ão ɐ̃w, ãe ɐ̃j, õe õj; ou is o.
 *  - consonants: r at a word's start, after n l s, and rr is strong (`--r`, h by default), elsewhere
 *    a tap ɾ; r closing a syllable is strong, and dropped at a word's end unless `--final-r`;
 *    l closing a syllable is w; s between vowels z, before a voiced consonant z; c ç g j x ch lh nh
 *    qu gu as spelled; h is silent; t d before an i sound tʃ dʒ (`--ti`).
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface Seg {
  ipa: string;
}
export interface Syllable {
  text: string;
  onset: Seg[];
  nucleus: Seg;
  coda: Seg[];
  wordEnd?: boolean;
  phraseEnd?: boolean;
  melisma?: boolean;
}

export interface PtOptions {
  /** t d before i: "tʃ" (most of Brazil) or "t" (much of the Northeast) */
  ti?: "tʃ" | "t";
  /** the strong r */
  r?: string;
  /** sing a word-final r */
  finalR?: boolean;
}

const VOWELS = "aeiouáéíóúâêôãõàüy";
const isV = (u: string) => u.length === 1 && VOWELS.includes(u);
const FRONT = "eiéêí";
const CLITICS = new Set(["a", "o", "as", "os", "e", "de", "do", "da", "dos", "das", "que", "se", "me", "te", "lhe", "lhes", "nos", "no", "na", "nas", "em", "um", "uns", "com", "por", "pra", "pro", "sem", "nem", "mas", "ao", "aos", "meu", "teu", "seu", "mo", "ma"]);

/** a word's sound units: one letter, or a digraph that is one sound */
function units(w: string): string[] {
  const u: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const c = w[i], n = w[i + 1] ?? "", nn = w[i + 2] ?? "";
    if ((c === "c" || c === "l" || c === "n") && n === "h") {
      u.push(c + "h");
      i++;
    } else if ((c === "r" || c === "s") && n === c) {
      u.push(c + c);
      i++;
    } else if ((c === "q" || c === "g") && (n === "u" || n === "ü") && isV(nn)) {
      // qu, gu: the u is silent before e i (unless ü), a glide before a o
      u.push(FRONT.includes(nn) && n === "u" ? c + "u" : c + "w");
      i++;
    } else if (c === "h") {
      // silent
    } else u.push(c);
  }
  return u;
}

/** the units split into syllables (each a list of units) */
function syllabify(u: string[]): string[][] {
  // nuclei: runs of vowels, split into syllable peaks
  const peak: number[] = []; // unit index → syllable index of its nucleus, or -1
  let n = -1;
  for (let i = 0; i < u.length; i++) {
    if (!isV(u[i])) {
      peak.push(-1);
      continue;
    }
    const prev = i > 0 && isV(u[i - 1]) ? u[i - 1] : null;
    let joins = false;
    if (prev && peak[i - 1] >= 0) {
      const pair = prev + u[i];
      const glide = (u[i] === "i" || u[i] === "u") && !(prev === "i" || prev === "u") || pair === "ui" || pair === "iu";
      const nasal = pair === "ão" || pair === "ãe" || pair === "õe";
      // the vowel before already took a glide: a third vowel starts its own syllable
      const taken = i >= 2 && isV(u[i - 2]) && peak[i - 2] === peak[i - 1];
      // i/u before nh, or before a closing r l m n z (ra-i-nha, ca-ir, ru-im) are their own
      const after = u[i + 1] ?? "", after2 = u[i + 2] ?? "";
      const closes = "rlmnz".includes(after) && after.length === 1 && (after2 === "" || !isV(after2));
      joins = !taken && (nasal || (glide && after !== "nh" && !closes));
    }
    if (!joins) n++;
    peak.push(n);
  }
  if (n < 0) return [u];
  const syl: string[][] = Array.from({ length: n + 1 }, () => []);
  // consonants between nuclei: the last one (or a stop/f/v + l/r pair) begins the next syllable
  let i = 0;
  const firstV = peak.findIndex((p) => p >= 0);
  for (; i < firstV; i++) syl[0].push(u[i]);
  while (i < u.length) {
    const s = peak[i];
    while (i < u.length && peak[i] === s) syl[s].push(u[i++]);
    const cs: string[] = [];
    while (i < u.length && peak[i] < 0) cs.push(u[i++]);
    if (i >= u.length) {
      syl[s].push(...cs);
      break;
    }
    let k = cs.length - 1; // first consonant of the next onset
    if (cs.length >= 2 && "lr".includes(cs[cs.length - 1]) && "pbtdcgfvk".includes(cs[cs.length - 2])) k = cs.length - 2;
    if (cs.length === 0) k = 0;
    syl[s].push(...cs.slice(0, k));
    syl[s + 1].push(...cs.slice(k));
  }
  return syl;
}

/** which syllable carries the stress (-1: none, a clitic) */
function stressOf(word: string, syl: string[][]): number {
  if (CLITICS.has(word)) return -1;
  const acute = syl.findIndex((s) => s.some((c) => /[áéíóúâêô]/.test(c)));
  if (acute >= 0) return acute;
  const tilde = syl.findIndex((s) => s.some((c) => /[ãõ]/.test(c)));
  if (tilde >= 0) return tilde;
  if (syl.length === 1) return 0;
  return /([aeo]s?|am|em|ens)$/.test(word) ? syl.length - 2 : syl.length - 1;
}

const VOWEL_IPA: Record<string, string> = { a: "a", á: "a", à: "a", â: "ɐ", ã: "ɐ̃", e: "e", é: "ɛ", ê: "e", i: "i", í: "i", y: "i", o: "o", ó: "ɔ", ô: "o", õ: "õ", u: "u", ú: "u", ü: "u" };
const NASAL: Record<string, string> = { a: "ɐ̃", e: "ẽ", i: "ĩ", o: "õ", u: "ũ", ɐ: "ɐ̃", ɛ: "ẽ", ɔ: "õ" };
const VOICED = new Set(["b", "d", "g", "v", "m", "n", "l", "ɾ", "ʒ", "dʒ", "z", "ɲ", "ʎ"]);

/** One word's syllables, read aloud. */
export function readWord(raw: string, o: PtOptions = {}): Syllable[] {
  const R = o.r ?? "h", TI = o.ti ?? "tʃ";
  const word = raw.toLowerCase().normalize("NFC");
  const forced = word.includes("-");
  const plain = word.replace(/-/g, "");
  const syl = forced ? word.split("-").filter(Boolean).map(units) : syllabify(units(plain));
  const stress = stressOf(plain, syl);
  const out: Syllable[] = [];
  syl.forEach((s, si) => {
    const last = si === syl.length - 1;
    const stressed = si === stress;
    const vi = s.findIndex(isV);
    if (vi < 0) {
      // no vowel (a stray consonant): hang it on the syllable before
      if (out.length) out[out.length - 1].coda.push(...s.map((c) => ({ ipa: c })));
      return;
    }
    let ve = vi;
    while (ve + 1 < s.length && isV(s[ve + 1])) ve++;
    const on = s.slice(0, vi), vs = s.slice(vi, ve + 1), cod = s.slice(ve + 1);
    // the consonant closing the syllable before, if one does
    const prevLast = si > 0 ? syl[si - 1][syl[si - 1].length - 1] : "";
    const prevCoda = prevLast && !isV(prevLast) ? prevLast : "";
    const nextOnset = si + 1 < syl.length ? syl[si + 1][0] : "";

    // the vowel(s)
    let v = VOWEL_IPA[vs[0]] ?? vs[0];
    let glide = "";
    if (vs.length > 1) {
      const g = vs[1];
      if (vs[0] === "o" && g === "u") glide = ""; // ou → o
      else glide = g === "e" ? "j" : g === "o" ? "w" : g === "i" || g === "í" ? "j" : "w";
    }
    const reduced = !stressed && last;
    if (reduced && vs.length === 1) v = v === "a" ? "ɐ" : v === "e" ? "i" : v === "o" ? "u" : v;
    // nasal: m/n closing the syllable, or a stressed a before m n nh
    let coda = [...cod];
    const nasalCoda = coda.length > 0 && (coda[0] === "m" || coda[0] === "n");
    if (nasalCoda) {
      coda = coda.slice(1);
      if (last && coda.length === 0 && (vs.join("") === "a" || vs.join("") === "e") && cod[0] === "m") {
        // final am (unstressed): ɐ̃w; em: ẽj
        v = vs[0] === "a" ? "ɐ̃" : "ẽ";
        glide = vs[0] === "a" ? "w" : "j";
      } else if (last && vs.join("") === "e" && cod.join("") === "ns") {
        v = "ẽ";
        glide = "j";
      } else v = NASAL[v] ?? v;
    } else if (stressed && vs[0] === "a" && ["m", "n", "nh"].includes(nextOnset)) v = "ɐ̃";
    if (vs.join("") === "ão" || vs.join("") === "ãe" || vs.join("") === "õe") glide = vs[1] === "o" ? "w" : "j";

    // the onset
    const onset: Seg[] = [];
    on.forEach((c, k) => {
      const nextV = vs[0];
      const first = si === 0 && k === 0;
      const front = FRONT.includes(nextV) || (reduced && nextV === "e");
      const iSound = v.startsWith("i") || v.startsWith("ĩ");
      if (c === "r") onset.push({ ipa: first || (k === 0 && ["n", "l", "s"].includes(prevCoda)) ? R : "ɾ" });
      else if (c === "rr") onset.push({ ipa: R });
      else if (c === "ss") onset.push({ ipa: "s" });
      else if (c === "s") onset.push({ ipa: !first && k === 0 && !prevCoda && si > 0 ? "z" : "s" });
      else if (c === "c") onset.push({ ipa: front ? "s" : "k" });
      else if (c === "ç") onset.push({ ipa: "s" });
      else if (c === "g") onset.push({ ipa: front ? "ʒ" : "g" });
      else if (c === "j") onset.push({ ipa: "ʒ" });
      else if (c === "x" || c === "ch") onset.push({ ipa: "ʃ" });
      else if (c === "lh") onset.push({ ipa: "ʎ" });
      else if (c === "nh") onset.push({ ipa: "ɲ" });
      else if (c === "qu" || c === "gu") onset.push({ ipa: c[0] === "q" ? "k" : "g" });
      else if (c === "qw" || c === "gw") onset.push({ ipa: c[0] === "q" ? "k" : "g" }, { ipa: "w" });
      else if ((c === "t" || c === "d") && iSound && k === on.length - 1) onset.push({ ipa: TI === "t" ? c : c === "t" ? "tʃ" : "dʒ" });
      else if (c === "z") onset.push({ ipa: "z" });
      else if (c === "y") onset.push({ ipa: "j" });
      else onset.push({ ipa: c });
    });

    // the coda
    const codaOut: Seg[] = [];
    if (glide) codaOut.push({ ipa: glide });
    coda.forEach((c, k) => {
      const end = last && k === coda.length - 1;
      if (c === "s" || c === "z" || c === "x") {
        const voicedNext = !last && VOICED.has(nextOnset === "r" ? "ɾ" : nextOnset);
        codaOut.push({ ipa: voicedNext ? "z" : "s" });
      } else if (c === "r") {
        if (!end || o.finalR) codaOut.push({ ipa: R });
      } else if (c === "l") codaOut.push({ ipa: "w" });
      else if (c === "m" || c === "n") v = NASAL[v] ?? v;
      else codaOut.push({ ipa: c });
    });
    // a falling diphthong the planner knows sings as one nucleus
    let nucleus = v;
    const known: Record<string, string> = { "aj": "aɪ", "ej": "eɪ", "ɔj": "ɔɪ", "aw": "aʊ" };
    if (codaOut[0] && known[v + codaOut[0].ipa]) {
      nucleus = known[v + codaOut[0].ipa];
      codaOut.shift();
    }
    out.push({ text: s.join("").replace(/qw/g, "qu").replace(/gw/g, "gu"), onset, nucleus: { ipa: nucleus }, coda: codaOut });
  });
  if (out.length) out[out.length - 1].wordEnd = true;
  return out;
}

/** The lyrics, line by line: syllables with word and phrase ends, and `_` melismas. */
export function readLyrics(text: string, o: PtOptions = {}): { syllables: Syllable[]; perLine: number[] } {
  const syllables: Syllable[] = [];
  const perLine: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const words = line.replace(/[.,;:!?¡¿"“”()…—–]/g, " ").split(/\s+/).filter(Boolean);
    const before = syllables.length;
    for (const w of words) {
      if (/^_+$/.test(w)) {
        for (let k = 0; k < w.length; k++) {
          const p = syllables[syllables.length - 1];
          if (!p) continue;
          // the run's coda moves to its last note
          syllables.push({ text: "_", onset: [], nucleus: p.nucleus, coda: p.coda, wordEnd: p.wordEnd, melisma: true });
          p.coda = [];
          p.wordEnd = false;
        }
        continue;
      }
      const clean = w.replace(/[^a-záéíóúâêôãõàüçy\-]/gi, "");
      if (clean) syllables.push(...readWord(clean, o));
    }
    if (syllables.length > before) {
      syllables[syllables.length - 1].phraseEnd = true;
      perLine.push(syllables.length - before);
    }
  }
  return { syllables, perLine };
}

/** the melody's phrases: sung notes between rests of half a beat or more */
export function phrases(notes: [number, number][]): number[] {
  const out: number[] = [];
  let n = 0;
  for (const [m, b] of notes) {
    if (m > 0) n++;
    else if (b >= 0.5 && n) {
      out.push(n);
      n = 0;
    }
  }
  if (n) out.push(n);
  return out;
}

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
  const out = flag("out"), melodyPath = flag("melody"), sungPath = flag("sung"), ti = flag("ti"), r = flag("r");
  const show = has("show"), finalR = has("final-r");
  const [file] = args;
  if (!file) {
    console.error("usage: bun tools/pt-syllables.ts <lyrics.txt> [--out syllables.json] [--melody m.json --sung out.json] [--show] [--ti tʃ|t] [--r h|x|ʁ] [--final-r]");
    process.exit(1);
  }
  const { syllables, perLine } = readLyrics(readFileSync(file, "utf8"), { ti: ti === "t" ? "t" : "tʃ", r, finalR });
  console.log(`${syllables.length} sung syllables in ${perLine.length} lines: ${perLine.join(" ")}`);
  if (show) for (const s of syllables) console.log(`${s.text.padEnd(6)} ${[...s.onset.map((x) => x.ipa), s.nucleus.ipa, ...s.coda.map((x) => x.ipa)].join(" ")}${s.wordEnd ? "  |" : ""}${s.phraseEnd ? "|" : ""}`);
  if (out) writeFileSync(out, JSON.stringify(syllables, null, 1));
  if (melodyPath) {
    const m = JSON.parse(readFileSync(melodyPath, "utf8"));
    const sung = m.notes.filter((n: [number, number]) => n[0] > 0).length;
    console.log(`melody: ${sung} sung notes in ${phrases(m.notes).length} phrases: ${phrases(m.notes).join(" ")}`);
    if (sung !== syllables.length) {
      console.error(`${syllables.length} syllables for ${sung} notes: they must match (split or join syllables with - and _, or cut the melody)`);
      process.exit(1);
    }
    if (sungPath) {
      delete m.lyrics;
      writeFileSync(sungPath, JSON.stringify({ ...m, syllables }));
      console.log(`wrote ${sungPath}`);
    }
  }
}
