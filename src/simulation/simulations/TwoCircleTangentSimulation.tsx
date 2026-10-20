import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { clamp, formatText, snap, texNumber } from "../common/utils/simUtils";
import { useJsxBoard, type BoundingBox, type SimBoard } from "../common/hooks/useJsxBoard";
import { useStoredSimulationState } from "../common/hooks/useStoredSimulationState";

/* Simulasi dua lingkaran dan garis singgung persekutuannya.
   Kerangka, slider, dan CSS memakai kit umum (prefix sim-).

   Lingkaran 1: pusat O₁(x₁, y₁), jari-jari r₁. Lingkaran 2: O₂(x₂, y₂), r₂.
   d = jarak kedua pusat.

   Garis singgung persekutuan  ν·X = c  (ν = vektor satuan normal) memenuhi
       ν·O₁ − c = s₁ r₁   dan   ν·O₂ − c = s₂ r₂,   s = ±1
   - luar  (s₁ = s₂):  ada bila d ≥ |r₁ − r₂|,  ℓ = √(d² − (r₁ − r₂)²)
   - dalam (s₁ = −s₂): ada bila d ≥ r₁ + r₂,    ℓ = √(d² − (r₁ + r₂)²)

   Mode "Proses": 4 langkah mencari ℓ lewat segitiga siku-siku bantu O₁PO₂.
   Garis dari O₂ sejajar T₁T₂ memotong O₁T₁ (atau perpanjangannya) di P.
   T₁T₂O₂P persegi panjang, jadi PO₂ = ℓ, T₁P = r₂, dan
   O₁P = |r₁ − r₂| (luar) atau r₁ + r₂ (dalam). */

/* ───────── Tipe ───────── */

type Vec = [number, number];
type Params = { x1: number; y1: number; r1: number; x2: number; y2: number; r2: number };
type Kind = "ext" | "int";
/** Garis singgung yang ditampilkan: semua, atau tepat satu. */
type Focus = "all" | "ext-0" | "ext-1" | "int-0" | "int-1";
type ObjectKey =
  | "c1"
  | "c2"
  | "ext"
  | "int"
  | "points"
  | "centerline"
  | "homothety"
  | "rad"
  | "rightAngle"
  | "lengths"
  | "extend"
  | "fill";
type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean;
  curveWidth: number;
  pointSize: number;
  focus: Focus;
  show: Record<ObjectKey, boolean>;
};
type Tangent = {
  /** +1 = singgung luar, −1 = singgung dalam */
  s: 1 | -1;
  nx: number;
  ny: number;
  c: number;
  t1: Vec;
  t2: Vec;
};

type Settable = { setAttribute: (attributes: Record<string, unknown>) => unknown };
type AxisElement = Settable & { defaultTicks: Settable };
type DragPoint = Settable & {
  X: () => number;
  Y: () => number;
  setPosition: (method: number, coords: number[]) => unknown;
  on: (event: string, handler: () => void) => unknown;
};
type DataCurve = Settable & {
  dataX: number[];
  dataY: number[];
  updateDataArray: () => void;
};
type Marker = { point: Settable; label: Settable; extra: number };
type Scene = {
  grid: Settable;
  axes: AxisElement[];
  circles: [Settable, Settable];
  centers: [DragPoint, DragPoint];
  /** Garis tebal (kurva utama). */
  main: Settable[];
  /** Garis tipis (bantu, perpanjangan, jari-jari). */
  thin: Settable[];
  markers: Marker[];
};

/* ───────── Konstanta ───────── */

/** JXG.COORDS_BY_USER */
const COORDS_BY_USER = 1;
const X_LIM = 10;
const Y_LIM = 7;
const R_MIN = 0.5;
const R_MAX = 6;
/** Toleransi (satuan jarak) untuk menganggap dua lingkaran bersinggungan. */
const EPS = 0.006;
/** Panjang perpanjangan garis singgung (cukup untuk zoom keluar jauh). */
const FAR = 1000;
const STEP_COUNT = 4;

const initialBox: BoundingBox = [-14, 10, 14, -10];
const initialParams: Params = { x1: -4, y1: -1, r1: 3, x2: 4, y2: 2, r2: 2 };
const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: true,
  curveWidth: 3,
  pointSize: 4,
  focus: "all",
  show: {
    c1: true,
    c2: true,
    ext: true,
    int: true,
    points: true,
    centerline: true,
    homothety: false,
    rad: false,
    rightAngle: true,
    lengths: true,
    extend: true,
    fill: true,
  },
};

const colors = {
  c1: "#00897b",
  c2: "#6557d2",
  ext: "#1565c0",
  int: "#c62828",
  help: "#c28a00",
  d: "#e65100",
  touch: "#232329",
  guide: "#8f8f99",
  grid: "#dcdce2",
  axis: "#4a4a55",
};

const sliderConfig = [
  { key: "x1", tex: "x_{1}", min: -X_LIM, max: X_LIM, step: 0.1, hint: "absis pusat O₁", accent: colors.c1 },
  { key: "y1", tex: "y_{1}", min: -Y_LIM, max: Y_LIM, step: 0.1, hint: "ordinat pusat O₁", accent: colors.c1 },
  { key: "r1", tex: "r_{1}", min: R_MIN, max: R_MAX, step: 0.1, hint: "jari-jari lingkaran 1", accent: colors.c1 },
  { key: "x2", tex: "x_{2}", min: -X_LIM, max: X_LIM, step: 0.1, hint: "absis pusat O₂", accent: colors.c2 },
  { key: "y2", tex: "y_{2}", min: -Y_LIM, max: Y_LIM, step: 0.1, hint: "ordinat pusat O₂", accent: colors.c2 },
  { key: "r2", tex: "r_{2}", min: R_MIN, max: R_MAX, step: 0.1, hint: "jari-jari lingkaran 2", accent: colors.c2 },
] as const;

const PRESETS: { label: string; params: Params }[] = [
  { label: "Terpisah", params: { x1: -4, y1: 0, r1: 3, x2: 3.5, y2: 0, r2: 2 } },
  { label: "Singgung luar", params: { x1: -3, y1: 0, r1: 3, x2: 2, y2: 0, r2: 2 } },
  { label: "Berpotongan", params: { x1: -2, y1: 0, r1: 3, x2: 2, y2: 0, r2: 2.5 } },
  { label: "Singgung dalam", params: { x1: -1, y1: 0, r1: 5, x2: 2, y2: 0, r2: 2 } },
];

const FOCUS_OPTIONS: { key: Focus; label: string }[] = [
  { key: "all", label: "Semua" },
  { key: "ext-0", label: "Luar 1" },
  { key: "ext-1", label: "Luar 2" },
  { key: "int-0", label: "Dalam 1" },
  { key: "int-1", label: "Dalam 2" },
];

const OPTION_CHIPS: { key: ObjectKey; label: string }[] = [
  { key: "rightAngle", label: "Siku-siku" },
  { key: "rad", label: "Jari-jari ke titik singgung" },
  { key: "lengths", label: "Panjang ℓ dan d" },
  { key: "extend", label: "Perpanjang garis" },
  { key: "fill", label: "Warnai lingkaran" },
  { key: "homothety", label: "Titik E dan I" },
];

const finite = (value: number) => Number.isFinite(value);

/* ───────── Matematika ───────── */

function analyze(p: Params) {
  const { x1, y1, r1, x2, y2, r2 } = p;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  const sum = r1 + r2;
  const diff = Math.abs(r1 - r2);

  let relation: string;
  if (d <= 1e-3) relation = r1 === r2 ? "Berimpit" : "Sepusat (konsentris)";
  else if (d > sum + EPS) relation = "Saling lepas";
  else if (Math.abs(d - sum) <= EPS) relation = "Bersinggungan luar";
  else if (d > diff + EPS) relation = "Berpotongan di dua titik";
  else if (Math.abs(d - diff) <= EPS) relation = "Bersinggungan dalam";
  else relation = "Satu di dalam yang lain";

  const ext: Tangent[] = [];
  const inn: Tangent[] = [];
  const ux = d > 1e-9 ? dx / d : 1;
  const uy = d > 1e-9 ? dy / d : 0;
  if (d > 1e-3) {
    const nx = -uy;
    const ny = ux;
    const build = (out: Tangent[], s2: 1 | -1, bound: number) => {
      const gap = d - bound;
      if (gap < -EPS) return;
      const k = clamp((s2 * r2 - r1) / d, -1, 1);
      // tepat bersinggung: kedua garis menyatu menjadi satu
      const h = gap <= EPS ? 0 : Math.sqrt(Math.max(0, 1 - k * k));
      const signs = h === 0 ? [1] : [1, -1];
      signs.forEach((sg) => {
        let vx = k * ux + sg * h * nx;
        let vy = k * uy + sg * h * ny;
        const len = Math.hypot(vx, vy) || 1;
        vx /= len;
        vy /= len;
        out.push({
          s: s2,
          nx: vx,
          ny: vy,
          c: vx * x1 + vy * y1 - r1,
          t1: [x1 - r1 * vx, y1 - r1 * vy],
          t2: [x2 - s2 * r2 * vx, y2 - s2 * r2 * vy],
        });
      });
    };
    build(ext, 1, diff);
    build(inn, -1, sum);
  }

  const nan: Vec = [Number.NaN, Number.NaN];
  // pusat homotetis: titik potong garis singgung luar (E) dan dalam (I)
  const E: Vec =
    ext.length > 0 && diff > 1e-6
      ? [(r2 * x1 - r1 * x2) / (r2 - r1), (r2 * y1 - r1 * y2) / (r2 - r1)]
      : nan;
  const I: Vec =
    inn.length > 0
      ? [(r2 * x1 + r1 * x2) / sum, (r2 * y1 + r1 * y2) / sum]
      : nan;

  return {
    d,
    sum,
    diff,
    relation,
    ext,
    inn,
    lenExt: Math.sqrt(Math.max(0, d * d - diff * diff)),
    lenInt: Math.sqrt(Math.max(0, d * d - sum * sum)),
    E,
    I,
  };
}

type Analysis = ReturnType<typeof analyze>;

/** Garis singgung yang dijelaskan: pilihan fokus, atau yang pertama ada. */
function resolveTarget(
  a: Analysis,
  focus: Focus,
): { kind: Kind; i: number; t: Tangent } | null {
  if (focus === "all") {
    if (a.ext[0]) return { kind: "ext", i: 0, t: a.ext[0] };
    if (a.inn[0]) return { kind: "int", i: 0, t: a.inn[0] };
    return null;
  }
  const [kind, idx] = focus.split("-") as [Kind, string];
  const t = (kind === "ext" ? a.ext : a.inn)[Number(idx)];
  return t ? { kind, i: Number(idx), t } : null;
}

/** Geometri segitiga bantu O₁PO₂: P = O₁ − (r₁ − s·r₂)·ν. */
function helperGeometry(p: Params, t: Tangent) {
  const k = p.r1 - t.s * p.r2;
  const P: Vec = [p.x1 - k * t.nx, p.y1 - k * t.ny];
  return { P, leg: Math.abs(k) };
}

/** Vektor satuan sepanjang garis singgung (dari T₁ ke T₂ bila tidak berimpit). */
function tangentDir(t: Tangent): Vec {
  const dx = t.t2[0] - t.t1[0];
  const dy = t.t2[1] - t.t1[1];
  const len = Math.hypot(dx, dy);
  return len > 1e-6 ? [dx / len, dy / len] : [-t.ny, t.nx];
}

/* ───────── Rumus TeX ───────── */

function sqTex(variable: string, h: number) {
  if (Math.abs(h) < 5e-3) return `${variable}^{2}`;
  return h > 0
    ? `(${variable}-${texNumber(h)})^{2}`
    : `(${variable}+${texNumber(-h)})^{2}`;
}

const circleTex = (x: number, y: number, r: number) =>
  `${sqTex("x", x)}+${sqTex("y", y)}=${texNumber(r * r)}`;

function lineTex(t: Tangent) {
  const terms: [number, string][] = [
    [t.nx, "x"],
    [t.ny, "y"],
  ];
  let out = "";
  terms.forEach(([coef, symbol]) => {
    if (Math.abs(coef) < 5e-3) return;
    const abs = Math.abs(coef);
    const body = Math.abs(abs - 1) < 5e-3 ? symbol : `${texNumber(abs)}${symbol}`;
    if (out === "") out = coef < 0 ? `-${body}` : body;
    else out += coef < 0 ? `-${body}` : `+${body}`;
  });
  return `${out || "0"}=${texNumber(t.c)}`;
}

const ptTex = (p: Vec) => String.raw`(${texNumber(p[0])},${texNumber(p[1])})`;

const samePoint = (a: Params, b: Params) =>
  (Object.keys(a) as (keyof Params)[]).every((key) => Math.abs(a[key] - b[key]) < 1e-9);

/* ───────── Komponen ───────── */

export function TwoCircleTangentSimulation() {
  const [storedParams, setParams] = useStoredSimulationState(
    "twocircle.params",
    initialParams,
  );
  const [storedView, setStoredView] = useStoredSimulationState(
    "twocircle.view",
    initialView,
  );
  const params = useMemo<Params>(
    () => ({ ...initialParams, ...storedParams }),
    [storedParams],
  );
  const view = useMemo<ViewState>(
    () => ({
      ...initialView,
      ...storedView,
      show: { ...initialView.show, ...storedView.show },
    }),
    [storedView],
  );
  // Langkah proses: 0 = tidak aktif, 1..STEP_COUNT
  const [step, setStep] = useState(0);

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const viewRef = useRef(view);
  viewRef.current = view;
  const stepRef = useRef(step);
  stepRef.current = step;
  const scene = useRef<Scene | null>(null);
  const cache = useRef<{ p: Params; a: Analysis } | null>(null);
  const labelRefs = useRef<{ dLabel: Settable } | null>(null);

  /** Analisis untuk parameter terkini (disimpan agar tidak dihitung berulang). */
  const getAnalysis = () => {
    const p = paramsRef.current;
    if (!cache.current || cache.current.p !== p) {
      cache.current = { p, a: analyze(p) };
    }
    return cache.current.a;
  };

  /** Garis singgung yang sedang digambar untuk satu slot, atau null. */
  const slotTangent = (kind: Kind, i: number): Tangent | null => {
    const a = getAnalysis();
    const t = (kind === "ext" ? a.ext : a.inn)[i];
    if (!t) return null;
    const v = viewRef.current;
    if (stepRef.current > 0) {
      const target = resolveTarget(a, v.focus);
      return target && target.kind === kind && target.i === i ? t : null;
    }
    if (!v.show[kind]) return null;
    if (v.focus !== "all" && v.focus !== `${kind}-${i}`) return null;
    return t;
  };

  /* ───────── Papan JSXGraph ───────── */

  const setup = (board: SimBoard) => {
    const p = () => paramsRef.current;
    const v = viewRef.current;
    const O1 = (): Vec => [p().x1, p().y1];
    const O2 = (): Vec => [p().x2, p().y2];

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
      {
        ...axisStyle,
        name: "x",
        label: { position: "rt", offset: [-14, 14], fontSize: 13 },
        ticks,
      },
    ) as unknown as AxisElement;
    const yAxis = board.create(
      "axis",
      [
        [0, 0],
        [0, 1],
      ],
      {
        ...axisStyle,
        name: "y",
        label: { position: "rt", offset: [12, -14], fontSize: 13 },
        ticks,
      },
    ) as unknown as AxisElement;

    const main: Settable[] = [];
    const thin: Settable[] = [];
    const markers: Marker[] = [];

    /* Pusat lingkaran: titik yang bisa diseret. */
    const makeCenter = (color: string, x: number, y: number) =>
      board.create("point", [x, y], {
        name: "",
        withLabel: false,
        size: v.pointSize + 3,
        fillColor: color,
        strokeColor: "#ffffff",
        strokeWidth: 1.5,
        fixed: false,
        highlight: true,
        showInfobox: false,
      }) as unknown as DragPoint;
    const center1 = makeCenter(colors.c1, p().x1, p().y1);
    const center2 = makeCenter(colors.c2, p().x2, p().y2);

    const makeCircle = (center: DragPoint, radius: () => number, color: string) =>
      board.create("circle", [center, radius], {
        strokeColor: color,
        strokeWidth: v.curveWidth,
        fillColor: color,
        fillOpacity: v.show.fill ? 0.08 : 0,
        highlightStrokeColor: color,
        highlightFillColor: color,
        highlightFillOpacity: v.show.fill ? 0.08 : 0,
        highlight: false,
        fixed: true,
        hasInnerPoints: false,
      }) as unknown as Settable;
    const circle1 = makeCircle(center1, () => p().r1, colors.c1);
    const circle2 = makeCircle(center2, () => p().r2, colors.c2);
    main.push(circle1, circle2);

    const labelStyle =
      "font-weight:600;white-space:nowrap;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;";

    /** Teks di posisi (px = satuan grafik) — kosong bila posisi tidak terhingga. */
    const textAt = (
      x: () => number,
      y: () => number,
      text: () => string,
      color: string,
      anchorX: "left" | "middle" = "left",
    ) =>
      board.create(
        "text",
        [
          () => (finite(x()) ? x() : 0),
          () => (finite(y()) ? y() : 0),
          () => (finite(x()) && finite(y()) ? text() : ""),
        ],
        {
          anchorX,
          anchorY: "middle",
          fontSize: 12,
          strokeColor: color,
          highlight: false,
          fixed: true,
          cssStyle: labelStyle,
        },
      ) as unknown as Settable;

    /** Titik tetap + label (nama dan/atau koordinat). */
    const marker = (
      x: () => number,
      y: () => number,
      color: string,
      extra: number,
      name = "",
    ) => {
      const point = board.create("point", [x, y], {
        name: "",
        withLabel: false,
        size: v.pointSize + extra,
        fillColor: color,
        strokeColor: "#ffffff",
        strokeWidth: 1.5,
        fixed: true,
        highlight: false,
        showInfobox: false,
      }) as unknown as Settable;
      const label = textAt(
        () => (finite(x()) ? x() + 8 / board.unitX : 0),
        () => (finite(y()) ? y() + 8 / board.unitY : 0),
        () =>
          `${name}${
            viewRef.current.pointLabels
              ? `(${formatText(x())}, ${formatText(y())})`
              : ""
          }`,
        color,
      );
      const item = { point, label, extra };
      markers.push(item);
      return item;
    };

    /** Garis lurus/tertutup lewat banyak titik; null = tidak digambar. */
    const polyline = (
      points: () => Vec[] | null,
      attrs: Record<string, unknown>,
    ) => {
      const curve = board.create("curve", [[], []], {
        highlight: false,
        fixed: true,
        ...attrs,
      }) as unknown as DataCurve;
      curve.updateDataArray = function updateDataArray() {
        const pts = points();
        if (!pts || pts.some((pt) => !finite(pt[0]) || !finite(pt[1]))) {
          curve.dataX = [Number.NaN];
          curve.dataY = [Number.NaN];
          return;
        }
        curve.dataX = pts.map((pt) => pt[0]);
        curve.dataY = pts.map((pt) => pt[1]);
      };
      return curve;
    };

    /** Tiga titik siku-siku di `corner` dengan arah a dan b (satuan). */
    const rightMark = (corner: Vec, a: Vec, b: Vec, size: number): Vec[] => [
      [corner[0] + size * a[0], corner[1] + size * a[1]],
      [corner[0] + size * (a[0] + b[0]), corner[1] + size * (a[1] + b[1])],
      [corner[0] + size * b[0], corner[1] + size * b[1]],
    ];

    const markSize = (limit: number) =>
      Math.min(14 / board.unitX, Math.max(0.05, limit));

    const showRad = () => viewRef.current.show.rad || stepRef.current >= 1;
    const showRight = () => viewRef.current.show.rightAngle || stepRef.current >= 1;

    /* ───────── Garis pusat ───────── */

    thin.push(
      polyline(
        () => (viewRef.current.show.centerline ? [O1(), O2()] : null),
        { strokeColor: colors.d, strokeWidth: 1.5, dash: 2 },
      ),
    );
    // Label d hanya tampil bila garis pusat dan panjang diaktifkan (applyView).
    const dLabel = textAt(
      () => (O1()[0] + O2()[0]) / 2,
      () => (O1()[1] + O2()[1]) / 2 + 14 / board.unitY,
      () => `d = ${formatText(getAnalysis().d)}`,
      colors.d,
      "middle",
    );

    /* ───────── Garis singgung: 2 luar + 2 dalam ───────── */

    const slots: { kind: Kind; i: number }[] = [
      { kind: "ext", i: 0 },
      { kind: "ext", i: 1 },
      { kind: "int", i: 0 },
      { kind: "int", i: 1 },
    ];
    slots.forEach(({ kind, i }) => {
      const col = kind === "ext" ? colors.ext : colors.int;
      const get = () => slotTangent(kind, i);

      // perpanjangan garis
      thin.push(
        polyline(
          () => {
            const t = get();
            if (!t || !viewRef.current.show.extend) return null;
            const dir = tangentDir(t);
            return [
              [t.t1[0] - dir[0] * FAR, t.t1[1] - dir[1] * FAR],
              [t.t2[0] + dir[0] * FAR, t.t2[1] + dir[1] * FAR],
            ];
          },
          { strokeColor: col, strokeOpacity: 0.45, strokeWidth: 1.5, dash: 2 },
        ),
      );

      // ruas singgung T₁T₂
      main.push(
        polyline(
          () => {
            const t = get();
            return t ? [t.t1, t.t2] : null;
          },
          { strokeColor: col },
        ),
      );

      // jari-jari ke titik singgung
      thin.push(
        polyline(
          () => {
            const t = get();
            return t && showRad() ? [O1(), t.t1] : null;
          },
          { strokeColor: colors.c1, strokeWidth: 1.5 },
        ),
        polyline(
          () => {
            const t = get();
            return t && showRad() ? [O2(), t.t2] : null;
          },
          { strokeColor: colors.c2, strokeWidth: 1.5 },
        ),
      );

      // tanda siku-siku di T₁ dan T₂
      const right = (which: 1 | 2) =>
        polyline(
          () => {
            const t = get();
            if (!t || !showRight()) return null;
            const dir = tangentDir(t);
            const m = markSize(0.4 * Math.min(p().r1, p().r2));
            if (which === 1) {
              return rightMark(t.t1, [t.nx, t.ny], dir, m);
            }
            return rightMark(
              t.t2,
              [t.s * t.nx, t.s * t.ny],
              [-dir[0], -dir[1]],
              m,
            );
          },
          { strokeColor: colors.touch, strokeWidth: 1.5 },
        );
      thin.push(right(1), right(2));

      // titik singgung
      marker(
        () => {
          const t = get();
          return t && viewRef.current.show.points ? t.t1[0] : Number.NaN;
        },
        () => {
          const t = get();
          return t && viewRef.current.show.points ? t.t1[1] : Number.NaN;
        },
        col,
        0,
      );
      marker(
        () => {
          const t = get();
          return t && viewRef.current.show.points ? t.t2[0] : Number.NaN;
        },
        () => {
          const t = get();
          return t && viewRef.current.show.points ? t.t2[1] : Number.NaN;
        },
        col,
        0,
      );

      // label panjang ℓ di tengah ruas
      textAt(
        () => {
          const t = get();
          return t && viewRef.current.show.lengths
            ? (t.t1[0] + t.t2[0]) / 2 - (t.nx * 16) / board.unitX
            : Number.NaN;
        },
        () => {
          const t = get();
          return t ? (t.t1[1] + t.t2[1]) / 2 - (t.ny * 16) / board.unitY : Number.NaN;
        },
        () => {
          const a = getAnalysis();
          return `ℓ = ${formatText(kind === "ext" ? a.lenExt : a.lenInt)}`;
        },
        col,
        "middle",
      );
    });

    /* ───────── Titik E dan I (pusat homotetis) ───────── */

    marker(
      () => (viewRef.current.show.homothety ? getAnalysis().E[0] : Number.NaN),
      () => (viewRef.current.show.homothety ? getAnalysis().E[1] : Number.NaN),
      colors.ext,
      1,
      "E",
    );
    marker(
      () => (viewRef.current.show.homothety ? getAnalysis().I[0] : Number.NaN),
      () => (viewRef.current.show.homothety ? getAnalysis().I[1] : Number.NaN),
      colors.int,
      1,
      "I",
    );

    /* ───────── Segitiga bantu O₁PO₂ (mode Proses) ───────── */

    const target = () => {
      const a = getAnalysis();
      return resolveTarget(a, viewRef.current.focus);
    };
    const helper = () => {
      const tg = target();
      return tg ? { t: tg.t, ...helperGeometry(p(), tg.t) } : null;
    };

    // persegi panjang T₁T₂O₂P
    thin.push(
      polyline(
        () => {
          const h = helper();
          return h && stepRef.current >= 2
            ? [h.t.t1, h.t.t2, O2(), h.P, h.t.t1]
            : null;
        },
        { strokeColor: colors.help, strokeWidth: 2, dash: 3 },
      ),
    );
    // segitiga siku-siku O₁PO₂
    main.push(
      polyline(
        () => {
          const h = helper();
          return h && stepRef.current >= 3 ? [O1(), h.P, O2(), O1()] : null;
        },
        {
          strokeColor: colors.help,
          strokeWidth: 2,
          fillColor: colors.help,
          fillOpacity: 0.16,
        },
      ),
    );
    // siku-siku di P
    thin.push(
      polyline(
        () => {
          const h = helper();
          if (!h || stepRef.current < 3 || h.leg < 1e-6) return null;
          const a = getAnalysis();
          const toO1: Vec = [(O1()[0] - h.P[0]) / h.leg, (O1()[1] - h.P[1]) / h.leg];
          const len = Math.hypot(O2()[0] - h.P[0], O2()[1] - h.P[1]);
          if (len < 1e-6) return null;
          const toO2: Vec = [(O2()[0] - h.P[0]) / len, (O2()[1] - h.P[1]) / len];
          return rightMark(h.P, toO1, toO2, markSize(0.4 * Math.min(h.leg, len, a.d)));
        },
        { strokeColor: colors.touch, strokeWidth: 1.5 },
      ),
    );
    marker(
      () => {
        const h = helper();
        return h && stepRef.current >= 2 ? h.P[0] : Number.NaN;
      },
      () => {
        const h = helper();
        return h && stepRef.current >= 2 ? h.P[1] : Number.NaN;
      },
      colors.help,
      1,
      "P",
    );

    // panjang sisi segitiga (langkah 3 ke atas)
    const sideLabel = (
      from: () => Vec | null,
      to: () => Vec | null,
      text: () => string,
    ) =>
      textAt(
        () => {
          const a = from();
          const b = to();
          if (!a || !b || stepRef.current < 3) return Number.NaN;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 1e-6) return Number.NaN;
          return (a[0] + b[0]) / 2 + ((-(b[1] - a[1]) / len) * 14) / board.unitX;
        },
        () => {
          const a = from();
          const b = to();
          if (!a || !b || stepRef.current < 3) return Number.NaN;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 1e-6) return Number.NaN;
          return (a[1] + b[1]) / 2 + (((b[0] - a[0]) / len) * 14) / board.unitY;
        },
        text,
        colors.help,
        "middle",
      );
    sideLabel(
      () => O1(),
      () => helper()?.P ?? null,
      () => `O₁P = ${formatText(helper()?.leg ?? Number.NaN)}`,
    );
    sideLabel(
      () => helper()?.P ?? null,
      () => O2(),
      () => {
        const tg = target();
        const a = getAnalysis();
        const len = tg ? (tg.kind === "ext" ? a.lenExt : a.lenInt) : Number.NaN;
        return `PO₂ = ℓ = ${formatText(len)}`;
      },
    );

    /* ───────── Label pusat dan interaksi seret ───────── */

    textAt(
      () => center1.X() + 10 / board.unitX,
      () => center1.Y() - 14 / board.unitY,
      () =>
        `O₁${
          viewRef.current.pointLabels
            ? `(${formatText(center1.X())}, ${formatText(center1.Y())})`
            : ""
        }`,
      colors.c1,
    );
    textAt(
      () => center2.X() + 10 / board.unitX,
      () => center2.Y() - 14 / board.unitY,
      () =>
        `O₂${
          viewRef.current.pointLabels
            ? `(${formatText(center2.X())}, ${formatText(center2.Y())})`
            : ""
        }`,
      colors.c2,
    );

    const commitCenter = (which: 1 | 2) => () => {
      const point = which === 1 ? center1 : center2;
      const x = clamp(snap(point.X(), 0.1), -X_LIM, X_LIM);
      const y = clamp(snap(point.Y(), 0.1), -Y_LIM, Y_LIM);
      point.setPosition(COORDS_BY_USER, [x, y]);
      const next: Params = {
        ...paramsRef.current,
        [which === 1 ? "x1" : "x2"]: x,
        [which === 1 ? "y1" : "y2"]: y,
      };
      if (samePoint(next, paramsRef.current)) return;
      paramsRef.current = next;
      setParams(next);
      board.update();
    };
    center1.on("drag", commitCenter(1));
    center2.on("drag", commitCenter(2));

    scene.current = {
      grid,
      axes: [xAxis, yAxis],
      circles: [circle1, circle2],
      centers: [center1, center2],
      main,
      thin,
      markers,
    };
    labelRefs.current = { dLabel };
    applyView();
  };

  const { boardProps, boardRef, zoomIn, zoomOut, resetView } = useJsxBoard({
    boundingBox: initialBox,
    setup,
  });

  /** Menerapkan toggle, ketebalan garis, dan ukuran titik ke papan. */
  function applyView() {
    const s = scene.current;
    if (!s) return;
    const v = viewRef.current;

    s.grid.setAttribute({ visible: v.grid });
    s.axes.forEach((axis) =>
      axis.defaultTicks.setAttribute({
        visible: v.axisNumbers,
        drawLabels: v.axisNumbers,
      }),
    );

    const thinWidth = Math.max(1, v.curveWidth / 2);
    s.main.forEach((el) => el.setAttribute({ strokeWidth: v.curveWidth }));
    s.thin.forEach((el) => el.setAttribute({ strokeWidth: thinWidth }));

    const fillOpacity = v.show.fill ? 0.08 : 0;
    s.circles[0].setAttribute({
      visible: v.show.c1,
      fillOpacity,
      highlightFillOpacity: fillOpacity,
      strokeWidth: v.curveWidth,
    });
    s.circles[1].setAttribute({
      visible: v.show.c2,
      fillOpacity,
      highlightFillOpacity: fillOpacity,
      strokeWidth: v.curveWidth,
    });
    s.centers.forEach((c) => c.setAttribute({ size: v.pointSize + 3 }));
    s.markers.forEach((m) => m.point.setAttribute({ size: v.pointSize + m.extra }));
    labelRefs.current?.dLabel.setAttribute({
      visible: v.show.centerline && v.show.lengths,
    });

    boardRef.current?.update();
  }

  useEffect(() => {
    applyView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, step]);

  // Parameter berubah dari slider/preset: pindahkan titik pusat yang diseret.
  useEffect(() => {
    const s = scene.current;
    if (s) {
      const moves: [DragPoint, number, number][] = [
        [s.centers[0], params.x1, params.y1],
        [s.centers[1], params.x2, params.y2],
      ];
      moves.forEach(([point, x, y]) => {
        if (Math.abs(point.X() - x) > 1e-9 || Math.abs(point.Y() - y) > 1e-9) {
          point.setPosition(COORDS_BY_USER, [x, y]);
        }
      });
    }
    boardRef.current?.update();
  }, [params, boardRef]);

  /* ───────── Perubahan dari pengguna ───────── */

  const commitParams = (next: Params) => {
    paramsRef.current = next;
    setParams(next);
    boardRef.current?.update();
  };

  const updateParam = (key: keyof Params, value: number) =>
    commitParams({ ...paramsRef.current, [key]: value });

  const resetParams = () => {
    commitParams(initialParams);
    setStep(0);
  };

  const updateView = (patch: Partial<ViewState>) => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setStoredView(next);
  };

  const toggleShow = (key: ObjectKey) =>
    updateView({ show: { ...viewRef.current.show, [key]: !viewRef.current.show[key] } });

  /* ───────── Nilai turunan ───────── */

  const an = useMemo(() => analyze(params), [params]);
  const target = resolveTarget(an, view.focus);
  const helper = target ? helperGeometry(params, target.t) : null;
  const targetLen = target ? (target.kind === "ext" ? an.lenExt : an.lenInt) : 0;
  const targetName = target
    ? `${target.kind === "ext" ? "luar" : "dalam"} ${target.i + 1}`
    : "";
  const legTex = target?.kind === "ext" ? String.raw`|r_{1}-r_{2}|` : "r_{1}+r_{2}";

  const stepBodies: { title: string; body: ReactNode }[] = [
    {
      title: "Jari-jari ke titik singgung",
      body: (
        <>
          Hubungkan pusat dengan titik singgung. Jari-jari tegak lurus garis
          singgung, jadi <SimMath tex={String.raw`O_{1}T_{1}\perp \ell`} /> dan{" "}
          <SimMath tex={String.raw`O_{2}T_{2}\perp \ell`} />, dengan{" "}
          <SimMath tex={`O_{1}T_{1}=r_{1}=${texNumber(params.r1)}`} /> dan{" "}
          <SimMath tex={`O_{2}T_{2}=r_{2}=${texNumber(params.r2)}`} />.
        </>
      ),
    },
    {
      title: "Garis bantu dari O₂",
      body: (
        <>
          Tarik garis dari <SimMath tex="O_{2}" /> sejajar{" "}
          <SimMath tex="T_{1}T_{2}" /> hingga memotong{" "}
          <SimMath tex="O_{1}T_{1}" /> (atau perpanjangannya) di{" "}
          <SimMath tex="P" />. Maka <SimMath tex="T_{1}T_{2}O_{2}P" /> persegi
          panjang: <SimMath tex={`PO_{2}=\\ell`} /> dan{" "}
          <SimMath tex={`T_{1}P=r_{2}=${texNumber(params.r2)}`} />.
        </>
      ),
    },
    {
      title: "Segitiga siku-siku O₁PO₂",
      body: (
        <>
          Segitiga <SimMath tex="O_{1}PO_{2}" /> siku-siku di <SimMath tex="P" />
          . Sisi <SimMath tex="O_{1}P" /> adalah{" "}
          {target?.kind === "ext" ? "selisih" : "jumlah"} jari-jari:{" "}
          <SimMath
            tex={`O_{1}P=${legTex}=${texNumber(helper?.leg ?? Number.NaN)}`}
          />
          , sedangkan sisi miringnya <SimMath tex={`O_{1}O_{2}=d=${texNumber(an.d)}`} />.
        </>
      ),
    },
    {
      title: "Teorema Pythagoras",
      body: (
        <>
          <SimMath
            tex={String.raw`d^{2}=(O_{1}P)^{2}+\ell^{2}\;\Rightarrow\;\ell=\sqrt{d^{2}-(${legTex})^{2}}`}
          />
          . Hasilnya{" "}
          <SimMath
            tex={`\\ell=\\sqrt{${texNumber(an.d)}^{2}-${texNumber(helper?.leg ?? Number.NaN)}^{2}}=${texNumber(targetLen)}`}
          />
          .
        </>
      ),
    },
  ];

  const goStep = (next: number) => setStep(clamp(next, 0, STEP_COUNT));

  /* ───────── Tampilan ───────── */

  return (
    <SimulationShell
      title="Simulasi dua lingkaran dan garis singgung persekutuan"
      onReset={resetParams}
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
        <>
          <SimSection title="Tampilkan di grafik">
            <div className="sim-chips" role="group" aria-label="Tampilkan di grafik">
              {OPTION_CHIPS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  className="sim-chip"
                  aria-pressed={view.show[key]}
                  onClick={() => toggleShow(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </SimSection>
          <SimSection title="Garis dan titik">
            <SimSlider
              id="twocircle-curve-width"
              name="tebal garis"
              label={`Tebal garis: ${view.curveWidth}`}
              value={view.curveWidth}
              min={1}
              max={8}
              step={1}
              onChange={(curveWidth) => updateView({ curveWidth })}
            />
            <SimSlider
              id="twocircle-point-size"
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
              onClick={() =>
                updateView({
                  grid: initialView.grid,
                  axisNumbers: initialView.axisNumbers,
                  pointLabels: initialView.pointLabels,
                  curveWidth: initialView.curveWidth,
                  pointSize: initialView.pointSize,
                  show: initialView.show,
                })
              }
            >
              Atur ulang tampilan
            </button>
          </SimSection>
        </>
      }
      graph={
        <div
          {...boardProps}
          role="img"
          aria-label="Grafik dua lingkaran dan garis singgung persekutuannya. Seret titik pusat untuk memindahkan lingkaran, seret latar untuk menggeser, cubit atau gulir untuk memperbesar."
        />
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          <SimMath tex={`d=${texNumber(an.d)}`} />
          <span className="sim-overlay__sub">{an.relation}</span>
        </p>
      }
      panel={
        <>
          <SimSection title="Parameter" sticky>
            {sliderConfig.map(({ key, tex, min, max, step: stepSize, hint, accent }) => (
              <SimSlider
                key={key}
                id={`twocircle-${key}`}
                name={key}
                label={<SimMath tex={`${tex}=${texNumber(params[key])}`} />}
                hint={hint}
                accent={accent}
                value={params[key]}
                min={min}
                max={max}
                step={stepSize}
                valueText={`${key} sama dengan ${params[key]}`}
                onChange={(value) => updateParam(key, value)}
              />
            ))}
          </SimSection>

          <SimSection title="Contoh posisi">
            <div className="sim-seg" role="radiogroup" aria-label="Contoh posisi dua lingkaran">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  role="radio"
                  className="sim-seg__btn"
                  aria-checked={samePoint(params, preset.params)}
                  onClick={() => commitParams(preset.params)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </SimSection>

          <SimSection title="Garis yang ditampilkan">
            <div className="sim-seg" role="radiogroup" aria-label="Garis singgung yang ditampilkan">
              {FOCUS_OPTIONS.map(({ key, label }) => {
                const [kind, idx] = key === "all" ? [null, 0] : (key.split("-") as [Kind, string]);
                const exists =
                  kind === null ||
                  Boolean((kind === "ext" ? an.ext : an.inn)[Number(idx)]);
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    className="sim-seg__btn"
                    aria-checked={view.focus === key}
                    disabled={!exists}
                    onClick={() => updateView({ focus: key })}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </SimSection>

          <SimSection title="Hasil">
            <ul className="sim-rows" aria-live="polite">
              <SimRow>
                <span>
                  <strong>{an.relation}</strong>
                </span>
              </SimRow>
              <SimRow>
                <SimMath
                  tex={`d=${texNumber(an.d)},\\ r_{1}+r_{2}=${texNumber(an.sum)},\\ |r_{1}-r_{2}|=${texNumber(an.diff)}`}
                />
              </SimRow>
              <SimRow
                color={colors.c1}
                visible={view.show.c1}
                onToggle={() => toggleShow("c1")}
                toggleLabel="Tampilkan atau sembunyikan lingkaran 1"
              >
                <SimMath tex={circleTex(params.x1, params.y1, params.r1)} />
              </SimRow>
              <SimRow
                color={colors.c2}
                visible={view.show.c2}
                onToggle={() => toggleShow("c2")}
                toggleLabel="Tampilkan atau sembunyikan lingkaran 2"
              >
                <SimMath tex={circleTex(params.x2, params.y2, params.r2)} />
              </SimRow>
              <SimRow
                color={colors.d}
                visible={view.show.centerline}
                onToggle={() => toggleShow("centerline")}
                toggleLabel="Tampilkan atau sembunyikan garis pusat"
              >
                <SimMath tex={`O_{1}O_{2}=d=${texNumber(an.d)}`} />
              </SimRow>
              <SimRow
                color={colors.ext}
                visible={view.show.ext}
                onToggle={() => toggleShow("ext")}
                toggleLabel="Tampilkan atau sembunyikan garis singgung luar"
              >
                {an.ext.length > 0 ? (
                  <span>
                    Singgung luar: {an.ext.length} garis,{" "}
                    <SimMath
                      tex={`\\ell=\\sqrt{d^{2}-(r_{1}-r_{2})^{2}}=${texNumber(an.lenExt)}`}
                    />
                  </span>
                ) : (
                  <span>
                    Singgung luar: tidak ada (<SimMath tex={String.raw`d<|r_{1}-r_{2}|`} />)
                  </span>
                )}
              </SimRow>
              {an.ext.map((t, i) => (
                <SimRow key={`ext-${i}`}>
                  <SimMath
                    tex={String.raw`\text{L}_{${i + 1}}:\ ${lineTex(t)},\ T_{1}${ptTex(t.t1)},\ T_{2}${ptTex(t.t2)}`}
                  />
                </SimRow>
              ))}
              <SimRow
                color={colors.int}
                visible={view.show.int}
                onToggle={() => toggleShow("int")}
                toggleLabel="Tampilkan atau sembunyikan garis singgung dalam"
              >
                {an.inn.length > 0 ? (
                  <span>
                    Singgung dalam: {an.inn.length} garis,{" "}
                    <SimMath
                      tex={`\\ell=\\sqrt{d^{2}-(r_{1}+r_{2})^{2}}=${texNumber(an.lenInt)}`}
                    />
                  </span>
                ) : (
                  <span>
                    Singgung dalam: tidak ada (<SimMath tex="d<r_{1}+r_{2}" />)
                  </span>
                )}
              </SimRow>
              {an.inn.map((t, i) => (
                <SimRow key={`int-${i}`}>
                  <SimMath
                    tex={String.raw`\text{D}_{${i + 1}}:\ ${lineTex(t)},\ T_{1}${ptTex(t.t1)},\ T_{2}${ptTex(t.t2)}`}
                  />
                </SimRow>
              ))}
              <SimRow
                color={colors.touch}
                visible={view.show.points}
                onToggle={() => toggleShow("points")}
                toggleLabel="Tampilkan atau sembunyikan titik singgung"
              >
                <span>Titik singgung pada lingkaran</span>
              </SimRow>
              {Number.isFinite(an.E[0]) && (
                <SimRow
                  color={colors.ext}
                  visible={view.show.homothety}
                  onToggle={() => toggleShow("homothety")}
                  toggleLabel="Tampilkan atau sembunyikan titik E dan I"
                >
                  <SimMath tex={`E${ptTex(an.E)}`} />
                </SimRow>
              )}
              {Number.isFinite(an.I[0]) && (
                <SimRow
                  color={colors.int}
                  visible={view.show.homothety}
                  onToggle={() => toggleShow("homothety")}
                  toggleLabel="Tampilkan atau sembunyikan titik E dan I"
                >
                  <SimMath tex={`I${ptTex(an.I)}`} />
                </SimRow>
              )}
            </ul>
          </SimSection>

          <SimSection title="Proses mencari ℓ">
            {step === 0 ? (
              <>
                <p className="sim-hint">
                  Cari panjang ruas singgung <SimMath tex="\ell" /> lewat segitiga
                  siku-siku bantu <SimMath tex="O_{1}PO_{2}" /> dalam {STEP_COUNT}{" "}
                  langkah.{target ? ` Garis yang dijelaskan: singgung ${targetName}.` : ""}
                </p>
                <button
                  type="button"
                  className="sim-text-btn"
                  disabled={!target}
                  onClick={() => goStep(1)}
                >
                  Mulai proses
                </button>
                {!target && (
                  <p className="sim-hint" role="status">
                    Tidak ada garis singgung pada posisi ini. Jauhkan kedua
                    lingkaran atau pilih garis lain.
                  </p>
                )}
              </>
            ) : target ? (
              <>
                <div className="sim-seg" role="radiogroup" aria-label="Langkah proses">
                  {stepBodies.map((s, i) => (
                    <button
                      key={s.title}
                      type="button"
                      role="radio"
                      className="sim-seg__btn"
                      aria-checked={step === i + 1}
                      onClick={() => goStep(i + 1)}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
                <div className="sim-callout" aria-live="polite">
                  <strong>
                    {step}. {stepBodies[step - 1].title}
                  </strong>
                  <br />
                  {stepBodies[step - 1].body}
                </div>
                <div className="sim-seg" style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="sim-seg__btn"
                    disabled={step <= 1}
                    onClick={() => goStep(step - 1)}
                  >
                    Kembali
                  </button>
                  <button
                    type="button"
                    className="sim-seg__btn"
                    disabled={step >= STEP_COUNT}
                    onClick={() => goStep(step + 1)}
                  >
                    Lanjut
                  </button>
                  <button type="button" className="sim-seg__btn" onClick={() => setStep(0)}>
                    Selesai
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="sim-hint" role="status">
                  Garis singgung yang dipilih tidak ada pada posisi ini. Ubah
                  posisi lingkaran atau pilih garis lain.
                </p>
                <button type="button" className="sim-text-btn" onClick={() => setStep(0)}>
                  Tutup proses
                </button>
              </>
            )}
          </SimSection>
        </>
      }
      notes={
        <>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.ext }}>Singgung luar</strong>
            {": ada dua garis bila "}
            <SimMath tex="d>|r_{1}-r_{2}|" />
            {" dengan panjang ruas "}
            <SimMath tex={String.raw`\ell=\sqrt{d^{2}-(r_{1}-r_{2})^{2}}`} />
            {". Bila "}
            <SimMath tex="r_{1}=r_{2}" />
            {", kedua garis sejajar dengan garis pusat."}
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.int }}>Singgung dalam</strong>
            {": ada dua garis bila "}
            <SimMath tex="d>r_{1}+r_{2}" />
            {" (kedua lingkaran saling lepas) dengan "}
            <SimMath tex={String.raw`\ell=\sqrt{d^{2}-(r_{1}+r_{2})^{2}}`} />
            {". Garis ini memotong garis pusat di antara kedua lingkaran."}
          </p>
          <p style={{ margin: 0 }}>
            <strong>Banyak garis singgung persekutuan</strong>
            {": saling lepas 4, bersinggungan luar 3, berpotongan 2, bersinggungan dalam 1, satu di dalam yang lain 0. Saat ini: "}
            {an.ext.length + an.inn.length}
            {" garis."}
          </p>
        </>
      }
    />
  );
}

export default TwoCircleTangentSimulation;
