import JXG from "jsxgraph";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AxisNumbersIcon,
  GridIcon,
  PointLabelIcon,
  SimRow,
  SimSection,
  SimSlider,
  SimToggle,
} from "../common/components/SimControls";
import { SimMath } from "../common/components/SimMath";
import { SimulationShell } from "../common/components/SimulationShell";
import { clamp, snap } from "../common/utils/simUtils";
import { useJsxBoard, type BoundingBox, type SimBoard } from "../common/hooks/useJsxBoard";
import { useStoredSimulationState } from "../common/hooks/useStoredSimulationState";
import "./CircleSectorSimulation.css";

/* Simulasi lingkaran untuk SMP. Enam materi dalam satu kerangka:
   1. Bagian-bagian lingkaran   (pusat, jari-jari, diameter, tali busur, busur,
                                 juring, tembereng, apotema, garis singgung)
   2. Sudut pusat dan keliling   (sudut keliling = ½ sudut pusat; dua sudut keliling
                                 yang menghadap busur sama selalu sama besar)
   3. Sudut di diameter          (sudut keliling yang menghadap diameter = 90°)
   4. Luas juring                (L = θ/360° · πr²)
   5. Panjang busur              (s = θ/360° · 2πr)
   6. Garis dan lingkaran        (memotong, menyinggung, atau di luar)

   Lingkaran berpusat di O(0, 0). Titik A, B, C, D diseret langsung di grafik.
   Kerangka, slider, dan CSS memakai kit umum (prefix sim-). */

/* ───────── Tipe ───────── */

type Vec = [number, number];
type Mode = "parts" | "angle" | "diameter" | "area" | "arc" | "line";
type PartKey =
  | "all"
  | "center"
  | "radius"
  | "diameter"
  | "chord"
  | "arc"
  | "sector"
  | "segment"
  | "apothem"
  | "tangent";
type Anim = "t" | "p" | "c" | null;
type PiMode = "314" | "227" | "pi";

/** Juring O-A-B: A pada arah a, B pada arah a + t. (materi 1, 4, 5) */
type Sector = { r: number; a: number; t: number };
/** Sudut pusat AOB = t (10°–180°). C dan D ada di busur besar; c, d = posisi relatif 0–1. */
type Inscribed = { r: number; a: number; t: number; c: number; d: number };
/** Diameter AB pada arah a. C dan D = sudut relatif terhadap A (derajat). */
type Diam = { r: number; a: number; c: number; d: number };
/** Garis tegak lurus OH dengan |OH| = d dan arah OH = al. */
type LineP = { r: number; d: number; al: number };
type Opts = { showD: boolean; central: boolean; points: boolean };
type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean;
  curveWidth: number;
  pointSize: number;
};
type AllState = {
  mode: Mode;
  focus: PartKey;
  sec: Sector;
  ang: Inscribed;
  dia: Diam;
  lin: LineP;
  opts: Opts;
  view: ViewState;
  piMode: PiMode;
  angStep: number;
  lenStep: number;
};

type Settable = { setAttribute: (attributes: Record<string, unknown>) => unknown };
type AxisElement = Settable & { defaultTicks: Settable };
type DataCurve = Settable & { dataX: number[]; dataY: number[]; updateDataArray: () => void };
type PointEl = Settable & {
  X(): number;
  Y(): number;
  setPosition(method: number, coords: number[]): unknown;
  on(event: string, handler: () => void): unknown;
};
/** Satu kelompok elemen papan yang tampil/sembunyi bersama. */
type Reg = {
  els: Settable[];
  vis: () => boolean;
  /** Faktor tebal garis (0 = tanpa garis tepi). */
  w?: number;
  /** Tambahan ukuran titik. */
  s?: number;
};
type Scene = { grid: Settable; axes: AxisElement[]; regs: Reg[]; handles: PointEl[] };
type Place = { dx: number; dy: number; ax: "left" | "right" | "middle"; ay: "top" | "bottom" | "middle" };

/* ───────── Konstanta ───────── */

const DEG = Math.PI / 180;
const R_RANGE = [1, 8] as const;
const D_MAX = 9;
const MARGIN = 6; // jarak minimum C/D dari A dan B (derajat)
const ANG_STEPS = [1, 5, 15];
const LEN_STEPS = [0.2, 0.5, 1];
const COORDS_BY_USER: number =
  (JXG as unknown as { COORDS_BY_USER?: number }).COORDS_BY_USER ?? 1;
const initialBox: BoundingBox = [-14, 10, 14, -10];

const initialSector: Sector = { r: 5, a: 30, t: 60 };
const initialAngle: Inscribed = { r: 5, a: 30, t: 60, c: 0.3, d: 0.75 };
const initialDiam: Diam = { r: 5, a: 20, c: 70, d: 230 };
const initialLine: LineP = { r: 5, d: 3, al: 40 };
const initialOpts: Opts = { showD: true, central: true, points: false };
const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: false,
  curveWidth: 3,
  pointSize: 4,
};

const colors = {
  arc: "#00897b",
  radius: "#232329",
  diameter: "#1565c0",
  chord: "#c62828",
  segment: "#e65100",
  apothem: "#6c6c78",
  tangent: "#087f8c",
  angle: "#6557d2",
  inscribed: "#2e7d32",
  line: "#d84315",
  guide: "#8f8f99",
  grid: "#dcdce2",
  axis: "#4a4a55",
};

const MODES: { id: Mode; label: string; color: string }[] = [
  { id: "parts", label: "Bagian lingkaran", color: colors.radius },
  { id: "angle", label: "Sudut pusat dan keliling", color: colors.angle },
  { id: "diameter", label: "Sudut di diameter", color: colors.inscribed },
  { id: "area", label: "Luas juring", color: colors.arc },
  { id: "arc", label: "Panjang busur", color: colors.segment },
  { id: "line", label: "Garis dan lingkaran", color: colors.line },
];

const PARTS: { key: PartKey; label: string; color: string; def: string }[] = [
  { key: "all", label: "Semua", color: colors.radius, def: "" },
  {
    key: "center",
    label: "Titik pusat",
    color: colors.radius,
    def: "Titik O di tengah lingkaran. Semua titik pada lingkaran berjarak sama dari O.",
  },
  {
    key: "radius",
    label: "Jari-jari",
    color: colors.radius,
    def: "Ruas garis dari titik pusat ke titik pada lingkaran, misalnya OA dan OB. Panjangnya r.",
  },
  {
    key: "diameter",
    label: "Diameter",
    color: colors.diameter,
    def: "Tali busur yang melalui titik pusat. Panjangnya dua kali jari-jari, dan ini tali busur terpanjang.",
  },
  {
    key: "chord",
    label: "Tali busur",
    color: colors.chord,
    def: "Ruas garis yang menghubungkan dua titik pada lingkaran, misalnya AB.",
  },
  {
    key: "arc",
    label: "Busur",
    color: colors.arc,
    def: "Bagian lingkaran di antara dua titik, misalnya busur AB.",
  },
  {
    key: "sector",
    label: "Juring",
    color: colors.arc,
    def: "Daerah yang dibatasi dua jari-jari (OA dan OB) dan busur AB.",
  },
  {
    key: "segment",
    label: "Tembereng",
    color: colors.segment,
    def: "Daerah yang dibatasi tali busur AB dan busur AB.",
  },
  {
    key: "apothem",
    label: "Apotema",
    color: colors.apothem,
    def: "Jarak dari titik pusat ke tali busur. Ruas OM tegak lurus tali busur AB dan membagi dua tali busur itu.",
  },
  {
    key: "tangent",
    label: "Garis singgung",
    color: colors.tangent,
    def: "Garis yang menyentuh lingkaran di tepat satu titik dan tegak lurus jari-jari di titik itu.",
  },
];

const PI_OPTIONS: { id: PiMode; label: string; value: number; tex: string }[] = [
  { id: "314", label: "3.14", value: 3.14, tex: "3.14" },
  { id: "227", label: "22/7", value: 22 / 7, tex: String.raw`\dfrac{22}{7}` },
  { id: "pi", label: "π", value: Math.PI, tex: String.raw`\pi` },
];

const ANIMS: Record<Mode, { id: Exclude<Anim, null>; on: string; off: string }[]> = {
  parts: [
    { id: "t", on: "Animasikan θ", off: "Hentikan θ" },
    { id: "p", on: "Putar juring", off: "Hentikan putar" },
  ],
  area: [
    { id: "t", on: "Animasikan θ", off: "Hentikan θ" },
    { id: "p", on: "Putar juring", off: "Hentikan putar" },
  ],
  arc: [
    { id: "t", on: "Animasikan θ", off: "Hentikan θ" },
    { id: "p", on: "Putar juring", off: "Hentikan putar" },
  ],
  angle: [
    { id: "c", on: "Gerakkan C dan D", off: "Hentikan gerakan" },
    { id: "t", on: "Animasikan sudut pusat", off: "Hentikan sudut pusat" },
    { id: "p", on: "Putar semuanya", off: "Hentikan putar" },
  ],
  diameter: [
    { id: "c", on: "Gerakkan C", off: "Hentikan gerakan" },
    { id: "p", on: "Putar diameter", off: "Hentikan putar" },
  ],
  line: [],
};

/* ───────── Format angka (titik desimal, minus sebenarnya) ───────── */

const finite = (v: number) => Number.isFinite(v);
const formatters = new Map<number, Intl.NumberFormat>();
function fmt(value: number, digits = 2) {
  if (!finite(value)) return "—";
  let nf = formatters.get(digits);
  if (!nf) {
    nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, useGrouping: false });
    formatters.set(digits, nf);
  }
  if (Math.abs(value) < 0.5 * 10 ** -digits) return "0";
  return nf.format(value).replace("-", "−");
}
function tex(value: number, digits = 2) {
  if (!finite(value)) return "?";
  return fmt(value, digits).replace("−", "-");
}
const fmtPt = (x: number, y: number) => `(${fmt(x)}, ${fmt(y)})`;
const texPt = (p: Vec) => String.raw`(${tex(p[0])},${tex(p[1])})`;
const stepText = (v: number) => String(v);

function polyTex(terms: [number, string][]) {
  const parts: string[] = [];
  terms.forEach(([coef, symbol]) => {
    if (Math.abs(coef) < 5e-3) return;
    const abs = Math.abs(coef);
    const body = Math.abs(abs - 1) < 5e-3 ? symbol : `${tex(abs)}${symbol}`;
    if (parts.length === 0) parts.push(coef < 0 ? `-${body}` : body);
    else parts.push(`${coef < 0 ? "-" : "+"} ${body}`);
  });
  return parts.length ? parts.join(" ") : "0";
}

/* ───────── Matematika ───────── */

const num = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const mod360 = (v: number) => ((v % 360) + 360) % 360;
const wrap180 = (v: number) => mod360(v + 180) - 180;
const polar = (r: number, deg: number): Vec => [r * Math.cos(deg * DEG), r * Math.sin(deg * DEG)];
const angleDeg = (x: number, y: number) => Math.atan2(y, x) / DEG;
const unit = (x: number, y: number): Vec | null => {
  const l = Math.hypot(x, y);
  return l < 1e-9 ? null : [x / l, y / l];
};

/** Titik-titik busur berpusat di (0, 0): dari sudut a0 sepanjang span (derajat). */
function arcPoints(radius: number, a0Deg: number, spanDeg: number): Vec[] {
  const n = Math.max(24, Math.ceil(Math.abs(spanDeg) * 2));
  const out: Vec[] = [];
  for (let i = 0; i <= n; i += 1) {
    out.push(polar(radius, a0Deg + (spanDeg * i) / n));
  }
  return out;
}

/** Busur kecil penanda sudut XPY di titik P, beserta arah garis bagi sudutnya. */
function arcAtVertex(P: Vec, X: Vec, Y: Vec, rho: number): { pts: Vec[]; mid: Vec } {
  const a1 = Math.atan2(X[1] - P[1], X[0] - P[0]);
  const a2 = Math.atan2(Y[1] - P[1], Y[0] - P[0]);
  let span = a2 - a1;
  while (span > Math.PI) span -= 2 * Math.PI;
  while (span <= -Math.PI) span += 2 * Math.PI;
  const n = 24;
  const pts: Vec[] = [];
  for (let i = 0; i <= n; i += 1) {
    const a = a1 + (span * i) / n;
    pts.push([P[0] + rho * Math.cos(a), P[1] + rho * Math.sin(a)]);
  }
  const m = a1 + span / 2;
  return { pts, mid: [Math.cos(m), Math.sin(m)] };
}

/** Tanda siku-siku di titik P di antara arah ke X dan arah ke Y. */
function rightAnglePts(P: Vec, X: Vec, Y: Vec, s: number): Vec[] | null {
  const ux = unit(X[0] - P[0], X[1] - P[1]);
  const uy = unit(Y[0] - P[0], Y[1] - P[1]);
  if (!ux || !uy) return null;
  return [
    [P[0] + ux[0] * s, P[1] + ux[1] * s],
    [P[0] + (ux[0] + uy[0]) * s, P[1] + (ux[1] + uy[1]) * s],
    [P[0] + uy[0] * s, P[1] + uy[1] * s],
  ];
}

function angleAt(P: Vec, X: Vec, Y: Vec) {
  const ux = X[0] - P[0];
  const uy = X[1] - P[1];
  const vx = Y[0] - P[0];
  const vy = Y[1] - P[1];
  const den = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (den < 1e-12) return Number.NaN;
  return Math.acos(clamp((ux * vx + uy * vy) / den, -1, 1)) / DEG;
}

function sectorGeom({ r, a, t }: Sector, pi: number) {
  const th = t * DEG;
  const half = th / 2;
  const mid = a + t / 2;
  const A = polar(r, a);
  const B = polar(r, a + t);
  const apothem = r * Math.cos(half); // bertanda: negatif bila θ > 180°
  const M: Vec = [apothem * Math.cos(mid * DEG), apothem * Math.sin(mid * DEG)];
  const arc = (t / 360) * 2 * pi * r;
  const sector = (t / 360) * pi * r * r;
  const tri = 0.5 * r * r * Math.sin(th);
  return {
    r,
    a,
    t,
    mid,
    A,
    B,
    M,
    A2: polar(r, a + 180),
    arc,
    sector,
    tri,
    segment: sector - tri,
    chord: 2 * r * Math.sin(half),
    apothem,
    area: pi * r * r,
    circ: 2 * pi * r,
    perimeter: 2 * r + arc,
    frac: t / 360,
  };
}

/** Posisi C dan D pada busur besar (yang tidak memuat busur AB). */
function angleGeom(g: Inscribed) {
  const span = 360 - g.t - 2 * MARGIN;
  const base = g.a + g.t + MARGIN;
  const A = polar(g.r, g.a);
  const B = polar(g.r, g.a + g.t);
  const C = polar(g.r, base + g.c * span);
  const D = polar(g.r, base + g.d * span);
  return { A, B, C, D, gc: angleAt(C, A, B), gd: angleAt(D, A, B) };
}

function diaGeom(g: Diam) {
  const A = polar(g.r, g.a);
  const B = polar(g.r, g.a + 180);
  const C = polar(g.r, g.a + g.c);
  const D = polar(g.r, g.a + g.d);
  const sq = (P: Vec, Q: Vec) => (P[0] - Q[0]) ** 2 + (P[1] - Q[1]) ** 2;
  return {
    A,
    B,
    C,
    D,
    gc: angleAt(C, A, B),
    gd: angleAt(D, A, B),
    ac2: sq(A, C),
    bc2: sq(B, C),
    ab2: sq(A, B),
  };
}

type LineKind = "secant" | "tangent" | "outside";
function lineGeom({ r, d, al }: LineP) {
  const c = Math.cos(al * DEG);
  const s = Math.sin(al * DEG);
  const H: Vec = [d * c, d * s];
  const u: Vec = [-s, c];
  const kind: LineKind = Math.abs(d - r) < 1e-6 ? "tangent" : d < r ? "secant" : "outside";
  const h = kind === "secant" ? Math.sqrt(r * r - d * d) : 0;
  return {
    c,
    s,
    H,
    u,
    kind,
    h,
    P: [H[0] + h * u[0], H[1] + h * u[1]] as Vec,
    Q: [H[0] - h * u[0], H[1] - h * u[1]] as Vec,
  };
}

/** Sudut pusat AOB dibatasi 10°–180°; pilih ujung terdekat bila di luar rentang. */
function clampT(raw: number) {
  if (raw < 10) return 10;
  if (raw <= 180) return raw;
  return raw < 270 ? 180 : 10;
}

/** Letakkan C/D di busur besar: posisi relatif 0–1. */
function relOnMajor(rel: number, t: number) {
  const lo = MARGIN;
  const hi = 360 - t - MARGIN;
  let v = rel;
  if (v < lo || v > hi) {
    const toHi = v > hi ? v - hi : Infinity;
    const toLo = v < lo ? lo - v : 360 - v + lo;
    v = toHi < toLo ? hi : lo;
  }
  return (v - lo) / (hi - lo);
}

/** Sudut relatif C/D terhadap A pada diameter, menghindari A dan B. */
function clampRel(rel: number) {
  const v = mod360(rel);
  if (v < MARGIN) return MARGIN;
  if (v > 360 - MARGIN) return 360 - MARGIN;
  if (Math.abs(v - 180) < MARGIN) return v < 180 ? 180 - MARGIN : 180 + MARGIN;
  return v;
}

const HALO =
  "font-weight:600;white-space:nowrap;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;";

/* ───────── Komponen kecil ───────── */

function FractionBar({ value, color, label }: { value: number; color: string; label: string }) {
  return (
    <>
      <div
        className="sim-cir-bar"
        role="img"
        aria-label={label}
        style={{ "--sim-accent": color } as CSSProperties}
      >
        <span className="sim-cir-bar__fill" style={{ width: `${clamp(value, 0, 1) * 100}%` }} />
        <span className="sim-cir-bar__ticks" />
      </div>
      <p className="sim-cir-bar-caption" aria-hidden="true">
        <span>0°</span>
        <span>90°</span>
        <span>180°</span>
        <span>270°</span>
        <span>360°</span>
      </p>
    </>
  );
}

const K = (s: string) => <SimMath tex={s} />;

/* ───────── Komponen utama ───────── */

export function CircleSectorSimulation() {
  const [storedMode, setMode] = useStoredSimulationState<Mode>("circleSector.v2.mode", "parts");
  const [secRaw, setSec] = useStoredSimulationState("circleSector.v2.sector", initialSector);
  const [angRaw, setAng] = useStoredSimulationState("circleSector.v2.angle", initialAngle);
  const [diaRaw, setDia] = useStoredSimulationState("circleSector.v2.diameter", initialDiam);
  const [linRaw, setLin] = useStoredSimulationState("circleSector.v2.line", initialLine);
  const [piMode, setPiMode] = useStoredSimulationState<PiMode>("circleSector.v2.pi", "314");
  const [angStep, setAngStep] = useStoredSimulationState("circleSector.v2.angstep", 5);
  const [lenStep, setLenStep] = useStoredSimulationState("circleSector.v2.lenstep", 0.5);
  const [storedView, setStoredView] = useStoredSimulationState("circleSector.v2.view", initialView);
  const [focus, setFocus] = useState<PartKey>("all");
  const [opts, setOpts] = useState<Opts>(initialOpts);
  const [anim, setAnim] = useState<Anim>(null);

  const mode: Mode = MODES.some((m) => m.id === storedMode) ? storedMode : "parts";
  const view = useMemo<ViewState>(() => ({ ...initialView, ...storedView }), [storedView]);

  // Jaga-jaga bila nilai tersimpan sudah tidak valid.
  const sec = useMemo<Sector>(
    () => ({
      r: clamp(num(secRaw.r, 5), R_RANGE[0], R_RANGE[1]),
      a: clamp(num(secRaw.a, 30), -180, 180),
      t: clamp(num(secRaw.t, 60), 1, 360),
    }),
    [secRaw],
  );
  const ang = useMemo<Inscribed>(
    () => ({
      r: clamp(num(angRaw.r, 5), R_RANGE[0], R_RANGE[1]),
      a: clamp(num(angRaw.a, 30), -180, 180),
      t: clamp(num(angRaw.t, 60), 10, 180),
      c: clamp(num(angRaw.c, 0.3), 0, 1),
      d: clamp(num(angRaw.d, 0.75), 0, 1),
    }),
    [angRaw],
  );
  const dia = useMemo<Diam>(
    () => ({
      r: clamp(num(diaRaw.r, 5), R_RANGE[0], R_RANGE[1]),
      a: clamp(num(diaRaw.a, 20), -180, 180),
      c: clampRel(num(diaRaw.c, 70)),
      d: clampRel(num(diaRaw.d, 230)),
    }),
    [diaRaw],
  );
  const lin = useMemo<LineP>(
    () => ({
      r: clamp(num(linRaw.r, 5), R_RANGE[0], R_RANGE[1]),
      d: clamp(num(linRaw.d, 3), 0, D_MAX),
      al: clamp(num(linRaw.al, 40), -180, 180),
    }),
    [linRaw],
  );

  const pi = PI_OPTIONS.find((o) => o.id === piMode) ?? PI_OPTIONS[0];

  // Semua yang dibaca papan lewat satu ref.
  const S = useRef<AllState>({
    mode,
    focus,
    sec,
    ang,
    dia,
    lin,
    opts,
    view,
    piMode,
    angStep,
    lenStep,
  });
  S.current = { mode, focus, sec, ang, dia, lin, opts, view, piMode, angStep, lenStep };

  const scene = useRef<Scene | null>(null);
  const apiRef = useRef<{ drag: (i: number, x: number, y: number) => void }>({
    drag: () => undefined,
  });

  /* ───────── Papan JSXGraph ───────── */

  const setup = (board: SimBoard) => {
    const regs: Reg[] = [];
    const px = (n: number) => n / (board.unitX || 30);
    const py = (n: number) => n / (board.unitY || 30);
    const v = S.current.view;

    const grid = board.create("grid", [], {
      strokeColor: colors.grid,
      strokeOpacity: 1,
      strokeWidth: 1,
      highlight: false,
    }) as unknown as Settable;
    const axisStyle = {
      strokeColor: colors.axis,
      strokeWidth: 1.2,
      highlight: false,
      withLabel: true,
    };
    const ticks = {
      insertTicks: true,
      minTicksDistance: 32,
      minorTicks: 1,
      majorHeight: 6,
      drawLabels: v.axisNumbers,
      label: { fontSize: 10, strokeColor: "#5c5c68" },
    };
    const xAxis = board.create(
      "axis",
      [
        [0, 0],
        [1, 0],
      ],
      { ...axisStyle, name: "x", label: { position: "rt", offset: [-14, 14], fontSize: 13 }, ticks },
    ) as unknown as AxisElement;
    const yAxis = board.create(
      "axis",
      [
        [0, 0],
        [0, 1],
      ],
      { ...axisStyle, name: "y", label: { position: "rt", offset: [12, -14], fontSize: 13 }, ticks },
    ) as unknown as AxisElement;

    /** Jarak yang cukup besar untuk menutupi seluruh area terlihat. */
    const extent = () => {
      const bb = board.getBoundingBox();
      return 4 * Math.max(...bb.map((value: number) => Math.abs(value))) + 30;
    };

    /* Pembantu: kondisi tampil */
    const md = () => S.current.mode;
    const showIn = (...keys: PartKey[]) =>
      md() === "parts" && (S.current.focus === "all" || keys.includes(S.current.focus));
    const isInscribed = () => md() === "angle" || md() === "diameter";
    const piVal = () => PI_OPTIONS.find((o) => o.id === S.current.piMode)?.value ?? 3.14;

    /* Pembantu: geometri aktif */
    const cur = () => {
      const s = S.current;
      if (s.mode === "angle") return { r: s.ang.r, a: s.ang.a, t: s.ang.t };
      if (s.mode === "diameter") return { r: s.dia.r, a: s.dia.a, t: 180 };
      if (s.mode === "line") return { r: s.lin.r, a: 0, t: 0 };
      return s.sec;
    };
    const secG = () => sectorGeom(S.current.sec, piVal());
    const insG = () => (S.current.mode === "angle" ? angleGeom(S.current.ang) : diaGeom(S.current.dia));
    const linG = () => lineGeom(S.current.lin);
    const rho = () => Math.min(2, Math.max(0.7, cur().r * 0.25));

    /* Pembantu: pembuat elemen */
    const addCurve = (o: {
      color: string;
      w: number;
      dash?: number;
      fill?: number;
      vis: () => boolean;
      build: () => Vec[] | null;
    }) => {
      const curve = board.create("curve", [[0], [0]], {
        strokeColor: o.color,
        strokeWidth: o.w,
        fillColor: o.fill ? o.color : "none",
        fillOpacity: o.fill ?? 0,
        dash: o.dash ?? 0,
        highlight: false,
        fixed: true,
      }) as unknown as DataCurve;
      curve.updateDataArray = () => {
        const pts = o.build();
        if (!pts || pts.length === 0 || pts.some((q) => !finite(q[0]) || !finite(q[1]))) {
          curve.dataX = [Number.NaN];
          curve.dataY = [Number.NaN];
          return;
        }
        curve.dataX = pts.map((q) => q[0]);
        curve.dataY = pts.map((q) => q[1]);
      };
      regs.push({ els: [curve], vis: o.vis, w: o.w });
      return curve;
    };

    const addMarker = (o: {
      pos: () => Vec | null;
      color: string;
      name: () => string;
      place?: Place;
      size?: number;
      vis: () => boolean;
    }) => {
      const place: Place = o.place ?? { dx: 8, dy: 6, ax: "left", ay: "bottom" };
      const at = (): Vec => o.pos() ?? [Number.NaN, Number.NaN];
      const point = board.create("point", [() => at()[0], () => at()[1]], {
        name: "",
        withLabel: false,
        size: v.pointSize,
        fillColor: o.color,
        strokeColor: "#ffffff",
        strokeWidth: 1.5,
        fixed: true,
        highlight: false,
        showInfobox: false,
        layer: 7,
      }) as unknown as Settable;
      const label = board.create(
        "text",
        [
          () => (finite(at()[0]) ? at()[0] + px(place.dx) : 0),
          () => (finite(at()[1]) ? at()[1] + py(place.dy) : 0),
          () => {
            const p = o.pos();
            if (!p) return "";
            return S.current.view.pointLabels ? `${o.name()}${fmtPt(p[0], p[1])}` : o.name();
          },
        ],
        {
          anchorX: place.ax,
          anchorY: place.ay,
          fontSize: 12,
          strokeColor: o.color,
          highlight: false,
          fixed: true,
          layer: 8,
          cssStyle: HALO,
        },
      ) as unknown as Settable;
      regs.push({ els: [point], vis: o.vis, s: o.size ?? 0 }, { els: [label], vis: o.vis });
    };

    const addTag = (o: {
      pos: () => Vec | null;
      text: () => string;
      color: string;
      offset?: [number, number];
      vis: () => boolean;
    }) => {
      const tag = board.create(
        "text",
        [() => o.pos()?.[0] ?? 0, () => o.pos()?.[1] ?? 0, () => (o.pos() ? o.text() : "")],
        {
          fontSize: 13,
          strokeColor: o.color,
          offset: o.offset ?? [8, 8],
          highlight: false,
          fixed: true,
          layer: 8,
          cssStyle: HALO,
        },
      ) as unknown as Settable;
      regs.push({ els: [tag], vis: o.vis });
    };

    /* ── Lingkaran dan isian ── */
    addCurve({
      color: colors.guide,
      w: 0.5,
      vis: () => true,
      build: () => arcPoints(cur().r, 0, 360),
    });
    addCurve({
      color: colors.arc,
      w: 0,
      fill: 0.22,
      vis: () => showIn("sector") || md() === "area" || md() === "arc",
      build: () => {
        const g = cur();
        return [[0, 0], ...arcPoints(g.r, g.a, g.t), [0, 0]];
      },
    });
    addCurve({
      color: colors.segment,
      w: 0,
      fill: 0.34,
      vis: () => showIn("segment"),
      build: () => {
        const g = secG();
        return [...arcPoints(g.r, g.a, g.t), g.A];
      },
    });

    /* ── Garis-garis di sekitar juring ── */
    addCurve({
      color: colors.radius,
      w: 0.67,
      vis: () =>
        showIn("radius", "sector", "tangent") ||
        md() === "area" ||
        md() === "arc" ||
        (md() === "angle" && S.current.opts.central),
      build: () => [[0, 0], polar(cur().r, cur().a)],
    });
    addCurve({
      color: colors.radius,
      w: 0.67,
      vis: () =>
        showIn("radius", "sector") ||
        md() === "area" ||
        md() === "arc" ||
        (md() === "angle" && S.current.opts.central),
      build: () => [[0, 0], polar(cur().r, cur().a + cur().t)],
    });
    addCurve({
      color: colors.diameter,
      w: 0.9,
      vis: () => showIn("diameter") || md() === "diameter",
      build: () => [polar(cur().r, cur().a), polar(cur().r, cur().a + 180)],
    });
    addCurve({
      color: colors.chord,
      w: 0.9,
      vis: () => showIn("chord", "segment", "apothem"),
      build: () => {
        const g = secG();
        return [g.A, g.B];
      },
    });
    addCurve({
      color: colors.apothem,
      w: 0.5,
      dash: 2,
      vis: () => showIn("apothem"),
      build: () => [[0, 0], secG().M],
    });
    addCurve({
      color: colors.apothem,
      w: 0.5,
      vis: () => showIn("apothem"),
      build: () => {
        const g = secG();
        if (Math.abs(g.apothem) < 0.05) return null;
        return rightAnglePts(g.M, [0, 0], g.B, px(13));
      },
    });
    addCurve({
      color: colors.tangent,
      w: 0.75,
      vis: () => showIn("tangent"),
      build: () => {
        const g = secG();
        const d: Vec = [-Math.sin(g.a * DEG), Math.cos(g.a * DEG)];
        const e = extent();
        return [
          [g.A[0] - d[0] * e, g.A[1] - d[1] * e],
          [g.A[0] + d[0] * e, g.A[1] + d[1] * e],
        ];
      },
    });
    addCurve({
      color: colors.tangent,
      w: 0.5,
      vis: () => showIn("tangent"),
      build: () => {
        const g = secG();
        const d: Vec = [-Math.sin(g.a * DEG), Math.cos(g.a * DEG)];
        return rightAnglePts(g.A, [0, 0], [g.A[0] + d[0], g.A[1] + d[1]], px(13));
      },
    });

    /* ── Busur utama (tebal) ── */
    addCurve({
      color: colors.arc,
      w: 1.5,
      vis: () =>
        showIn("arc", "sector", "segment") ||
        md() === "area" ||
        md() === "arc" ||
        md() === "angle",
      build: () => {
        const g = cur();
        return arcPoints(g.r, g.a, g.t);
      },
    });

    /* ── Sudut pusat di O ── */
    const centralVis = () =>
      showIn("sector") ||
      md() === "area" ||
      md() === "arc" ||
      (isInscribed() && S.current.opts.central);
    addCurve({
      color: colors.angle,
      w: 0.8,
      vis: centralVis,
      build: () => {
        const g = cur();
        return arcPoints(rho(), g.a, g.t);
      },
    });
    addTag({
      pos: () => {
        const g = cur();
        return polar(rho() * 1.75, g.a + g.t / 2);
      },
      text: () => {
        const t = cur().t;
        return `${isInscribed() ? "∠AOB" : "θ"} = ${fmt(t, 1)}°`;
      },
      color: colors.angle,
      offset: [-14, -8],
      vis: centralVis,
    });

    /* ── Sudut keliling (materi 2 dan 3) ── */
    const showD = () => S.current.opts.showD;
    const seg = (from: "A" | "B", to: "C" | "D") =>
      addCurve({
        color: colors.inscribed,
        w: 0.6,
        vis: () => isInscribed() && (to === "C" || showD()),
        build: () => {
          const g = insG();
          return [g[to], g[from]];
        },
      });
    seg("A", "C");
    seg("B", "C");
    seg("A", "D");
    seg("B", "D");

    (["C", "D"] as const).forEach((who) => {
      const vis = () => isInscribed() && (who === "C" || showD());
      addCurve({
        color: colors.inscribed,
        w: 0.8,
        vis,
        build: () => {
          const g = insG();
          return arcAtVertex(g[who], g.A, g.B, px(24)).pts;
        },
      });
      addTag({
        pos: () => {
          const g = insG();
          const { mid } = arcAtVertex(g[who], g.A, g.B, px(24));
          return [g[who][0] + mid[0] * px(46), g[who][1] + mid[1] * px(46)];
        },
        text: () => {
          const g = insG();
          const val = who === "C" ? g.gc : g.gd;
          return `∠A${who}B = ${fmt(val, 1)}°`;
        },
        color: colors.inscribed,
        offset: [0, 0],
        vis,
      });
      addCurve({
        color: colors.inscribed,
        w: 0.6,
        vis: () => md() === "diameter" && vis(),
        build: () => {
          const g = insG();
          return rightAnglePts(g[who], g.A, g.B, px(14));
        },
      });
    });

    /* ── Garis dan lingkaran (materi 6) ── */
    const lineVis = () => md() === "line";
    addCurve({
      color: colors.line,
      w: 1,
      vis: lineVis,
      build: () => {
        const g = linG();
        const e = extent();
        return [
          [g.H[0] - g.u[0] * e, g.H[1] - g.u[1] * e],
          [g.H[0] + g.u[0] * e, g.H[1] + g.u[1] * e],
        ];
      },
    });
    addCurve({
      color: colors.guide,
      w: 0.6,
      dash: 2,
      vis: () => lineVis() && S.current.lin.d > 0.01,
      build: () => [[0, 0], linG().H],
    });
    addCurve({
      color: colors.guide,
      w: 0.5,
      vis: () => lineVis() && S.current.lin.d > 0.3,
      build: () => {
        const g = linG();
        return rightAnglePts(g.H, [0, 0], [g.H[0] + g.u[0], g.H[1] + g.u[1]], px(13));
      },
    });
    addCurve({
      color: colors.chord,
      w: 1.2,
      vis: () => lineVis() && S.current.opts.points && linG().kind === "secant",
      build: () => [linG().P, linG().Q],
    });
    addTag({
      pos: () => {
        const g = linG();
        return [g.H[0] / 2, g.H[1] / 2];
      },
      text: () => `d = ${fmt(S.current.lin.d)}`,
      color: colors.apothem,
      offset: [8, -14],
      vis: () => lineVis() && S.current.lin.d > 0.3,
    });
    addMarker({
      pos: () => (linG().kind === "outside" ? null : linG().P),
      color: colors.chord,
      name: () => (linG().kind === "tangent" ? "T" : "P"),
      size: 2,
      vis: () => lineVis() && S.current.opts.points && linG().kind !== "outside",
    });
    addMarker({
      pos: () => (linG().kind === "secant" ? linG().Q : null),
      color: colors.chord,
      name: () => "Q",
      size: 2,
      vis: () => lineVis() && S.current.opts.points && linG().kind === "secant",
    });

    /* ── Tag huruf pada juring ── */
    addTag({
      pos: () => {
        const g = secG();
        return [g.A[0] * 0.5, g.A[1] * 0.5];
      },
      text: () => "r",
      color: colors.radius,
      offset: [-4, 6],
      vis: () => showIn("radius", "sector") || md() === "area" || md() === "arc",
    });
    addTag({
      pos: () => {
        const g = secG();
        return [g.A2[0] * 0.5, g.A2[1] * 0.5];
      },
      text: () => "d",
      color: colors.diameter,
      offset: [8, -14],
      vis: () => showIn("diameter"),
    });
    addTag({
      pos: () => {
        const g = secG();
        return [(g.A[0] + g.B[0]) / 2, (g.A[1] + g.B[1]) / 2];
      },
      text: () => "c",
      color: colors.chord,
      offset: [8, -14],
      vis: () => showIn("chord"),
    });
    addTag({
      pos: () => {
        const g = secG();
        return polar(g.r * 0.6, g.mid);
      },
      text: () => `L = ${fmt(secG().sector)}`,
      color: colors.arc,
      offset: [-14, -6],
      vis: () => md() === "area",
    });
    addTag({
      pos: () => {
        const g = secG();
        return polar(g.r * 1.1, g.mid);
      },
      text: () => `s = ${fmt(secG().arc)}`,
      color: colors.arc,
      offset: [4, 4],
      vis: () => md() === "arc",
    });

    /* ── Titik turunan ── */
    addMarker({
      pos: () => [0, 0],
      color: colors.radius,
      name: () => "O",
      size: 1,
      place: { dx: -8, dy: -6, ax: "right", ay: "top" },
      vis: () => true,
    });
    addMarker({
      pos: () => secG().M,
      color: colors.apothem,
      name: () => "M",
      place: { dx: 8, dy: -6, ax: "left", ay: "top" },
      vis: () => showIn("apothem"),
    });
    addMarker({
      pos: () => secG().A2,
      color: colors.diameter,
      name: () => "A′",
      vis: () => showIn("diameter"),
    });

    /* ── Titik yang bisa diseret (paling atas) ── */
    const names = (i: number) => {
      if (S.current.mode === "line") return "H";
      return ["A", "B", "C", "D"][i];
    };
    const handleColors = [colors.radius, colors.radius, colors.inscribed, colors.inscribed];
    const handles: PointEl[] = [0, 1, 2, 3].map((i) => {
      const hex = S.current.mode === "line" ? colors.line : handleColors[i];
      const h = board.create("point", [0, 0], {
        name: "",
        withLabel: false,
        size: v.pointSize + 2,
        fillColor: "#ffffff",
        strokeColor: hex,
        strokeWidth: 3,
        highlightFillColor: "#ffffff",
        highlightStrokeColor: hex,
        showInfobox: false,
        snapToGrid: false,
        layer: 9,
      }) as unknown as PointEl;
      h.on("drag", () => apiRef.current.drag(i, h.X(), h.Y()));
      const label = board.create(
        "text",
        [
          () => h.X() + px(10),
          () => h.Y() + py(8),
          () =>
            S.current.view.pointLabels
              ? `${names(i)}${fmtPt(h.X(), h.Y())}`
              : names(i),
        ],
        {
          anchorX: "left",
          anchorY: "bottom",
          fontSize: 13,
          strokeColor: colors.radius,
          highlight: false,
          fixed: true,
          layer: 8,
          cssStyle: HALO,
        },
      ) as unknown as Settable;
      regs.push({ els: [h, label], vis: () => handleVisible(i) });
      return h;
    });

    scene.current = { grid, axes: [xAxis, yAxis], regs, handles };
    applyView();
  };

  const { boardProps, boardRef, zoomIn, zoomOut, resetView } = useJsxBoard({
    boundingBox: initialBox,
    setup,
  });

  /* ───────── Titik yang bisa diseret ───────── */

  /** Posisi keempat pegangan menurut materi aktif; null = tidak dipakai. */
  function handlePositions(): (Vec | null)[] {
    const s = S.current;
    switch (s.mode) {
      case "angle": {
        const g = angleGeom(s.ang);
        return [g.A, g.B, g.C, g.D];
      }
      case "diameter": {
        const g = diaGeom(s.dia);
        return [g.A, g.B, g.C, g.D];
      }
      case "line":
        return [lineGeom(s.lin).H, null, null, null];
      default: {
        const g = sectorGeom(s.sec, 3.14);
        return [g.A, g.B, null, null];
      }
    }
  }

  function handleVisible(i: number) {
    const pos = handlePositions()[i];
    if (!pos) return false;
    if (i === 3 && !S.current.opts.showD) return false;
    return true;
  }

  function placeHandles() {
    const s = scene.current;
    if (!s) return;
    const pos = handlePositions();
    s.handles.forEach((h, i) => {
      const p = pos[i];
      if (p) h.setPosition(COORDS_BY_USER, [p[0], p[1]]);
    });
  }

  /** Menerapkan tampil/sembunyi, tebal garis, dan ukuran titik ke papan. */
  function applyView() {
    const s = scene.current;
    if (!s) return;
    const vw = S.current.view;
    s.grid.setAttribute({ visible: vw.grid });
    s.axes.forEach((axis) =>
      axis.defaultTicks.setAttribute({ visible: vw.axisNumbers, drawLabels: vw.axisNumbers }),
    );
    s.regs.forEach((reg) => {
      const attrs: Record<string, unknown> = { visible: reg.vis() };
      if (reg.w !== undefined) {
        attrs.strokeWidth = reg.w === 0 ? 0 : Math.max(1, vw.curveWidth * reg.w * 1.0);
      }
      if (reg.s !== undefined) attrs.size = vw.pointSize + reg.s;
      reg.els.forEach((el) => el.setAttribute(attrs));
    });
    s.handles.forEach((h) => h.setAttribute({ size: vw.pointSize + 2 }));
    placeHandles();
    boardRef.current?.update();
  }

  useEffect(() => {
    applyView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, mode, focus, opts]);

  useEffect(() => {
    placeHandles();
    boardRef.current?.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sec, ang, dia, lin, mode, opts]);

  useEffect(() => {
    resetView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /* ───────── Perubahan dari pengguna ───────── */

  const refresh = () => boardRef.current?.update();
  const patchSec = (c: Partial<Sector>) => {
    const next = { ...S.current.sec, ...c };
    S.current.sec = next;
    setSec(next);
    refresh();
  };
  const patchAng = (c: Partial<Inscribed>) => {
    const next = { ...S.current.ang, ...c };
    S.current.ang = next;
    setAng(next);
    refresh();
  };
  const patchDia = (c: Partial<Diam>) => {
    const next = { ...S.current.dia, ...c };
    S.current.dia = next;
    setDia(next);
    refresh();
  };
  const patchLin = (c: Partial<LineP>) => {
    const next = { ...S.current.lin, ...c };
    S.current.lin = next;
    setLin(next);
    refresh();
  };

  /** Geser manual selalu menghentikan animasi. */
  const edit = (fn: () => void) => {
    setAnim(null);
    fn();
  };

  // Seret titik di grafik.
  apiRef.current.drag = (i, x, y) => {
    const s = S.current;
    const dir = angleDeg(x, y);
    const sn = (deg: number) => snap(deg, s.angStep);
    setAnim(null);

    if (s.mode === "parts" || s.mode === "area" || s.mode === "arc") {
      const { a, t } = s.sec;
      if (i === 0) {
        const na = sn(dir);
        const raw = mod360(a + t - na);
        patchSec({ a: wrap180(na), t: raw < 0.5 ? 360 : raw });
      } else if (i === 1) {
        const raw = mod360(sn(dir) - a);
        patchSec({ t: raw < 0.5 ? 360 : raw });
      }
    } else if (s.mode === "angle") {
      const { a, t } = s.ang;
      if (i === 0) {
        const nt = clampT(mod360(a + t - sn(dir)));
        patchAng({ a: wrap180(a + t - nt), t: nt });
      } else if (i === 1) {
        patchAng({ t: clampT(mod360(sn(dir) - a)) });
      } else {
        const f = relOnMajor(mod360(dir - (a + t)), t);
        patchAng(i === 2 ? { c: f } : { d: f });
      }
    } else if (s.mode === "diameter") {
      if (i === 0) patchDia({ a: wrap180(sn(dir)) });
      else if (i === 1) patchDia({ a: wrap180(sn(dir) - 180) });
      else {
        const rel = clampRel(dir - s.dia.a);
        patchDia(i === 2 ? { c: rel } : { d: rel });
      }
    } else if (i === 0) {
      const dist = clamp(snap(Math.hypot(x, y), s.lenStep), 0, D_MAX);
      patchLin({ d: dist, al: dist < 1e-9 ? s.lin.al : wrap180(sn(dir)) });
    }
    placeHandles();
  };

  const updateView = (change: Partial<ViewState>) => {
    const next = { ...S.current.view, ...change };
    S.current.view = next;
    setStoredView(next);
  };

  const changeMode = (m: Mode) => {
    setAnim(null);
    setMode(m);
  };

  const resetAll = () => {
    setAnim(null);
    setFocus("all");
    setOpts(initialOpts);
    if (mode === "angle") patchAng(initialAngle);
    else if (mode === "diameter") patchDia(initialDiam);
    else if (mode === "line") patchLin(initialLine);
    else patchSec(initialSector);
    resetView();
  };

  // Animasi
  useEffect(() => {
    if (!anim) return;
    const m = S.current.mode;
    let raf = 0;
    let last = performance.now();
    let dir = 1;
    let t = m === "angle" ? S.current.ang.t : S.current.sec.t;
    let a = m === "angle" ? S.current.ang.a : m === "diameter" ? S.current.dia.a : S.current.sec.a;
    let c = S.current.ang.c;
    let rel = S.current.dia.c;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (anim === "t") {
        const lo = m === "angle" ? 10 : 1;
        const hi = m === "angle" ? 180 : 360;
        t += dir * dt * 45;
        if (t >= hi) {
          t = hi;
          dir = -1;
        } else if (t <= lo) {
          t = lo;
          dir = 1;
        }
        if (m === "angle") patchAng({ t: Math.round(t * 10) / 10 });
        else patchSec({ t: Math.round(t * 10) / 10 });
      } else if (anim === "p") {
        a += dt * 30;
        if (a > 180) a -= 360;
        const r1 = Math.round(a * 10) / 10;
        if (m === "angle") patchAng({ a: r1 });
        else if (m === "diameter") patchDia({ a: r1 });
        else patchSec({ a: r1 });
      } else if (m === "angle") {
        c += dir * dt * 0.22;
        if (c >= 1) {
          c = 1;
          dir = -1;
        } else if (c <= 0) {
          c = 0;
          dir = 1;
        }
        patchAng({ c, d: 1 - c });
      } else if (m === "diameter") {
        rel = clampRel(rel + dt * 40);
        patchDia({ c: rel });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anim]);

  /* ───────── Nilai turunan untuk panel ───────── */

  const sg = sectorGeom(sec, pi.value);
  const ag = angleGeom(ang);
  const dg = diaGeom(dia);
  const lg = lineGeom(lin);
  const isSectorMode = mode === "parts" || mode === "area" || mode === "arc";
  const tMin = Math.max(angStep, mode === "angle" ? 10 : 1);

  const verdict: Record<LineKind, { text: string; color: string; sign: string }> = {
    secant: {
      text: "Garis memotong lingkaran di dua titik.",
      color: colors.chord,
      sign: "<",
    },
    tangent: {
      text: "Garis menyinggung lingkaran di satu titik.",
      color: colors.tangent,
      sign: "=",
    },
    outside: {
      text: "Garis tidak memotong lingkaran (berada di luar).",
      color: colors.apothem,
      sign: ">",
    },
  };

  const overlayTex = (() => {
    if (mode === "angle") {
      return String.raw`\angle AOB=${tex(ang.t, 1)}^{\circ},\ \angle ACB=${tex(ag.gc, 1)}^{\circ}`;
    }
    if (mode === "diameter") return String.raw`\angle ACB=${tex(dg.gc, 1)}^{\circ}`;
    if (mode === "line") return String.raw`d=${tex(lin.d)},\ r=${tex(lin.r)}`;
    if (mode === "arc") return String.raw`\theta=${tex(sec.t, 1)}^{\circ},\ s=${tex(sg.arc)}`;
    if (mode === "area") return String.raw`\theta=${tex(sec.t, 1)}^{\circ},\ L=${tex(sg.sector)}`;
    return String.raw`\theta=${tex(sec.t, 1)}^{\circ},\ s=${tex(sg.arc)},\ L=${tex(sg.sector)}`;
  })();

  /* ───────── Bagian panel ───────── */

  const rSlider = (value: number, onChange: (v: number) => void) => (
    <SimSlider
      id="cir-r"
      name="r"
      label={K(`r=${tex(value, 1)}`)}
      hint="jari-jari"
      accent={colors.radius}
      value={value}
      min={R_RANGE[0]}
      max={R_RANGE[1]}
      step={lenStep}
      valueText={`r sama dengan ${fmt(value, 1)}`}
      onChange={(x) => edit(() => onChange(x))}
    />
  );
  const phiSlider = (value: number, onChange: (v: number) => void, hint: string) => (
    <SimSlider
      id="cir-phi"
      name="φ"
      label={K(String.raw`\varphi=${tex(value, 1)}^{\circ}`)}
      hint={hint}
      accent={colors.diameter}
      value={value}
      min={-180}
      max={180}
      step={angStep}
      valueText={`φ sama dengan ${fmt(value, 1)} derajat`}
      onChange={(x) => edit(() => onChange(x))}
    />
  );
  const thetaSlider = (
    value: number,
    max: number,
    onChange: (v: number) => void,
    hint: string,
  ) => (
    <SimSlider
      id="cir-theta"
      name="θ"
      label={K(String.raw`\theta=${tex(value, 1)}^{\circ}`)}
      hint={hint}
      accent={colors.angle}
      value={value}
      min={tMin}
      max={max}
      step={angStep}
      valueText={`θ sama dengan ${fmt(value, 1)} derajat`}
      onChange={(x) => edit(() => onChange(x))}
    />
  );

  const params =
    mode === "angle" ? (
      <>
        {rSlider(ang.r, (r) => patchAng({ r }))}
        {thetaSlider(ang.t, 180, (t) => patchAng({ t }), "sudut pusat AOB")}
        {phiSlider(ang.a, (a) => patchAng({ a }), "arah titik A")}
      </>
    ) : mode === "diameter" ? (
      <>
        {rSlider(dia.r, (r) => patchDia({ r }))}
        {phiSlider(dia.a, (a) => patchDia({ a }), "arah diameter")}
      </>
    ) : mode === "line" ? (
      <>
        {rSlider(lin.r, (r) => patchLin({ r }))}
        <SimSlider
          id="cir-d"
          name="d"
          label={K(`d=${tex(lin.d, 1)}`)}
          hint="jarak pusat ke garis"
          accent={colors.apothem}
          value={lin.d}
          min={0}
          max={D_MAX}
          step={lenStep}
          valueText={`d sama dengan ${fmt(lin.d, 1)}`}
          onChange={(d) => edit(() => patchLin({ d }))}
        />
        <SimSlider
          id="cir-alpha"
          name="α"
          label={K(String.raw`\alpha=${tex(lin.al, 1)}^{\circ}`)}
          hint="arah OH"
          accent={colors.line}
          value={lin.al}
          min={-180}
          max={180}
          step={angStep}
          valueText={`α sama dengan ${fmt(lin.al, 1)} derajat`}
          onChange={(al) => edit(() => patchLin({ al }))}
        />
      </>
    ) : (
      <>
        {rSlider(sec.r, (r) => patchSec({ r }))}
        {thetaSlider(sec.t, 360, (t) => patchSec({ t }), "sudut pusat")}
        {phiSlider(sec.a, (a) => patchSec({ a }), "arah titik A")}
      </>
    );

  const piSection = (
    <>
      <p className="sim-cir-step-label">Nilai π</p>
      <div className="sim-seg" role="radiogroup" aria-label="Nilai pi">
        {PI_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={piMode === o.id}
            className="sim-seg__btn"
            onClick={() => setPiMode(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </>
  );

  const presetAngles = (
    <>
      <p className="sim-cir-step-label">Sudut pusat istimewa</p>
      <div className="sim-chips" role="group" aria-label="Sudut pusat istimewa">
        {[30, 45, 60, 90, 120, 180, 270].map((t) => (
          <button
            key={t}
            type="button"
            className="sim-chip"
            aria-pressed={Math.abs(sec.t - t) < 0.05}
            onClick={() => edit(() => patchSec({ t }))}
          >
            {t}°
          </button>
        ))}
      </div>
    </>
  );

  const toolsSection = (() => {
    const anims = ANIMS[mode];
    return (
      <SimSection title="Alat bantu">
        {mode === "parts" && (
          <>
            <p className="sim-cir-step-label">Pilih bagian lingkaran</p>
            <div className="sim-chips" role="group" aria-label="Pilih bagian lingkaran">
              {PARTS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className="sim-chip"
                  aria-pressed={focus === p.key}
                  onClick={() => setFocus(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </>
        )}
        {isSectorMode && presetAngles}
        {(mode === "area" || mode === "arc" || mode === "parts") && piSection}
        {(mode === "angle" || mode === "diameter") && (
          <div className="sim-cir-actions">
            <button
              type="button"
              className="sim-text-btn"
              aria-pressed={opts.showD}
              onClick={() => setOpts({ ...opts, showD: !opts.showD })}
            >
              Titik D (sudut keliling kedua)
            </button>
            <button
              type="button"
              className="sim-text-btn"
              aria-pressed={opts.central}
              onClick={() => setOpts({ ...opts, central: !opts.central })}
            >
              Sudut pusat ∠AOB
            </button>
          </div>
        )}
        {mode === "line" && (
          <>
            <p className="sim-cir-step-label">Atur kedudukan garis</p>
            <div className="sim-chips" role="group" aria-label="Kedudukan garis">
              <button
                type="button"
                className="sim-chip"
                aria-pressed={lg.kind === "secant"}
                onClick={() => edit(() => patchLin({ d: snap(lin.r / 2, 0.1) }))}
              >
                Memotong
              </button>
              <button
                type="button"
                className="sim-chip"
                aria-pressed={lg.kind === "tangent"}
                onClick={() => edit(() => patchLin({ d: lin.r }))}
              >
                Menyinggung
              </button>
              <button
                type="button"
                className="sim-chip"
                aria-pressed={lg.kind === "outside"}
                onClick={() => edit(() => patchLin({ d: Math.min(D_MAX, lin.r + 2) }))}
              >
                Di luar
              </button>
            </div>
            <div className="sim-cir-actions" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="sim-text-btn"
                aria-pressed={opts.points}
                style={{ "--sim-accent": colors.chord } as CSSProperties}
                onClick={() => setOpts({ ...opts, points: !opts.points })}
              >
                {opts.points ? "Sembunyikan titik potong" : "Tampilkan titik potong"}
              </button>
            </div>
          </>
        )}
        {anims.length > 0 && (
          <div className="sim-cir-actions" style={{ marginTop: 6 }}>
            {anims.map((item) => (
              <button
                key={item.id}
                type="button"
                className="sim-text-btn"
                aria-pressed={anim === item.id}
                onClick={() => setAnim(anim === item.id ? null : item.id)}
              >
                {anim === item.id ? item.off : item.on}
              </button>
            ))}
          </div>
        )}
      </SimSection>
    );
  })();

  const stepSection = (
    <SimSection title="Langkah tombol − / +">
      <p className="sim-cir-step-label">Sudut (θ, φ, α) dan seret titik</p>
      <div className="sim-seg" role="radiogroup" aria-label="Langkah sudut">
        {ANG_STEPS.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={angStep === s}
            className="sim-seg__btn"
            onClick={() => setAngStep(s)}
          >
            {s}°
          </button>
        ))}
      </div>
      <p className="sim-cir-step-label">Panjang (r dan d)</p>
      <div className="sim-seg" role="radiogroup" aria-label="Langkah panjang">
        {LEN_STEPS.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={lenStep === s}
            className="sim-seg__btn"
            onClick={() => setLenStep(s)}
          >
            {stepText(s)} satuan
          </button>
        ))}
      </div>
    </SimSection>
  );

  /* Hasil per materi */

  const partRow = (key: PartKey): { color: string; tex: string } | null => {
    const r = sec.r;
    switch (key) {
      case "center":
        return { color: colors.radius, tex: String.raw`O(0,0)` };
      case "radius":
        return { color: colors.radius, tex: String.raw`OA=OB=r=${tex(r)}` };
      case "diameter":
        return { color: colors.diameter, tex: String.raw`d=2r=2\times ${tex(r)}=${tex(2 * r)}` };
      case "chord":
        return {
          color: colors.chord,
          tex: String.raw`AB=2r\sin\dfrac{\theta}{2}=${tex(sg.chord)}`,
        };
      case "arc":
        return {
          color: colors.arc,
          tex: String.raw`s=\dfrac{\theta}{360^{\circ}}\times 2\pi r=\dfrac{${tex(sec.t, 1)}}{360}\times 2\times ${pi.tex}\times ${tex(r)}=${tex(sg.arc)}`,
        };
      case "sector":
        return {
          color: colors.arc,
          tex: String.raw`L=\dfrac{\theta}{360^{\circ}}\times \pi r^{2}=\dfrac{${tex(sec.t, 1)}}{360}\times ${pi.tex}\times ${tex(r)}^{2}=${tex(sg.sector)}`,
        };
      case "segment":
        return {
          color: colors.segment,
          tex: String.raw`L_{\text{tembereng}}=L_{\text{juring}}-L_{\triangle OAB}=${tex(sg.sector)}-${tex(sg.tri)}=${tex(sg.segment)}`,
        };
      case "apothem":
        return {
          color: colors.apothem,
          tex: String.raw`OM=r\cos\dfrac{\theta}{2}=${tex(Math.abs(sg.apothem))}`,
        };
      case "tangent":
        return {
          color: colors.tangent,
          tex: String.raw`\text{di }A:\ ${polyTex([
            [sg.A[0], "x"],
            [sg.A[1], "y"],
          ])}=${tex(r * r)}`,
        };
      default:
        return null;
    }
  };

  const focusInfo = PARTS.find((p) => p.key === focus) ?? PARTS[0];
  const allPartKeys: PartKey[] = [
    "center",
    "radius",
    "diameter",
    "chord",
    "arc",
    "sector",
    "segment",
    "apothem",
    "tangent",
  ];

  const results: ReactNode = (() => {
    if (mode === "parts") {
      const keys = focus === "all" ? allPartKeys : [focus];
      return (
        <>
          {focus !== "all" && (
            <p
              className="sim-cir-def"
              style={{ "--sim-accent": focusInfo.color } as CSSProperties}
            >
              <strong>{focusInfo.label}.</strong> {focusInfo.def}
            </p>
          )}
          <ul className="sim-rows" aria-live="polite">
            {keys.map((k) => {
              const row = partRow(k);
              return row ? (
                <SimRow key={k} color={row.color}>
                  {K(row.tex)}
                </SimRow>
              ) : null;
            })}
            {focus === "all" && (
              <>
                <SimRow color={colors.angle}>{K(String.raw`\angle AOB=\theta=${tex(sec.t, 1)}^{\circ}`)}</SimRow>
                <SimRow>
                  {K(String.raw`K_{\text{lingkaran}}=2\pi r=${tex(sg.circ)}`)}
                </SimRow>
                <SimRow>
                  {K(String.raw`L_{\text{lingkaran}}=\pi r^{2}=${tex(sg.area)}`)}
                </SimRow>
              </>
            )}
          </ul>
          {focus === "all" && (
            <p className="sim-hint">Pilih satu bagian di “Alat bantu” untuk melihatnya sendiri.</p>
          )}
        </>
      );
    }

    if (mode === "area") {
      return (
        <>
          <ul className="sim-rows" aria-live="polite">
            <SimRow>
              {K(String.raw`L_{\text{lingkaran}}=\pi r^{2}=${pi.tex}\times ${tex(sec.r)}^{2}=${tex(sg.area)}`)}
            </SimRow>
            <SimRow color={colors.angle}>
              {K(
                String.raw`\dfrac{\theta}{360^{\circ}}=\dfrac{${tex(sec.t, 1)}}{360}=${tex(sg.frac, 3)}\ (${tex(sg.frac * 100, 1)}\%)`,
              )}
            </SimRow>
          </ul>
          <FractionBar
            value={sg.frac}
            color={colors.arc}
            label={`Juring mencakup ${fmt(sg.frac * 100, 1)} persen lingkaran`}
          />
          <ul className="sim-rows">
            <SimRow color={colors.arc}>
              {K(
                String.raw`L_{\text{juring}}=\dfrac{\theta}{360^{\circ}}\times \pi r^{2}=\dfrac{${tex(sec.t, 1)}}{360}\times ${pi.tex}\times ${tex(sec.r)}^{2}=${tex(sg.sector)}`,
              )}
            </SimRow>
            <SimRow>
              {K(
                String.raw`\text{Cek: }\tfrac{1}{2}\times r\times s=\tfrac{1}{2}\times ${tex(sec.r)}\times ${tex(sg.arc)}=${tex(0.5 * sec.r * sg.arc)}`,
              )}
            </SimRow>
          </ul>
        </>
      );
    }

    if (mode === "arc") {
      return (
        <>
          <ul className="sim-rows" aria-live="polite">
            <SimRow>
              {K(String.raw`K_{\text{lingkaran}}=2\pi r=2\times ${pi.tex}\times ${tex(sec.r)}=${tex(sg.circ)}`)}
            </SimRow>
            <SimRow color={colors.angle}>
              {K(
                String.raw`\dfrac{\theta}{360^{\circ}}=\dfrac{${tex(sec.t, 1)}}{360}=${tex(sg.frac, 3)}\ (${tex(sg.frac * 100, 1)}\%)`,
              )}
            </SimRow>
          </ul>
          <FractionBar
            value={sg.frac}
            color={colors.arc}
            label={`Busur mencakup ${fmt(sg.frac * 100, 1)} persen keliling lingkaran`}
          />
          <ul className="sim-rows">
            <SimRow color={colors.arc}>
              {K(
                String.raw`s=\dfrac{\theta}{360^{\circ}}\times 2\pi r=\dfrac{${tex(sec.t, 1)}}{360}\times 2\times ${pi.tex}\times ${tex(sec.r)}=${tex(sg.arc)}`,
              )}
            </SimRow>
            <SimRow>
              {K(String.raw`K_{\text{juring}}=2r+s=2\times ${tex(sec.r)}+${tex(sg.arc)}=${tex(sg.perimeter)}`)}
            </SimRow>
            <SimRow color={colors.chord}>
              {K(String.raw`\text{Tali busur }AB=${tex(sg.chord)}\ \text{(lebih pendek dari busur)}`)}
            </SimRow>
          </ul>
        </>
      );
    }

    if (mode === "angle") {
      const same = Math.abs(ag.gc - ag.gd) < 0.05;
      return (
        <>
          <ul className="sim-rows" aria-live="polite">
            <SimRow color={colors.angle}>
              {K(String.raw`\angle AOB=${tex(ang.t, 1)}^{\circ}\ \text{(sudut pusat)}`)}
            </SimRow>
            <SimRow color={colors.inscribed}>
              {K(String.raw`\angle ACB=${tex(ag.gc, 1)}^{\circ}\ \text{(sudut keliling)}`)}
            </SimRow>
            {opts.showD && (
              <SimRow color={colors.inscribed}>
                {K(String.raw`\angle ADB=${tex(ag.gd, 1)}^{\circ}\ \text{(sudut keliling)}`)}
              </SimRow>
            )}
            <SimRow color={colors.angle}>
              {K(
                String.raw`\angle AOB=2\times\angle ACB:\ ${tex(ang.t, 1)}=2\times ${tex(ag.gc, 1)}`,
              )}
            </SimRow>
          </ul>
          <p className="sim-callout" role="status">
            {opts.showD
              ? same
                ? "∠ACB dan ∠ADB menghadap busur AB yang sama, sehingga besarnya sama."
                : "Sudut keliling yang menghadap busur yang sama selalu sama besar."
              : "Seret titik C di busur besar: ∠ACB tidak berubah."}
          </p>
        </>
      );
    }

    if (mode === "diameter") {
      return (
        <>
          <ul className="sim-rows" aria-live="polite">
            <SimRow color={colors.diameter}>
              {K(String.raw`AB=2r=${tex(2 * dia.r)}\ \text{(diameter)}`)}
            </SimRow>
            <SimRow color={colors.angle}>{K(String.raw`\angle AOB=180^{\circ}`)}</SimRow>
            <SimRow color={colors.inscribed}>
              {K(String.raw`\angle ACB=\tfrac{1}{2}\times 180^{\circ}=${tex(dg.gc, 1)}^{\circ}`)}
            </SimRow>
            {opts.showD && (
              <SimRow color={colors.inscribed}>
                {K(String.raw`\angle ADB=${tex(dg.gd, 1)}^{\circ}`)}
              </SimRow>
            )}
            <SimRow>
              {K(
                String.raw`AC^{2}+BC^{2}=${tex(dg.ac2)}+${tex(dg.bc2)}=${tex(dg.ac2 + dg.bc2)}`,
              )}
            </SimRow>
            <SimRow>{K(String.raw`AB^{2}=${tex(dg.ab2)}`)}</SimRow>
          </ul>
          <p className="sim-callout" role="status">
            Karena AC² + BC² = AB², segitiga ABC siku-siku di C. Di mana pun C berada pada
            lingkaran, sudutnya tetap 90°.
          </p>
        </>
      );
    }

    // line
    const vd = verdict[lg.kind];
    return (
      <>
        <ul className="sim-rows" aria-live="polite">
          <SimRow color={colors.guide}>{K(String.raw`x^{2}+y^{2}=${tex(lin.r * lin.r)}`)}</SimRow>
          <SimRow color={colors.line}>
            {K(
              String.raw`${polyTex([
                [lg.c, "x"],
                [lg.s, "y"],
              ])}=${tex(lin.d)}`,
            )}
          </SimRow>
          <SimRow color={colors.apothem}>
            {K(String.raw`d=OH=${tex(lin.d)},\quad r=${tex(lin.r)}`)}
          </SimRow>
          <SimRow color={vd.color}>
            {K(String.raw`d\ ${vd.sign}\ r:\quad ${tex(lin.d)}\ ${vd.sign}\ ${tex(lin.r)}`)}
          </SimRow>
        </ul>
        <p
          className="sim-cir-verdict"
          role="status"
          style={{ "--sim-accent": vd.color } as CSSProperties}
        >
          {vd.text}
        </p>
        {!opts.points ? (
          <p className="sim-hint">Tekan “Tampilkan titik potong” untuk melihat titiknya.</p>
        ) : lg.kind === "secant" ? (
          <ul className="sim-rows">
            <SimRow color={colors.chord}>{K(`P${texPt(lg.P)},\\ Q${texPt(lg.Q)}`)}</SimRow>
            <SimRow color={colors.chord}>
              {K(
                String.raw`PQ=2\sqrt{r^{2}-d^{2}}=2\sqrt{${tex(lin.r * lin.r)}-${tex(lin.d * lin.d)}}=${tex(2 * lg.h)}`,
              )}
            </SimRow>
          </ul>
        ) : lg.kind === "tangent" ? (
          <ul className="sim-rows">
            <SimRow color={colors.chord}>{K(`T${texPt(lg.H)}`)}</SimRow>
            <SimRow>{K(String.raw`OT\perp\text{garis},\ OT=r`)}</SimRow>
          </ul>
        ) : (
          <p className="sim-hint">Tidak ada titik potong.</p>
        )}
      </>
    );
  })();

  /* ───────── Catatan ───────── */

  const notes: ReactNode = (() => {
    switch (mode) {
      case "angle":
        return (
          <>
            <p style={{ margin: 0 }}>
              <strong style={{ color: colors.inscribed }}>Sudut keliling: </strong>
              besarnya setengah sudut pusat yang menghadap busur yang sama,{" "}
              {K(String.raw`\angle ACB=\tfrac{1}{2}\angle AOB`)}.
            </p>
            <p style={{ margin: 0 }}>
              <strong style={{ color: colors.angle }}>Sama besar: </strong>
              seret C atau D di busur besar. Sudut kelilingnya tidak berubah, dan dua sudut keliling
              yang menghadap busur AB selalu sama besar.
            </p>
          </>
        );
      case "diameter":
        return (
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.inscribed }}>Sudut di diameter: </strong>
            diameter adalah busur setengah lingkaran, sudut pusatnya 180°. Sudut keliling yang
            menghadapnya{" "}
            {K(String.raw`\tfrac{1}{2}\times 180^{\circ}=90^{\circ}`)}.
          </p>
        );
      case "area":
        return (
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.arc }}>Luas juring: </strong>
            {K(String.raw`L=\dfrac{\theta}{360^{\circ}}\times\pi r^{2}`)}. Luas juring sebanding
            dengan sudut pusatnya: sudut dua kali lebih besar, luasnya dua kali lebih besar.
          </p>
        );
      case "arc":
        return (
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.arc }}>Panjang busur: </strong>
            {K(String.raw`s=\dfrac{\theta}{360^{\circ}}\times 2\pi r`)}. Busur adalah bagian dari
            keliling lingkaran sebesar perbandingan sudut pusatnya terhadap 360°.
          </p>
        );
      case "line":
        return (
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.line }}>Kedudukan garis: </strong>
            bandingkan jarak pusat ke garis <SimMath tex="d" /> dengan jari-jari{" "}
            <SimMath tex="r" />. Bila <SimMath tex="d<r" /> garis memotong, bila{" "}
            <SimMath tex="d=r" /> menyinggung, bila <SimMath tex="d>r" /> berada di luar. Seret
            titik H untuk menggeser garis.
          </p>
        );
      default:
        return (
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.radius }}>Bagian lingkaran: </strong>
            pilih satu bagian untuk melihatnya sendiri. Seret titik A dan B di lingkaran untuk
            mengubah tali busur, busur, juring, dan tembereng.
          </p>
        );
    }
  })();

  /* ───────── Tampilan ───────── */

  return (
    <SimulationShell
      title="Simulasi lingkaran"
      onReset={resetAll}
      onZoomIn={zoomIn}
      onZoomOut={zoomOut}
      onHome={resetView}
      toggles={
        <>
          <SimToggle
            icon={<GridIcon />}
            label="Grid"
            pressed={view.grid}
            onClick={() => updateView({ grid: !view.grid })}
          />
          <SimToggle
            icon={<AxisNumbersIcon />}
            label="Angka sumbu"
            pressed={view.axisNumbers}
            onClick={() => updateView({ axisNumbers: !view.axisNumbers })}
          />
          <SimToggle
            icon={<PointLabelIcon />}
            label="Koordinat titik"
            pressed={view.pointLabels}
            onClick={() => updateView({ pointLabels: !view.pointLabels })}
          />
        </>
      }
      settings={
        <SimSection title="Garis dan titik">
          <SimSlider
            id="cir-curve-width"
            name="tebal garis"
            label={`Tebal garis: ${view.curveWidth}`}
            value={view.curveWidth}
            min={1}
            max={8}
            step={1}
            onChange={(curveWidth) => updateView({ curveWidth })}
          />
          <SimSlider
            id="cir-point-size"
            name="ukuran titik"
            label={`Ukuran titik: ${view.pointSize}`}
            value={view.pointSize}
            min={2}
            max={10}
            step={1}
            onChange={(pointSize) => updateView({ pointSize })}
          />
          <button
            type="button"
            className="sim-text-btn"
            onClick={() => updateView(initialView)}
          >
            Atur ulang tampilan
          </button>
        </SimSection>
      }
      graph={
        <div
          {...boardProps}
          role="img"
          aria-label="Grafik lingkaran berpusat di titik asal. Seret titik putih di lingkaran untuk mengubah sudut dan posisi, cubit atau gulir untuk memperbesar."
        />
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          <SimMath tex={overlayTex} />
        </p>
      }
      panel={
        <>
          <SimSection title="Materi">
            <div
              className="sim-seg sim-seg--kinds sim-cir-modes"
              role="radiogroup"
              aria-label="Pilih materi"
            >
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  className="sim-seg__btn"
                  style={{ "--sim-accent": m.color } as CSSProperties}
                  onClick={() => changeMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </SimSection>

          <SimSection title="Parameter" sticky>
            {params}
          </SimSection>

          {toolsSection}
          {stepSection}

          <SimSection title="Hasil">{results}</SimSection>
        </>
      }
      notes={notes}
    />
  );
}

export default CircleSectorSimulation;
