/**
 * The choir page (`?choir=<id>`): a pre-rendered song for four voices, sung by four cartoon
 * singers on one 3D stage, each the face screen's own head (the airway, tongue and larynx at work) on a robe, with a look of their own. Like the duet page, nothing is
 * synthesized here: the page plays the mixed track and replays each voice's recorded telemetry
 * at the playhead, so every mouth moves as the engine did.
 *
 * The show is the duet's folder format (`public/shows/<id>/show.json`, see DuetPage.tsx); a voice
 * may name its `look` (propeller, sunhat, viking, tophat; padre, compadecida, gonzaga, lampiao), otherwise the first four go in that order.
 * `bun tools/make-choir.ts` makes a demo show, `choir`.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Screen } from "./Screen.tsx";
import { TeleTrack } from "../../show/tele.ts";
import { Transport } from "../../show/transport.ts";
import { Choir3D, type Look, type SingerSpec } from "../render/choir3d.ts";
import { Glow, label } from "../render/vector.ts";
import { getModel } from "../useModel.ts";
import { VoiceModel } from "../analysis.ts";
import { V } from "../colors.ts";
import { g2p } from "../speech.ts";
import { lyricsToSyllables } from "../../wasm/engine.ts";
import { sungWords, wordAt, type Melody, type SungWords } from "../../show/words.ts";

interface ShowFile {
  title: string;
  audio: string;
  bpm?: number;
  downbeat?: number;
  spell?: Record<string, string>;
  voices: { name: string; tele: string; melody?: string; look?: Look }[];
}

interface Voice {
  name: string;
  track: TeleTrack;
  words: SungWords | null;
  spec: SingerSpec;
}

/** the four characters, in order */
const CAST: { look: Look; color: string; who: string }[] = [
  { look: "propeller", color: V.green, who: "Pip" },
  { look: "sunhat", color: V.pink, who: "Rosa" },
  { look: "viking", color: V.red, who: "Ivo" },
  { look: "tophat", color: V.white, who: "Basil" },
  { look: "padre", color: V.white, who: "Padre" },
  { look: "compadecida", color: V.pink, who: "Compadecida" },
  { look: "gonzaga", color: V.green, who: "Luiz Gonzaga" },
  { look: "lampiao", color: V.red, who: "Lampião" },
];

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return r;
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export function ChoirPage(props: { id: string }) {
  const base = `${import.meta.env.BASE_URL}shows/${props.id}/`;
  const [transport, setTransport] = useState<Transport | null>(null);
  const [loaded, setLoaded] = useState<{ show: ShowFile; voices: Voice[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const t = new Transport();
    setTransport(t);
    return () => t.dispose();
  }, []);

  useEffect(() => {
    if (!transport) return;
    let live = true;
    setLoaded(null);
    (async () => {
      const show = (await (await fetchOk(base + "show.json")).json()) as ShowFile;
      if (!show.voices?.length || !show.audio) throw new Error("show.json needs audio and voices");
      const [audio, ...teles] = await Promise.all([fetchOk(base + show.audio).then((r) => r.arrayBuffer()), ...show.voices.map((v) => fetchOk(base + v.tele).then((r) => r.arrayBuffer()))]);
      const melodies = await Promise.all(show.voices.map((v) => (v.melody ? fetchOk(base + v.melody).then((r) => r.json() as Promise<Melody>) : null)));
      if (melodies.some(Boolean)) await g2p.load().catch(() => {});
      const voices = show.voices.slice(0, 4).map((v, i): Voice => {
        const track = new TeleTrack(teles[i]);
        const m = melodies[i];
        let words: SungWords | null = null;
        if (m)
          try {
            words = sungWords(m, m.syllables ?? lyricsToSyllables(m.lyrics), show.spell);
          } catch (e) {
            console.warn("choir: no words for a voice:", e);
          }
        const cast = CAST.find((c) => c.look === v.look) ?? CAST[i % CAST.length];
        return { name: v.name, track, words, spec: { look: cast.look, color: cast.color, model: getModel(track.body, track.sampleRate) } };
      });
      await transport.load(audio);
      if (live) setLoaded({ show, voices });
    })().catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [base, transport]);

  useEffect(() => {
    if (!transport) return;
    const off = transport.subscribe(() => setTick((n) => n + 1));
    const id = setInterval(() => transport.isPlaying && setTick((n) => n + 1), 250);
    return () => {
      off();
      clearInterval(id);
    };
  }, [transport]);

  if (error)
    return (
      <div className="duet">
        <p className="duet-msg error">This show could not load: {error}</p>
      </div>
    );
  const st = transport?.state ?? { playing: false, time: 0, duration: 0, epoch: 0 };
  return (
    <div className="duet choir">
      <header className="duet-top">
        <span className="wordmark">Chimera</span>
        <span className="duet-title">{loaded?.show.title ?? "Loading…"}</span>
      </header>
      <Screen className="choir-stage" focus title="Choir" sub={loaded ? loaded.voices.map((v) => `${CAST.find((c) => c.look === v.spec.look)?.who}, ${v.name}`).join(" · ") : undefined} label="Four singers on a stage, in 3D">
        {loaded && transport ? <Stage voices={loaded.voices} show={loaded.show} transport={transport} /> : <p className="duet-msg">Loading the song…</p>}
      </Screen>
      <footer className="duet-bar">
        <button className="primary large" disabled={!loaded} onClick={() => (st.playing ? transport?.pause() : transport?.play())}>
          {st.playing ? "Pause" : st.duration > 0 && st.time >= st.duration - 0.05 ? "Again" : "Play"}
        </button>
        <span className="duet-time">
          {clock(st.time)} / {clock(st.duration)}
        </span>
        <input
          type="range"
          aria-label="Position in the song"
          min={0}
          max={st.duration || 1}
          step={0.1}
          value={st.time}
          disabled={!loaded}
          onChange={(e) => transport?.seek(Number(e.target.value))}
          style={{ "--pos": `${st.duration ? (100 * st.time) / st.duration : 0}%` } as React.CSSProperties}
        />
      </footer>
    </div>
  );
}

function Stage({ voices, show, transport }: { voices: Voice[]; show: ShowFile; transport: Transport }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const wrap = wrapRef.current!;
    const glCanvas = document.createElement("canvas");
    let gl: THREE.WebGLRenderer;
    try {
      gl = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false });
    } catch {
      setFailed(true);
      return;
    }
    gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    gl.setClearColor(0x000000, 1);
    const stage = new Choir3D(voices.map((v) => v.spec));
    const controls = new OrbitControls(stage.camera, canvas);
    controls.target.copy(stage.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 6;
    controls.maxDistance = 40;
    controls.maxPolarAngle = Math.PI * 0.53;
    controls.screenSpacePanning = true;
    const home = () => {
      const p = stage.homePose();
      stage.camera.position.copy(p.pos);
      controls.target.copy(p.target);
    };
    canvas.addEventListener("dblclick", home);
    const glow = new Glow();

    let w = 0, h = 0, dpr = 1, moved = false;
    controls.addEventListener("start", () => (moved = true));
    const fit = () => {
      const b = wrap.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, b.width);
      h = Math.max(1, b.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      gl.setPixelRatio(dpr);
      gl.setSize(w, h, false);
      stage.resize(w, h);
      if (!moved) home();
    };
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);

    let raf = 0, last = performance.now();
    const loop = (nowMs: number) => {
      const dt = Math.min(0.05, (nowMs - last) / 1000);
      last = nowMs;
      const t = transport.time();
      const beat = show.bpm ? ((t - (show.downbeat ?? 0)) * show.bpm) / 60 : 0;
      controls.update(dt);
      stage.update(
        voices.map((v) => {
          const msg = v.track.message(v.track.indexAt(t));
          return { tele: transport.isPlaying ? msg : null, artic: VoiceModel.articFromArray(msg.t.artic), beat, epoch: transport.epoch };
        }),
        dt,
        nowMs / 1000,
      );
      stage.render(gl);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(glCanvas, 0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // each singer's syllable over the hat, in the singer's colour
      voices.forEach((v, i) => {
        const word = v.words ? wordAt(v.words, t) : null;
        if (!word) return;
        const [x, y, front] = stage.project(i);
        // kept inside the screen (a tall hat can reach its top)
        if (front) label(ctx, word.text.toUpperCase(), x, Math.max(22, y), { size: 15, align: "center", color: v.spec.color, ls: 0.1, moving: true });
      });
      glow.apply(canvas, ctx, dpr);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("dblclick", home);
      controls.dispose();
      stage.dispose();
      gl.dispose();
      gl.forceContextLoss();
    };
  }, [voices, show, transport]);

  if (failed) return <p className="duet-msg">The choir needs WebGL, which this browser has turned off.</p>;
  return (
    <div ref={wrapRef} className="anatomy three">
      <canvas ref={canvasRef} aria-label="Four singers on a stage. Drag to turn round them, scroll or pinch to zoom, double-click to go back." role="img" />
    </div>
  );
}
