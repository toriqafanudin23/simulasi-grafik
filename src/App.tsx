import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from "react";
import { Activity, ArrowLeft, Circle, Compass, Download, Search, Sigma, Dot, Equal, Grid3x3, Hexagon, Home, Image as ImageIcon, Minus, MousePointer2, Plus, Redo2, Ruler, Shapes, Slash, SlidersHorizontal, SquareFunction, Trash2, Triangle, Undo2, Upload, X } from "lucide-react";
import { useJsxBoard, type SimBoard } from "./simulation/common/hooks/useJsxBoard";
import "./App.css";

/* ───────── Parser ekspresi aman ───────── */
const FN = ["sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "abs", "exp", "floor", "ceil", "round"];
type Vars = () => Record<string, number>;
function compile(src: string, vars?: Vars): (x: number) => number {
  if (!/^[\w\s+\-*/().,^π]+$/.test(src)) throw new Error("Karakter tidak valid");
  const names = Object.keys(vars?.() ?? {});
  let s = src.replace(/\^/g, "**").replace(/π/g, "pi").replace(/(\d|\))\s*(?=[a-zA-Z(])/g, "$1*").replace(/\bln\b/g, "log").replace(/\blog\b/g, "log10");
  const one = (c: string) => (names.includes(c) ? `P.${c}` : c === "x" ? "x" : "");
  s = s.replace(/[a-zA-Z_]+/g, (t) => {
    if (one(t)) return one(t);
    if (t === "pi") return "Math.PI";
    if (t === "e") return "Math.E";
    if (t === "log" || t === "log10" || FN.includes(t)) return `Math.${t}`;
    if (t.split("").every((c) => one(c))) return t.split("").map(one).join("*");
    throw new Error(`Tidak dikenal: ${t}`);
  });
  const f = new Function("x", "P", `return (${s})`) as (x: number, P: Record<string, number>) => number;
  const g = (x: number) => f(x, vars?.() ?? {});
  g(1);
  return g;
}

/* ───────── Model ───────── */
type Kind = "fn" | "pt" | "slider" | "segment" | "line" | "circle" | "perp" | "para" | "angle" | "polygon";
type Item = { id: number; kind: Kind; text: string; color: string; visible: boolean; x?: number; y?: number; name?: string; refs?: number[] };
const COLORS = ["#c74440", "#2d70b3", "#388c46", "#6557d2", "#fa7e19", "#000000"];
type Tool = "move" | "point" | "segment" | "line" | "circle" | "perp" | "para" | "angle" | "polygon";
type El = { id: string; X(): number; Y(): number; moveTo(c: number[]): void; setAttribute(a: object): void; on(e: string, f: () => void): void };
type Ent = { el: El; key: string };

const TOOLS: { id: Tool; label: string; icon: typeof Dot; need: number; hint: string }[] = [
  { id: "move", label: "Pindah", icon: MousePointer2, need: 0, hint: "Seret titik untuk memindahkan" },
  { id: "point", label: "Titik", icon: Dot, need: 1, hint: "Klik di grafik untuk membuat titik" },
  { id: "segment", label: "Ruas", icon: Minus, need: 2, hint: "Klik dua titik untuk ruas garis" },
  { id: "line", label: "Garis", icon: Slash, need: 2, hint: "Klik dua titik untuk garis" },
  { id: "circle", label: "Lingkaran", icon: Circle, need: 2, hint: "Klik pusat, lalu titik pada lingkaran" },
  { id: "perp", label: "Tegak lurus", icon: Ruler, need: 2, hint: "Klik titik lalu garis (atau sebaliknya)" },
  { id: "para", label: "Sejajar", icon: Equal, need: 2, hint: "Klik titik lalu garis (atau sebaliknya)" },
  { id: "angle", label: "Sudut", icon: Triangle, need: 3, hint: "Klik tiga titik; titik tengah = puncak sudut" },
  { id: "polygon", label: "Poligon", icon: Hexagon, need: 3, hint: "Klik titik-titik, lalu klik titik pertama untuk menutup" },
];
const KIND_NAME: Record<string, string> = { segment: "Ruas", line: "Garis", circle: "Lingkaran", perp: "Tegak lurus", para: "Sejajar", angle: "Sudut", polygon: "Poligon" };
const JXG_TYPE: Record<string, string> = { perp: "normal", para: "parallel" };
const dl = (n: string, b: Blob) => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = n; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };

let uid = 1;
function Calculator({ mode }: { mode: "graph" | "geo" }) {
  const geo = mode === "geo";
  const [items, setRaw] = useState<Item[]>(
    geo ? [] : [{ id: uid++, kind: "fn", text: "x^2 - 2", color: COLORS[0], visible: true }],
  );
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const [tool, setTool] = useState<Tool>("move");
  const [grid, setGrid] = useState(!geo);
  const toolRef = useRef(tool); toolRef.current = tool;
  const itemsRef = useRef(items); itemsRef.current = items;
  const past = useRef<Item[][]>([]);
  const future = useRef<Item[][]>([]);
  const snap = () => { past.current.push(itemsRef.current); if (past.current.length > 60) past.current.shift(); future.current = []; };
  const set = (fn: (p: Item[]) => Item[], record = true) => { if (record) snap(); setRaw(fn); };
  const undo = () => { const p = past.current.pop(); if (!p) return; future.current.push(itemsRef.current); setRaw(p); };
  const redo = () => { const n = future.current.pop(); if (!n) return; past.current.push(itemsRef.current); setRaw(n); };
  const vars: Vars = () => Object.fromEntries(itemsRef.current.filter((i) => i.kind === "slider").map((i) => [i.name!, i.x!]));
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).tagName === "INPUT") return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (key === "y" || (key === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const pend = useRef<number[]>([]);
  const ents = useRef(new Map<number, Ent>());
  const lastBoard = useRef<unknown>(null);
  const gridEl = useRef<{ setAttribute(a: object): void } | null>(null);

  const { boardProps, boardRef, zoomIn, zoomOut, resetView } = useJsxBoard({
    boundingBox: [-10, 7, 10, -7],
    zoomRange: [0.1, 20],
    setup: (b: SimBoard) => {
      gridEl.current = b.create("grid", [], { strokeColor: "#ddd", visible: !geo }) as never;
      b.create("axis", [[0, 0], [1, 0]], { strokeColor: "#555" });
      b.create("axis", [[0, 0], [0, 1]], { strokeColor: "#555" });
      const bx = b as unknown as { getAllObjectsUnderMouse(e: Event): { id: string }[]; getUsrCoordsOfMouse(e: Event): number[] };
      b.on("down", (e: Event) => {
        const tl = toolRef.current;
        if (tl === "move") return;
        const under = bx.getAllObjectsUnderMouse(e);
        const its = itemsRef.current;
        const find = (pred: (i: Item) => boolean) => {
          for (const [id, en] of ents.current) { const i = its.find((q) => q.id === id); if (i && pred(i) && under.some((u) => u.id === en.el.id)) return id; }
          return undefined;
        };
        const lineTool = tl === "perp" || tl === "para";
        let hit = find((i) => i.kind === "pt");
        if (hit === undefined && lineTool) hit = find((i) => i.kind === "line" || i.kind === "segment");
        const add: Item[] = [];
        if (hit === undefined) {
          const [x, y] = bx.getUsrCoordsOfMouse(e);
          const used = new Set(its.map((i) => i.name));
          let n = 0, name = "A";
          while (used.has(name)) { n++; name = String.fromCharCode(65 + (n % 26)) + (n >= 26 ? Math.floor(n / 26) : ""); }
          hit = uid++;
          add.push({ id: hit, kind: "pt", name, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, text: "", color: COLORS[1], visible: true });
        }
        const mk = (kind: Kind, refs: number[]): Item => ({ id: uid++, kind, text: "", color: COLORS[3], visible: true, refs });
        const pd = pend.current;
        if (tl === "point") pend.current = [];
        else if (tl === "polygon" && pd.length >= 3 && hit === pd[0]) { add.push(mk("polygon", [...pd])); pend.current = []; }
        else {
          pd.push(hit);
          const kindOf = (id: number) => [...add, ...its].find((q) => q.id === id)?.kind;
          if (lineTool) {
            if (pd.length >= 2) {
              const [a, c] = pd.slice(-2);
              const isL = (k?: Kind) => k === "line" || k === "segment";
              if (kindOf(a) === "pt" && isL(kindOf(c))) add.push(mk(tl as Kind, [c, a]));
              else if (kindOf(c) === "pt" && isL(kindOf(a))) add.push(mk(tl as Kind, [a, c]));
              pend.current = add.some((q) => q.kind === tl) ? [] : [hit];
            }
          } else if (tl !== "polygon") {
            const need = TOOLS.find((t) => t.id === tl)!.need;
            if (pd.length === need) { if (new Set(pd).size === need) add.push(mk(tl as Kind, [...pd])); pend.current = []; }
          }
        }
        if (add.length) set((p) => [...p, ...add]);
      });
    },
  });

  useEffect(() => { pend.current = []; }, [tool]);
  useEffect(() => { gridEl.current?.setAttribute({ visible: grid }); }, [grid]);

  /* Sinkronkan item → objek JSXGraph */
  useEffect(() => {
    const b = boardRef.current as unknown as { create(t: string, a: unknown[], o?: object): El; removeObject(e: unknown): void; update(): void } | null;
    if (!b) return;
    if (lastBoard.current !== b) { ents.current.clear(); lastBoard.current = b; }
    const m = ents.current;
    for (const [id, en] of [...m]) {
      const it = items.find((i) => i.id === id);
      if (!it || it.text !== en.key) { try { b.removeObject(en.el); } catch { /* sudah terhapus */ } m.delete(id); }
    }
    for (const it of items) {
      if (it.kind === "slider") continue;
      let en = m.get(it.id);
      const style = { strokeColor: it.color, visible: it.visible };
      if (!en) {
        try {
          if (it.kind === "fn") { const f = compile(it.text, vars); en = { el: b.create("functiongraph", [f], { ...style, strokeWidth: 2.5 }), key: it.text }; }
          else if (it.kind === "pt") {
            const p = b.create("point", [it.x!, it.y!], { ...style, name: it.name, size: 4, fillColor: it.color });
            p.on("down", snap);
            p.on("drag", () => set((q) => q.map((i) => (i.id === it.id ? { ...i, x: Math.round(p.X() * 100) / 100, y: Math.round(p.Y() * 100) / 100 } : i)), false));
            en = { el: p, key: it.text };
          } else {
            const els = it.refs!.map((r) => m.get(r)?.el);
            if (els.some((x) => !x)) continue;
            const type = JXG_TYPE[it.kind] ?? it.kind;
            en = { el: b.create(type, it.kind === "polygon" ? [els] : els, { ...style, strokeWidth: 2.5 }), key: it.text };
          }
          m.set(it.id, en);
        } catch { continue; }
      } else {
        en.el.setAttribute(style);
        if (it.kind === "pt" && (Math.abs(en.el.X() - it.x!) > 1e-6 || Math.abs(en.el.Y() - it.y!) > 1e-6)) en.el.moveTo([it.x!, it.y!]);
      }
    }
    b.update();
  }, [items, boardRef]);

  const submit = () => {
    const s = input.trim();
    if (!s) return;
    const pt = s.match(/^(?:([A-Za-z]\w*)\s*=\s*)?\(\s*(.+?)\s*,\s*(.+?)\s*\)$/);
    try {
      const color = COLORS[items.length % COLORS.length];
      const sl = s.match(/^([a-zA-Z])\s*=\s*(-?\d+(?:\.\d+)?)$/);
      if (sl) {
        if (sl[1] === "x" || sl[1] === "e" || items.some((i) => i.kind === "slider" && i.name === sl[1])) throw new Error("Nama tidak boleh dipakai");
        set((p) => [...p, { id: uid++, kind: "slider", name: sl[1], x: parseFloat(sl[2]), text: "", color, visible: true }]);
      } else if (pt) {
        const x = compile(pt[2], vars)(0), y = compile(pt[3], vars)(0);
        const name = pt[1] ?? String.fromCharCode(65 + (items.filter((i) => i.kind === "pt").length % 26));
        set([...items, { id: uid++, kind: "pt", name, x, y, text: "", color, visible: true }]);
      } else {
        const expr = s.replace(/^\s*(?:[a-z]\s*\(x\)|y)\s*=\s*/i, "");
        compile(expr, vars);
        set([...items, { id: uid++, kind: "fn", text: expr, color, visible: true }]);
      }
      setInput(""); setErr("");
    } catch (e) { setErr((e as Error).message || "Ekspresi tidak valid"); }
  };
  const edit = (id: number, text: string) => set((p) => p.map((i) => (i.id === id ? { ...i, text } : i)), false);
  const remove = (id: number) => set((p) => {
    const gone = new Set([id]);
    for (let n = 0; n < p.length; n++) for (const i of p) if (i.refs?.some((r) => gone.has(r))) gone.add(i.id);
    return p.filter((i) => !gone.has(i.id));
  });
  const label = (i: Item): string => {
    const nm = (r: number) => { const q = items.find((z) => z.id === r); return q ? (q.name ?? label(q)) : "?"; };
    if (i.kind === "pt") return `${i.name} = (${i.x}, ${i.y})`;
    return `${KIND_NAME[i.kind]} ${i.refs?.map(nm).join(i.kind === "perp" || i.kind === "para" ? " ∋ " : "")}`;
  };
  const addSlider = () => {
    const used = items.filter((i) => i.kind === "slider").map((i) => i.name);
    const name = [..."abcdghkmnpqrs"].find((c) => !used.includes(c));
    if (name) set((p) => [...p, { id: uid++, kind: "slider", name, x: 1, text: "", color: COLORS[4], visible: true }]);
  };
  const save = () => dl("geoclone.json", new Blob([JSON.stringify({ v: 1, items })], { type: "application/json" }));
  const load = async (f?: File) => {
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.items)) throw new Error();
      uid = Math.max(uid, ...d.items.map((i: Item) => i.id + 1));
      pend.current = []; set(() => d.items); setErr("");
    } catch { setErr("Berkas tidak valid"); }
  };
  const png = () => {
    const svg = document.querySelector<SVGSVGElement>(".gg-board svg");
    if (!svg) return;
    const r = svg.getBoundingClientRect(), img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = r.width * 2; c.height = r.height * 2;
      const g = c.getContext("2d")!; g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => b && dl("grafik.png", b));
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
  };

  return (
    <div className="gg-body">
      <aside className="gg-alg">
        <h3>Aljabar</h3>
        <div className="gg-rows">
          {items.map((i) => (
            <div className="gg-row" key={i.id}>
              <button className="gg-dot" aria-label="Tampilkan/sembunyikan" style={{ borderColor: i.color, background: i.visible ? i.color : "#fff" }}
                onClick={() => set((p) => p.map((q) => (q.id === i.id ? { ...q, visible: !q.visible } : q)))} />
              {i.kind === "fn" ? <input value={i.text} onFocus={snap} onChange={(e) => edit(i.id, e.target.value)} aria-label="Fungsi" />
                : i.kind === "slider" ? <><span>{i.name} = {i.x}</span><input type="range" min={-10} max={10} step={0.1} value={i.x} aria-label={`Slider ${i.name}`}
                    onPointerDown={snap} onChange={(e) => set((p) => p.map((q) => (q.id === i.id ? { ...q, x: parseFloat(e.target.value) } : q)), false)} /></>
                : <span style={{ flex: 1 }}>{label(i)}</span>}
              <button className="x" aria-label="Hapus" onClick={() => remove(i.id)}><X size={15} /></button>
            </div>
          ))}
        </div>
        {err && <div className="gg-err">{err}</div>}
        <div className="gg-new">
          <input placeholder="Masukkan… mis. sin(x), A=(2,3)" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
      </aside>
      <section className="gg-main">
        <div className="gg-tools" role="toolbar">
          {(geo ? TOOLS : TOOLS.slice(0, 2)).map((t) => (
            <button key={t.id} className={`gg-tool ${tool === t.id ? "on" : ""}`} onClick={() => setTool(t.id)} title={t.hint}><t.icon size={17} />{t.label}</button>
          ))}
          <span className="sp" />
          <button className="gg-tool" onClick={addSlider} title="Tambah slider"><SlidersHorizontal size={16} /></button>
          <button className="gg-tool" onClick={undo} title="Urungkan (Ctrl+Z)"><Undo2 size={16} /></button>
          <button className="gg-tool" onClick={redo} title="Ulangi (Ctrl+Y)"><Redo2 size={16} /></button>
          <button className="gg-tool" onClick={save} title="Simpan (.json)"><Download size={16} /></button>
          <button className="gg-tool" onClick={() => fileRef.current?.click()} title="Buka berkas"><Upload size={16} /></button>
          <button className="gg-tool" onClick={png} title="Ekspor PNG"><ImageIcon size={16} /></button>
          <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => { load(e.target.files?.[0]); e.target.value = ""; }} />
          <button className={`gg-tool ${grid ? "on" : ""}`} onClick={() => setGrid(!grid)} title="Kisi"><Grid3x3 size={16} /></button>
          <button className="gg-tool" onClick={resetView} title="Tampilan awal"><Home size={16} /></button>
          <button className="gg-tool" onClick={zoomIn} title="Perbesar"><Plus size={16} /></button>
          <button className="gg-tool" onClick={zoomOut} title="Perkecil"><Minus size={16} /></button>
          <button className="gg-tool" onClick={() => set([])} title="Hapus semua"><Trash2 size={16} /></button>
        </div>
        <div className="gg-board"><div {...boardProps} /><div className="gg-hint">{TOOLS.find((t) => t.id === tool)!.hint}</div></div>
      </section>
    </div>
  );
}

/* ───────── Galeri simulasi platform ───────── */
const L = (f: () => Promise<Record<string, unknown>>, k: string) =>
  lazy(() => f().then((m) => ({ default: m[k] as ComponentType })));
const SIMS: { title: string; desc: string; C: ComponentType }[] = [
  { title: "Plotter Grafik", desc: "Gambar banyak fungsi sekaligus.", C: L(() => import("./simulation/simulations/GraphPlotterSimulation"), "GraphPlotterSimulation") },
  { title: "Fungsi Kuadrat", desc: "Parabola, akar, dan titik puncak.", C: L(() => import("./simulation/simulations/QuadraticSimulation"), "QuadraticSimulation") },
  { title: "Transformasi Fungsi", desc: "Geser, regang, dan cerminkan fungsi.", C: L(() => import("./simulation/simulations/FunctionTransformationSimulation"), "FunctionTransformationSimulation") },
  { title: "Turunan", desc: "Garis singgung dan gradien.", C: L(() => import("./simulation/simulations/DerivativeSimulation"), "DerivativeSimulation") },
  { title: "Integral", desc: "Luas di bawah kurva.", C: L(() => import("./simulation/simulations/IntegralSimulation"), "IntegralSimulation") },
  { title: "Trigonometri", desc: "Lingkaran satuan dan grafik sinus.", C: L(() => import("./simulation/simulations/TrigonometrySimulation"), "TrigonometrySimulation") },
  { title: "Sistem Persamaan Linear", desc: "Titik potong dua garis.", C: L(() => import("./simulation/simulations/LinearSystemSimulation"), "LinearSystemSimulation") },
  { title: "Teorema Pythagoras", desc: "Bukti visual a² + b² = c².", C: L(() => import("./simulation/simulations/PythagorasSimulation"), "PythagorasSimulation") },
  { title: "Transformasi Geometri", desc: "Translasi, refleksi, rotasi, dilatasi.", C: L(() => import("./simulation/simulations/TransformationSimulation"), "TransformationSimulation") },
  { title: "Titik Pusat Segitiga", desc: "Berat, garis tinggi, bagi, sumbu.", C: L(() => import("./simulation/simulations/TriangleCentersSimulation"), "TriangleCentersSimulation") },
  { title: "Lingkaran & Juring", desc: "Busur, juring, tembereng.", C: L(() => import("./simulation/simulations/CircleSectorSimulation"), "CircleSectorSimulation") },
  { title: "Dua Lingkaran Bersinggungan", desc: "Garis singgung persekutuan.", C: L(() => import("./simulation/simulations/TwoCircleTangentSimulation"), "TwoCircleTangentSimulation") },
  { title: "Irisan Kerucut", desc: "Elips, parabola, hiperbola.", C: L(() => import("./simulation/simulations/ConicSectionsSimulation"), "ConicSectionsSimulation") },
  { title: "Bangun Ruang 3D", desc: "Putar kubus, limas, tabung; jaring-jaring dan jarak.", C: L(() => import("./simulation/simulations/Solid3DSimulation"), "Solid3DSimulation") },
  { title: "Vektor", desc: "Penjumlahan dan komponen vektor.", C: L(() => import("./simulation/simulations/VectorSimulation"), "VectorSimulation") },
];

const CAT: Record<string, [string, typeof Sigma, string]> = {
  "Plotter Grafik": ["Fungsi", SquareFunction, "#6557d2"], "Fungsi Kuadrat": ["Fungsi", SquareFunction, "#6557d2"], "Transformasi Fungsi": ["Fungsi", SquareFunction, "#6557d2"],
  "Sistem Persamaan Linear": ["Fungsi", Slash, "#6557d2"], "Turunan": ["Kalkulus", Sigma, "#c74440"], "Integral": ["Kalkulus", Sigma, "#c74440"],
  "Trigonometri": ["Trigonometri", Activity, "#388c46"], "Teorema Pythagoras": ["Geometri", Triangle, "#2d70b3"], "Transformasi Geometri": ["Geometri", Shapes, "#2d70b3"],
  "Titik Pusat Segitiga": ["Geometri", Triangle, "#2d70b3"], "Lingkaran & Juring": ["Geometri", Circle, "#2d70b3"], "Dua Lingkaran Bersinggungan": ["Geometri", Circle, "#2d70b3"],
  "Bangun Ruang 3D": ["Geometri", Hexagon, "#2d70b3"],
  "Irisan Kerucut": ["Geometri", Compass, "#2d70b3"], "Vektor": ["Geometri", MousePointer2, "#2d70b3"],
};
const CATS = ["Semua", "Fungsi", "Kalkulus", "Trigonometri", "Geometri"];

function Gallery() {
  const [open, setOpen] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("Semua");
  if (open !== null) {
    const Sim = SIMS[open].C;
    return (
      <div className="gg-sim">
        <div className="gg-crumb">
          <button onClick={() => setOpen(null)} aria-label="Kembali"><ArrowLeft size={18} /></button>
          <div><h2>{SIMS[open].title}</h2><small>Simulasi · {CAT[SIMS[open].title][0]}</small></div>
        </div>
        <div className="gg-frame"><Suspense fallback={<p style={{ padding: 20 }}>Memuat…</p>}><Sim /></Suspense></div>
      </div>
    );
  }
  const list = SIMS.map((x, i) => ({ ...x, i })).filter((x) => (cat === "Semua" || CAT[x.title][0] === cat) && (x.title + x.desc).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="gg-gal">
      <div className="gg-hero">
        <h1>Simulasi Matematika</h1>
        <label className="gg-search"><Search size={18} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari simulasi…" /></label>
        <div className="gg-chips">{CATS.map((c) => <button key={c} className={c === cat ? "on" : ""} onClick={() => setCat(c)}>{c}</button>)}</div>
      </div>
      <div className="gg-grid">
        {list.map((x) => { const [k, Ic, col] = CAT[x.title]; return (
          <button key={x.title} className="gg-card" onClick={() => setOpen(x.i)}>
            <div className="gg-thumb" style={{ background: `linear-gradient(135deg,${col}22,${col}55)` }}>
              <svg viewBox="0 0 100 40" preserveAspectRatio="none"><path d="M0 20 Q 12 -5 25 20 T 50 20 T 75 20 T 100 20" fill="none" stroke={col} strokeOpacity=".35" strokeWidth="1.5" /></svg>
              <Ic size={44} color={col} />
            </div>
            <div className="gg-meta"><b>{x.title}</b><span>{x.desc}</span><small>Simulasi · {k}</small></div>
          </button>); })}
        {!list.length && <p style={{ color: "#666" }}>Tidak ada simulasi yang cocok.</p>}
      </div>
    </div>
  );
}

export default function App() {
  const [app, setApp] = useState<"graph" | "geo" | "sim">("graph");
  const TABS = [{ id: "graph", label: "Kalkulator Grafik", icon: SquareFunction }, { id: "geo", label: "Geometri", icon: Shapes }, { id: "sim", label: "Simulasi", icon: Grid3x3 }] as const;
  return (
    <div className="gg">
      <header className="gg-top">
        <span className="gg-logo"><i className="gg-mark">G</i><b>GeoClone</b></span>
        {TABS.map((t) => (<button key={t.id} className={`gg-tab ${app === t.id ? "on" : ""}`} title={t.label} aria-current={app === t.id ? "page" : undefined} onClick={() => setApp(t.id)}><t.icon size={17} /><span>{t.label}</span></button>))}
      </header>
      {app === "sim" ? <Gallery /> : <Calculator key={app} mode={app} />}
    </div>
  );
}
