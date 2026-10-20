import { SimulationShell } from "../common/components/SimulationShell";
import { useStoredSimulationState } from "../common/hooks/useStoredSimulationState";
import { formatNumber as fmt } from "../common/utils/simUtils";
import "./Solid3DSimulation.css";

type Shape = "kubus" | "balok" | "limas" | "prisma" | "tabung" | "kerucut" | "bola";
type V3 = [number, number, number];
type Mode = "3d" | "net" | "dist";
type S = { shape: Shape; p: number; l: number; t: number; r: number; n: number; mode: Mode; yaw: number; pitch: number; zoom: number; dk: "plane" | "line"; di: number; pt: V3; hide: boolean };
const DEF: S = { shape: "balok", p: 4, l: 3, t: 2.5, r: 2, n: 4, mode: "3d", yaw: -0.6, pitch: 0.45, zoom: 1, dk: "plane", di: 0, pt: [1.5, -1, 2.5], hide: true };
const NAME: Record<Shape, string> = { kubus: "Kubus", balok: "Balok", limas: "Limas", prisma: "Prisma", tabung: "Tabung", kerucut: "Kerucut", bola: "Bola" };
const FIELDS: Record<Shape, [keyof S, string, number, number, number][]> = {
  kubus: [["p", "Rusuk", 1, 8, 0.1]], balok: [["p", "Panjang", 1, 8, 0.1], ["l", "Lebar", 1, 8, 0.1], ["t", "Tinggi", 1, 8, 0.1]],
  limas: [["n", "Sisi alas (n)", 3, 8, 1], ["p", "Panjang sisi alas", 1, 6, 0.1], ["t", "Tinggi", 1, 8, 0.1]],
  prisma: [["n", "Sisi alas (n)", 3, 8, 1], ["p", "Panjang sisi alas", 1, 6, 0.1], ["t", "Tinggi", 1, 8, 0.1]],
  tabung: [["r", "Jari-jari", 0.5, 4, 0.1], ["t", "Tinggi", 1, 8, 0.1]], kerucut: [["r", "Jari-jari", 0.5, 4, 0.1], ["t", "Tinggi", 1, 8, 0.1]], bola: [["r", "Jari-jari", 0.5, 4, 0.1]],
};
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const PI = Math.PI;

type Mesh = { v: V3[]; f: number[][]; names: string[]; poly: boolean };
function build(s: S): Mesh {
  const { shape, p, l, t, r, n } = s;
  const ring = (N: number, R: number, z: number): V3[] => Array.from({ length: N }, (_, k) => { const a = (2 * PI * k) / N - PI / 2 + PI / N; return [R * Math.cos(a), R * Math.sin(a), z]; });
  const idx = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
  if (shape === "kubus" || shape === "balok") {
    const [a, b, c] = shape === "kubus" ? [p, p, p] : [p, l, t];
    const v: V3[] = []; for (let i = 0; i < 8; i++) v.push([(i & 1 ? 1 : -1) * a / 2, (i & 2 ? 1 : -1) * b / 2, (i & 4 ? 1 : -1) * c / 2]);
    return { v, poly: true, f: [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]], names: ["Alas", "Atas", "Depan", "Belakang", "Kiri", "Kanan"] };
  }
  if (shape === "prisma" || shape === "limas") {
    const R = p / (2 * Math.sin(PI / n)), N = Math.round(n);
    const base = ring(N, R, -t / 2);
    if (shape === "prisma") {
      const top = base.map((q): V3 => [q[0], q[1], t / 2]);
      return { v: [...base, ...top], poly: true, f: [idx(0, N), idx(N, 2 * N), ...idx(0, N).map((k) => [k, (k + 1) % N, N + ((k + 1) % N), N + k])], names: ["Alas", "Atas", ...idx(0, N).map((k) => `Sisi tegak ${k + 1}`)] };
    }
    return { v: [...base, [0, 0, t / 2]], poly: true, f: [idx(0, N), ...idx(0, N).map((k) => [k, (k + 1) % N, N])], names: ["Alas", ...idx(0, N).map((k) => `Sisi tegak ${k + 1}`)] };
  }
  const N = 36;
  if (shape === "tabung") {
    const b = ring(N, r, -t / 2), tp = ring(N, r, t / 2);
    return { v: [...b, ...tp], poly: false, names: [], f: [idx(0, N), idx(N, 2 * N), ...idx(0, N).map((k) => [k, (k + 1) % N, N + ((k + 1) % N), N + k])] };
  }
  if (shape === "kerucut") return { v: [...ring(N, r, -t / 2), [0, 0, t / 2]], poly: false, names: [], f: [idx(0, N), ...idx(0, N).map((k) => [k, (k + 1) % N, N])] };
  const v: V3[] = [], f: number[][] = [], LA = 10, LO = 20;
  for (let i = 0; i <= LA; i++) for (let j = 0; j < LO; j++) { const a = PI * i / LA, b = 2 * PI * j / LO; v.push([r * Math.sin(a) * Math.cos(b), r * Math.sin(a) * Math.sin(b), r * Math.cos(a)]); }
  for (let i = 0; i < LA; i++) for (let j = 0; j < LO; j++) f.push([i * LO + j, i * LO + (j + 1) % LO, (i + 1) * LO + (j + 1) % LO, (i + 1) * LO + j]);
  return { v, f, names: [], poly: false };
}
/** Normal satuan menghadap keluar (metode Newell; pusat benda = titik asal). */
function normal(m: Mesh, f: number[]): V3 {
  let x = 0, y = 0, z = 0; const c: V3 = [0, 0, 0];
  f.forEach((k, i) => { const a = m.v[k], b = m.v[f[(i + 1) % f.length]]; x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]); c[0] += a[0]; c[1] += a[1]; c[2] += a[2]; });
  const L = Math.hypot(x, y, z) || 1, s = x * c[0] + y * c[1] + z * c[2] < 0 ? -1 : 1;
  return [(s * x) / L, (s * y) / L, (s * z) / L];
}
const rot = (v: V3, yaw: number, pitch: number): V3 => {
  const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), x1 = v[0] * c - v[1] * s, y1 = v[0] * s + v[1] * c;
  return [x1, y1 * sp + v[2] * cp, y1 * cp - v[2] * sp];
};

/* ───────── Jaring-jaring: daftar poligon 2D ───────── */
type P2 = [number, number][];
function net(s: S): P2[] | null {
  const { shape, p, l, t, r, n } = s, N = Math.round(n);
  const gon = (cx: number, cy: number, R: number, start: number, k = N): P2 => Array.from({ length: k }, (_, i) => [cx + R * Math.cos(start + (2 * PI * i) / k), cy + R * Math.sin(start + (2 * PI * i) / k)]);
  const rect = (x: number, y: number, w: number, h: number): P2 => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  if (shape === "kubus" || shape === "balok") {
    const [a, b, c] = shape === "kubus" ? [p, p, p] : [p, l, t];
    return [rect(0, 0, a, c), rect(a, 0, b, c), rect(a + b, 0, a, c), rect(2 * a + b, 0, b, c), rect(0, c, a, b), rect(0, -b, a, b)];
  }
  if (shape === "prisma") {
    const R = p / (2 * Math.sin(PI / N)), ap = p / (2 * Math.tan(PI / N));
    return [...Array.from({ length: N }, (_, i) => rect(i * p, 0, p, t)), gon(p / 2, t + ap, R, -PI / 2 + PI / N), gon(p / 2, -ap, R, PI / 2 + PI / N)];
  }
  if (shape === "limas") {
    const R = p / (2 * Math.sin(PI / N)), ap = p / (2 * Math.tan(PI / N)), m = Math.hypot(t, ap), base = gon(0, 0, R, -PI / 2 + PI / N);
    return [base, ...base.map((a, i): P2 => { const b = base[(i + 1) % N], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, d = Math.hypot(mx, my); return [a, b, [mx + (mx / d) * m, my + (my / d) * m]]; })];
  }
  if (shape === "tabung") return [rect(0, 0, 2 * PI * r, t), gon(r, -r, r, 0, 48), gon(r, t + r, r, 0, 48)];
  if (shape === "kerucut") {
    const g = Math.hypot(r, t), phi = (2 * PI * r) / g;
    return [[[0, 0], ...Array.from({ length: 41 }, (_, i): [number, number] => { const a = PI / 2 - phi / 2 + (phi * i) / 40; return [g * Math.cos(a), g * Math.sin(a)]; })], gon(0, g + r, r, 0, 48)];
  }
  return null;
}

export function Solid3DSimulation() {
  const [s, setS] = useStoredSimulationState<S>("solid3d", DEF);
  const up = (o: Partial<S>) => setS((p) => ({ ...p, ...o }));
  const drag = { current: null as null | [number, number] };
  const m = build(s), poly = m.poly;
  const W = 600, H = 460, rad = Math.max(...m.v.map((v) => Math.hypot(...v))), sc = (200 * s.zoom) / rad;
  const sx = (q: V3) => 300 + q[0] * sc, sy = (q: V3) => 230 - q[1] * sc;
  const rv = m.v.map((v) => rot(v, s.yaw, s.pitch)), normals = m.f.map((f) => normal(m, f));
  const front = normals.map((nv) => rot(nv, s.yaw, s.pitch)[2] < 0);
  const order = m.f.map((f, i) => ({ i, d: f.reduce((a, k) => a + rv[k][2], 0) / f.length })).sort((a, b) => b.d - a.d);
  const edges = new Map<string, number[]>();
  m.f.forEach((f, fi) => f.forEach((k, i) => { const o = f[(i + 1) % f.length], key = k < o ? `${k}-${o}` : `${o}-${k}`; edges.set(key, [...(edges.get(key) ?? []), fi]); }));
  const edgeList = [...edges.keys()];
  const hasDist = poly;
  const di = Math.min(s.di, (s.dk === "plane" ? m.f.length : edgeList.length) - 1);

  /* ukuran */
  const { p, l, t, r } = s, N = Math.round(s.n);
  const ap = p / (2 * Math.tan(PI / N)), Ab = (N * p * ap) / 2, g = Math.hypot(r, t);
  const res: Record<Shape, [string, number, string, number]> = {
    kubus: ["s³", p ** 3, "6s²", 6 * p * p], balok: ["p·l·t", p * l * t, "2(pl+pt+lt)", 2 * (p * l + p * t + l * t)],
    prisma: ["Lₐ·t", Ab * t, "2Lₐ + K·t", 2 * Ab + N * p * t], limas: ["⅓·Lₐ·t", (Ab * t) / 3, "Lₐ + ½·K·m", Ab + (N * p * Math.hypot(t, ap)) / 2],
    tabung: ["πr²t", PI * r * r * t, "2πr(r+t)", 2 * PI * r * (r + t)], kerucut: ["⅓πr²t", (PI * r * r * t) / 3, "πr(r+s)", PI * r * (r + g)], bola: ["⁴⁄₃πr³", (4 / 3) * PI * r ** 3, "4πr²", 4 * PI * r * r],
  };
  const [fv, vv, fl, vl] = res[s.shape];

  /* jarak titik */
  let dist = 0, foot: V3 = s.pt;
  if (hasDist && s.mode === "dist") {
    if (s.dk === "plane") { const nv = normals[di], d = dot(sub(s.pt, m.v[m.f[di][0]]), nv); dist = Math.abs(d); foot = [s.pt[0] - d * nv[0], s.pt[1] - d * nv[1], s.pt[2] - d * nv[2]]; }
    else { const [a, b] = edgeList[di].split("-").map((k) => m.v[+k]), ab = sub(b, a), u = dot(sub(s.pt, a), ab) / dot(ab, ab); foot = [a[0] + u * ab[0], a[1] + u * ab[1], a[2] + u * ab[2]]; dist = Math.hypot(...sub(s.pt, foot)); }
  }
  const pr = (v: V3) => rot(v, s.yaw, s.pitch);
  const pts = (q: P2) => q.map((a) => a.join(",")).join(" ");
  const polys = s.mode === "net" ? net(s) : null;
  let nb = { x: 0, y: 0, k: 1 };
  if (polys) { const all = polys.flat(), x0 = Math.min(...all.map((a) => a[0])), x1 = Math.max(...all.map((a) => a[0])), y0 = Math.min(...all.map((a) => a[1])), y1 = Math.max(...all.map((a) => a[1])), k = Math.min((W * 0.86) / (x1 - x0), (H * 0.86) / (y1 - y0)); nb = { k, x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 - ((y0 + y1) / 2) * k }; }

  const sliders = FIELDS[s.shape].map(([k, lb, a, b, st]) => (
    <label key={k}><span>{lb}</span><b>{fmt(s[k] as number)}</b><input type="range" min={a} max={b} step={st} value={s[k] as number} onChange={(e) => up({ [k]: parseFloat(e.target.value) })} /></label>
  ));
  const btn = (mode: Mode, label: string) => <button type="button" className="sim-btn" aria-pressed={s.mode === mode} onClick={() => up({ mode })}>{label}</button>;

  return (
    <SimulationShell
      title="Bangun Ruang 3D"
      toggles={<>{btn("3d", "3D")}{btn("net", "Jaring-jaring")}{btn("dist", "Jarak")}</>}
      onReset={() => setS(DEF)}
      onZoomIn={() => up({ zoom: Math.min(3, s.zoom * 1.2) })} onZoomOut={() => up({ zoom: Math.max(0.4, s.zoom / 1.2) })} onHome={() => up({ yaw: DEF.yaw, pitch: DEF.pitch, zoom: 1 })}
      panel={
        <div className="s3d">
          <div className="s3d-shapes">{(Object.keys(NAME) as Shape[]).map((k) => <button key={k} className={s.shape === k ? "on" : ""} onClick={() => up({ shape: k, di: 0 })}>{NAME[k]}</button>)}</div>
          <h4>Ukuran</h4>{sliders}
          <div className="s3d-res">
            Volume = {fv} = <b>{fmt(vv)}</b><br />Luas permukaan = {fl} = <b>{fmt(vl)}</b>
            {s.shape === "kerucut" && <><br />Garis pelukis s = <b>{fmt(g)}</b></>}
          </div>
          {s.mode === "3d" && poly && <label style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={s.hide} onChange={(e) => up({ hide: e.target.checked })} />Garis tersembunyi putus-putus</label>}
          {s.mode === "dist" && (hasDist ? <>
            <h4>Jarak titik P ke…</h4>
            <div className="s3d-seg"><button className={s.dk === "plane" ? "on" : ""} onClick={() => up({ dk: "plane", di: 0 })}>Bidang</button><button className={s.dk === "line" ? "on" : ""} onClick={() => up({ dk: "line", di: 0 })}>Garis (rusuk)</button></div>
            <select value={di} onChange={(e) => up({ di: +e.target.value })}>
              {s.dk === "plane" ? m.names.map((nm, i) => <option key={i} value={i}>{nm}</option>) : edgeList.map((_, i) => <option key={i} value={i}>Rusuk {i + 1}</option>)}
            </select>
            {(["x", "y", "z"] as const).map((ax, i) => <label key={ax}><span>P{ax}</span><b>{fmt(s.pt[i])}</b><input type="range" min={-6} max={6} step={0.1} value={s.pt[i]} onChange={(e) => { const pt = [...s.pt] as V3; pt[i] = parseFloat(e.target.value); up({ pt }); }} /></label>)}
            <div className="s3d-res">Jarak = <b>{fmt(dist)}</b> satuan</div></> : <p className="s3d-note">Jarak tersedia untuk bangun ruang bersisi datar (kubus, balok, limas, prisma).</p>)}
          {s.mode === "3d" && <p className="s3d-note">Seret grafik untuk memutar, gulir untuk memperbesar.</p>}
        </div>
      }
      graph={
        <svg className="s3d-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Gambar ${NAME[s.shape]}`}
          onPointerDown={(e) => { if (s.mode !== "net") { drag.current = [e.clientX, e.clientY]; e.currentTarget.setPointerCapture(e.pointerId); } }}
          onPointerMove={(e) => { const d = drag.current; if (!d) return; drag.current = [e.clientX, e.clientY]; up({ yaw: s.yaw + (e.clientX - d[0]) * 0.01, pitch: Math.max(-1.5, Math.min(1.5, s.pitch + (e.clientY - d[1]) * 0.01)) }); }}
          onPointerUp={() => { drag.current = null; }} onWheel={(e) => up({ zoom: Math.max(0.4, Math.min(3, s.zoom * (e.deltaY < 0 ? 1.08 : 0.92))) })}>
          {polys ? polys.map((q, i) => <polygon key={i} points={pts(q.map((a) => [a[0] * nb.k + nb.x, a[1] * nb.k + nb.y] as [number, number]))} fill={i % 2 ? "#d9d5fa" : "#ece9ff"} stroke="#6557d2" strokeWidth="1.5" />)
            : s.mode === "net" ? <text x={W / 2} y={H / 2} textAnchor="middle" fill="#777">Bola tidak memiliki jaring-jaring.</text> : <>
              {order.map(({ i }) => <polygon key={i} points={m.f[i].map((k) => `${sx(rv[k])},${sy(rv[k])}`).join(" ")}
                fill={s.mode === "dist" && s.dk === "plane" && i === di && hasDist ? "rgba(250,126,25,.55)" : front[i] ? "rgba(101,87,210,.3)" : "rgba(101,87,210,.08)"}
                stroke={poly ? "none" : "rgba(60,50,150,.3)"} strokeWidth=".6" />)}
              {poly && edgeList.map((key, ei) => { const [a, b] = key.split("-").map((k) => rv[+k]), hid = s.hide && edges.get(key)!.every((fi) => !front[fi]), sel = s.mode === "dist" && s.dk === "line" && ei === di;
                return <line key={key} x1={sx(a)} y1={sy(a)} x2={sx(b)} y2={sy(b)} stroke={sel ? "#fa7e19" : "#2b2470"} strokeWidth={sel ? 4 : 1.8} strokeDasharray={hid ? "5 4" : undefined} opacity={hid ? 0.55 : 1} />; })}
              {s.mode === "dist" && hasDist && (() => { const a = pr(s.pt), b = pr(foot); return <g>
                <line x1={sx(a)} y1={sy(a)} x2={sx(b)} y2={sy(b)} stroke="#c74440" strokeWidth="2" strokeDasharray="6 4" />
                <circle cx={sx(b)} cy={sy(b)} r="4" fill="#fff" stroke="#c74440" strokeWidth="2" /><circle cx={sx(a)} cy={sy(a)} r="5" fill="#c74440" />
                <text x={sx(a) + 8} y={sy(a) - 8} fontWeight="600" fill="#c74440">P</text>
                <text x={(sx(a) + sx(b)) / 2 + 8} y={(sy(a) + sy(b)) / 2} fill="#c74440" fontSize="13">{fmt(dist)}</text></g>; })()}
            </>}
        </svg>
      }
    />
  );
}
export default Solid3DSimulation;
