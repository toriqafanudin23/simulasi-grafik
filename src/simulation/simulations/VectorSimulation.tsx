import JXG from "jsxgraph";
import { useEffect, useMemo, useRef } from "react";
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
import { clamp, formatText, texNumber } from "../common/utils/simUtils";
import { useJsxBoard, type BoundingBox, type SimBoard } from "../common/hooks/useJsxBoard";
import { useStoredSimulationState } from "../common/hooks/useStoredSimulationState";

/* Simulasi vektor: penjumlahan, selisih, perkalian titik, sudut, dan proyeksi
   dua vektor a dan b di bidang. Kerangka, slider, dan CSS memakai kit umum
   (prefix sim-); tidak ada CSS khusus. */

/* ───────── Tipe ───────── */

type Vec = [number, number];
type Projection = "a" | "b"; // "a" = proyeksi a pada b, "b" = proyeksi b pada a
type CompKey = "a1" | "a2" | "b1" | "b2";
type ObjectKey = "a" | "b" | "sum" | "projection" | "angle";

type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean; // tulis koordinat di samping nama vektor
  snap: boolean; // tempel ujung vektor ke bilangan bulat
  curveWidth: number;
  pointSize: number;
  show: Record<ObjectKey, boolean>;
};

/* ───────── Konstanta ───────── */

const EPS = 1e-9;
const LIMIT = 9;
const ARC_STEPS = 48;
const initialBox: BoundingBox = [-10, 10, 10, -10];

const defaultA: Vec = [5, 1];
const defaultB: Vec = [2, 4];

const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: true,
  snap: true,
  curveWidth: 3,
  pointSize: 4,
  show: { a: true, b: true, sum: true, projection: true, angle: true },
};

const colors = {
  a: "#1565c0",
  b: "#e65100",
  sum: "#2e7d32",
  proj: "#6557d2",
  angle: "#c62828",
  grid: "#dcdce2",
  axis: "#4a4a55",
};

const sliderConfig: { key: CompKey; vec: "a" | "b"; i: 0 | 1; tex: string; hint: string }[] = [
  { key: "a1", vec: "a", i: 0, tex: "a_{1}", hint: "komponen x vektor a" },
  { key: "a2", vec: "a", i: 1, tex: "a_{2}", hint: "komponen y vektor a" },
  { key: "b1", vec: "b", i: 0, tex: "b_{1}", hint: "komponen x vektor b" },
  { key: "b2", vec: "b", i: 1, tex: "b_{2}", hint: "komponen y vektor b" },
];

const presets: { label: string; a: Vec; b: Vec }[] = [
  { label: "Lancip", a: [5, 1], b: [2, 4] },
  { label: "Tegak lurus", a: [4, 2], b: [-2, 4] },
  { label: "Tumpul", a: [4, 1], b: [-4, 3] },
  { label: "Searah", a: [4, 2], b: [2, 1] },
  { label: "Berlawanan", a: [4, 2], b: [-2, -1] },
];

const projectionOptions: { mode: Projection; label: string }[] = [
  { mode: "a", label: "a pada b" },
  { mode: "b", label: "b pada a" },
];

/* ───────── Matematika ───────── */

const toDegrees = (rad: number) => (rad * 180) / Math.PI;
const len = ([x, y]: Vec) => Math.hypot(x, y);
const dotOf = (u: Vec, v: Vec) => u[0] * v[0] + u[1] * v[1];
const clampLimit = (value: number) => clamp(value, -LIMIT, LIMIT);
const sameVec = (u: Vec, v: Vec) => u[0] === v[0] && u[1] === v[1];

function clean(value: number) {
  const r = Math.round(value * 1000) / 1000;
  return Math.abs(r) < 1e-9 ? 0 : r;
}

function sanitize(value: unknown, fallback: Vec): Vec {
  return Array.isArray(value) && Number.isFinite(value[0]) && Number.isFinite(value[1])
    ? [value[0], value[1]]
    : fallback;
}

/** Proyeksi `vec` pada `onto`; null bila `onto` vektor nol. */
function projectOnto(vec: Vec, onto: Vec) {
  const lo = len(onto);
  if (lo < EPS) return null;
  const dot = dotOf(vec, onto);
  const k = dot / (lo * lo);
  return { scalar: dot / lo, vector: [k * onto[0], k * onto[1]] as Vec, k };
}

function analyze(a: Vec, b: Vec) {
  const la = len(a);
  const lb = len(b);
  const dot = dotOf(a, b);
  const defined = la > EPS && lb > EPS;
  const cos = defined ? clamp(dot / (la * lb), -1, 1) : Number.NaN;
  return {
    la,
    lb,
    dot,
    defined,
    cos,
    angle: defined ? toDegrees(Math.acos(cos)) : Number.NaN,
    sum: [a[0] + b[0], a[1] + b[1]] as Vec,
    diff: [a[0] - b[0], a[1] - b[1]] as Vec,
    aOnB: projectOnto(a, b),
    bOnA: projectOnto(b, a),
  };
}

function relationText(info: ReturnType<typeof analyze>) {
  if (!info.defined) return "Salah satu vektor adalah vektor nol, sudutnya tidak terdefinisi.";
  if (Math.abs(info.dot) < 1e-9) return "a · b = 0: kedua vektor saling tegak lurus.";
  if (info.cos > 1 - 1e-9) return "a · b > 0 dan θ = 0°: kedua vektor searah.";
  if (info.cos < -1 + 1e-9) return "a · b < 0 dan θ = 180°: kedua vektor berlawanan arah.";
  return info.dot > 0
    ? "a · b > 0: sudut θ di antara kedua vektor lancip."
    : "a · b < 0: sudut θ di antara kedua vektor tumpul.";
}

/* ───────── Format ───────── */

const coordText = ([x, y]: Vec) => `(${formatText(x)}, ${formatText(y)})`;
const vecTex = ([x, y]: Vec) => String.raw`(${texNumber(x)},${texNumber(y)})`;
const paren = (value: number) =>
  value < 0 ? `(${texNumber(value)})` : texNumber(value);
const undefinedTex = String.raw`\text{tak terdefinisi}`;

/* ───────── Tipe elemen JSXGraph ───────── */

type Settable = { setAttribute: (attributes: Record<string, unknown>) => unknown };
type Evented = { on: (event: string, handler: () => void) => unknown };
type AxisElement = Settable & { defaultTicks: Settable };
type PointEl = Settable &
  Evented & {
    X: () => number;
    Y: () => number;
    setPosition: (method: number, coords: number[]) => unknown;
  };
type DataCurve = Settable & {
  dataX: number[];
  dataY: number[];
  updateDataArray: () => void;
};
type Scene = {
  grid: Settable;
  axes: AxisElement[];
  pa: PointEl;
  pb: PointEl;
  arrowA: Settable;
  arrowB: Settable;
  labelA: Settable;
  labelB: Settable;
  sumShape: Settable;
  sumArrow: Settable;
  sumLabel: Settable;
  projLine: Settable;
  projPerp: Settable;
  projRight: Settable;
  projFoot: Settable;
  angleArc: Settable;
  angleLabel: Settable;
};

const isFiniteVec = (p: Vec) => Number.isFinite(p[0]) && Number.isFinite(p[1]);

/* ───────── Komponen utama ───────── */

export function VectorSimulation() {
  const [storedA, setA] = useStoredSimulationState<Vec>("vector.a", defaultA);
  const [storedB, setB] = useStoredSimulationState<Vec>("vector.b", defaultB);
  const [storedProjection, setProjection] = useStoredSimulationState<string>(
    "vector.projection",
    "a",
  );
  const [storedView, setStoredView] = useStoredSimulationState("vector.view", initialView);

  const a = useMemo(() => sanitize(storedA, defaultA), [storedA]);
  const b = useMemo(() => sanitize(storedB, defaultB), [storedB]);
  const projection: Projection = storedProjection === "b" ? "b" : "a";
  const view = useMemo<ViewState>(
    () => ({
      ...initialView,
      ...storedView,
      show: { ...initialView.show, ...storedView.show },
    }),
    [storedView],
  );

  const vecRef = useRef<{ a: Vec; b: Vec }>({ a, b });
  vecRef.current = { a, b };
  const viewRef = useRef(view);
  viewRef.current = view;
  const projRef = useRef(projection);
  projRef.current = projection;
  const scene = useRef<Scene | null>(null);

  /* ───────── Papan JSXGraph ───────── */

  const setup = (board: SimBoard) => {
    const v = viewRef.current;
    const thin = Math.max(1, v.curveWidth / 2);
    const start = vecRef.current;

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

    /* Ujung vektor a dan b (dapat digeser) */
    const makePoint = (at: Vec, fill: string) =>
      board.create("point", [at[0], at[1]], {
        name: "",
        withLabel: false,
        size: v.pointSize + 1,
        fillColor: fill,
        strokeColor: "#ffffff",
        strokeWidth: 2,
        snapToGrid: v.snap,
        snapSizeX: 1,
        snapSizeY: 1,
        highlight: false,
        showInfobox: false,
      }) as unknown as PointEl;
    const pa = makePoint(start.a, colors.a);
    const pb = makePoint(start.b, colors.b);
    const A = (): Vec => [pa.X(), pa.Y()];
    const B = (): Vec => [pb.X(), pb.Y()];
    const sumPoint = (): Vec => [pa.X() + pb.X(), pa.Y() + pb.Y()];

    /* Kurva dari daftar titik; titik tak berhingga / null = disembunyikan */
    const dataCurve = (
      build: () => Vec[] | null,
      stroke: string,
      width: number,
      dash: number,
    ) => {
      const curve = board.create("curve", [[0], [0]], {
        strokeColor: stroke,
        strokeWidth: width,
        dash,
        highlight: false,
        fixed: true,
      }) as unknown as DataCurve;
      curve.updateDataArray = () => {
        const pts = build();
        if (!pts || pts.length === 0 || !pts.every(isFiniteVec)) {
          curve.dataX = [Number.NaN];
          curve.dataY = [Number.NaN];
          return;
        }
        curve.dataX = pts.map((p) => p[0]);
        curve.dataY = pts.map((p) => p[1]);
      };
      return curve as Settable;
    };

    /* Anak panah dari titik asal; ujung 1000 = disembunyikan di luar papan */
    const arrow = (x: () => number, y: () => number, stroke: string, width: number) =>
      board.create(
        "segment",
        [
          [0, 0],
          [x, y],
        ],
        {
          strokeColor: stroke,
          strokeWidth: width,
          lastArrow: { type: 2, size: 4 },
          highlight: false,
          fixed: true,
          point1: { visible: false },
          point2: { visible: false },
        },
      ) as unknown as Settable;

    /* Label nama (+ koordinat) */
    const label = (pos: () => Vec, text: () => string, color: string, dx: number, dy: number) =>
      board.create(
        "text",
        [
          () => {
            const p = pos();
            return Number.isFinite(p[0]) ? p[0] + dx / board.unitX : 0;
          },
          () => {
            const p = pos();
            return Number.isFinite(p[1]) ? p[1] + dy / board.unitY : 0;
          },
          () => (isFiniteVec(pos()) ? text() : ""),
        ],
        {
          anchorX: "left",
          anchorY: "bottom",
          fontSize: 12,
          strokeColor: color,
          highlight: false,
          fixed: true,
          cssStyle:
            "font-weight:600;white-space:nowrap;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;",
        },
      ) as unknown as Settable;

    /* Penjumlahan: jajar genjang dan vektor a + b */
    const sumShape = dataCurve(() => [A(), sumPoint(), B()], colors.sum, thin, 3);
    const sumEnd = (i: 0 | 1) => () => (len(sumPoint()) > 1e-6 ? sumPoint()[i] : 1000);
    const sumArrow = arrow(sumEnd(0), sumEnd(1), colors.sum, v.curveWidth);
    const sumLabel = label(
      sumPoint,
      () => `a + b${viewRef.current.pointLabels ? coordText(sumPoint()) : ""}`,
      colors.sum,
      8,
      6,
    );

    /* Proyeksi */
    const projInfo = () => {
      const mode = projRef.current;
      const vec = mode === "a" ? A() : B();
      const onto = mode === "a" ? B() : A();
      const res = projectOnto(vec, onto);
      return res ? { vec, onto, foot: res.vector, k: res.k } : null;
    };

    // garis tempat proyeksi jatuh
    const projLine = dataCurve(
      () => {
        const info = projInfo();
        if (!info) return null;
        const lo = len(info.onto);
        const u: Vec = [info.onto[0] / lo, info.onto[1] / lo];
        const reach = 2 * Math.max(...board.getBoundingBox().map((n) => Math.abs(n))) + 10;
        return [
          [-reach * u[0], -reach * u[1]],
          [reach * u[0], reach * u[1]],
        ];
      },
      colors.proj,
      thin,
      3,
    );

    // garis tegak lurus dari ujung vektor ke kaki proyeksi
    const projPerp = dataCurve(
      () => {
        const info = projInfo();
        if (!info) return null;
        return Math.hypot(info.vec[0] - info.foot[0], info.vec[1] - info.foot[1]) > 1e-6
          ? [info.vec, info.foot]
          : null;
      },
      colors.proj,
      thin + 0.5,
      2,
    );

    // tanda siku-siku di kaki proyeksi
    const projRight = dataCurve(
      () => {
        const info = projInfo();
        if (!info) return null;
        const lo = len(info.onto);
        const tip: Vec = [info.vec[0] - info.foot[0], info.vec[1] - info.foot[1]];
        const lt = len(tip);
        const lf = len(info.foot);
        if (lt < 1e-6 || lf < 1e-6) return null;
        const u: Vec = [info.onto[0] / lo, info.onto[1] / lo];
        const w: Vec = [tip[0] / lt, tip[1] / lt];
        const side = Math.min(0.5, lf * 0.4, lt * 0.4);
        const sign = info.k >= 0 ? -1 : 1;
        const d: Vec = [sign * u[0], sign * u[1]];
        const f = info.foot;
        return [
          [f[0] + side * d[0], f[1] + side * d[1]],
          [f[0] + side * (d[0] + w[0]), f[1] + side * (d[1] + w[1])],
          [f[0] + side * w[0], f[1] + side * w[1]],
        ];
      },
      colors.proj,
      thin,
      0,
    );

    // vektor proyeksi dari titik asal
    const footEnd = (i: 0 | 1) => () => {
      const info = projInfo();
      return info && len(info.foot) > 1e-6 ? info.foot[i] : 1000;
    };
    const projFoot = arrow(footEnd(0), footEnd(1), colors.proj, v.curveWidth + 1);
    projFoot.setAttribute({ strokeOpacity: 0.85 });

    /* Sudut antara a dan b */
    const arcInfo = () => {
      const va = A();
      const vb = B();
      const la = len(va);
      const lb = len(vb);
      if (la < EPS || lb < EPS) return null;
      const startAngle = Math.atan2(va[1], va[0]);
      let delta = Math.atan2(vb[1], vb[0]) - startAngle;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta <= -Math.PI) delta += 2 * Math.PI;
      if (Math.abs(delta) < 1e-6) return null;
      return {
        startAngle,
        delta,
        radius: Math.min(1.5, Math.max(0.35, 0.45 * Math.min(la, lb))),
        mid: startAngle + delta / 2,
        degrees: toDegrees(Math.abs(delta)),
      };
    };

    const angleArc = dataCurve(
      () => {
        const info = arcInfo();
        if (!info) return null;
        const pts: Vec[] = [];
        for (let i = 0; i <= ARC_STEPS; i += 1) {
          const t = info.startAngle + (info.delta * i) / ARC_STEPS;
          pts.push([info.radius * Math.cos(t), info.radius * Math.sin(t)]);
        }
        return pts;
      },
      colors.angle,
      thin + 0.5,
      0,
    );
    const angleAt = (i: 0 | 1) => () => {
      const info = arcInfo();
      if (!info) return 1000;
      const r = info.radius + 0.9;
      return i === 0 ? r * Math.cos(info.mid) : r * Math.sin(info.mid);
    };
    const angleLabel = board.create(
      "text",
      [
        angleAt(0),
        angleAt(1),
        () => {
          const info = arcInfo();
          return info ? `θ = ${formatText(info.degrees)}°` : "";
        },
      ],
      {
        fontSize: 12,
        strokeColor: colors.angle,
        anchorX: "middle",
        anchorY: "middle",
        highlight: false,
        fixed: true,
        cssStyle:
          "font-weight:600;white-space:nowrap;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;",
      },
    ) as unknown as Settable;

    /* Vektor a dan b digambar paling akhir agar berada di atas garis bantu */
    const arrowA = arrow(() => pa.X(), () => pa.Y(), colors.a, v.curveWidth);
    const arrowB = arrow(() => pb.X(), () => pb.Y(), colors.b, v.curveWidth);
    const labelA = label(
      A,
      () => `a${viewRef.current.pointLabels ? coordText(A()) : ""}`,
      colors.a,
      10,
      8,
    );
    const labelB = label(
      B,
      () => `b${viewRef.current.pointLabels ? coordText(B()) : ""}`,
      colors.b,
      10,
      8,
    );

    /* Sinkronkan ke state saat ujung vektor digeser (dibatasi ±LIMIT) */
    const readPoint = (p: PointEl): Vec => {
      const x = clampLimit(p.X());
      const y = clampLimit(p.Y());
      if (x !== p.X() || y !== p.Y()) p.setPosition(JXG.COORDS_BY_USER, [x, y]);
      return [clean(x), clean(y)];
    };
    const syncFromBoard = () => {
      const nextA = readPoint(pa);
      const nextB = readPoint(pb);
      vecRef.current = { a: nextA, b: nextB };
      setA(nextA);
      setB(nextB);
    };
    pa.on("drag", syncFromBoard);
    pb.on("drag", syncFromBoard);

    scene.current = {
      grid,
      axes: [xAxis, yAxis],
      pa,
      pb,
      arrowA,
      arrowB,
      labelA,
      labelB,
      sumShape,
      sumArrow,
      sumLabel,
      projLine,
      projPerp,
      projRight,
      projFoot,
      angleArc,
      angleLabel,
    };
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
    const thin = Math.max(1, v.curveWidth / 2);

    s.grid.setAttribute({ visible: v.grid });
    s.axes.forEach((axis) =>
      axis.defaultTicks.setAttribute({ visible: v.axisNumbers, drawLabels: v.axisNumbers }),
    );

    s.pa.setAttribute({ visible: v.show.a, size: v.pointSize + 1, snapToGrid: v.snap });
    s.arrowA.setAttribute({ visible: v.show.a, strokeWidth: v.curveWidth });
    s.labelA.setAttribute({ visible: v.show.a });
    s.pb.setAttribute({ visible: v.show.b, size: v.pointSize + 1, snapToGrid: v.snap });
    s.arrowB.setAttribute({ visible: v.show.b, strokeWidth: v.curveWidth });
    s.labelB.setAttribute({ visible: v.show.b });

    s.sumShape.setAttribute({ visible: v.show.sum, strokeWidth: thin });
    s.sumArrow.setAttribute({ visible: v.show.sum, strokeWidth: v.curveWidth });
    s.sumLabel.setAttribute({ visible: v.show.sum });

    s.projLine.setAttribute({ visible: v.show.projection, strokeWidth: thin });
    s.projPerp.setAttribute({ visible: v.show.projection, strokeWidth: thin + 0.5 });
    s.projRight.setAttribute({ visible: v.show.projection, strokeWidth: thin });
    s.projFoot.setAttribute({ visible: v.show.projection, strokeWidth: v.curveWidth + 1 });

    s.angleArc.setAttribute({ visible: v.show.angle, strokeWidth: thin + 0.5 });
    s.angleLabel.setAttribute({ visible: v.show.angle });

    boardRef.current?.update();
  }

  useEffect(() => {
    applyView();
  }, [view]);

  useEffect(() => {
    boardRef.current?.update();
  }, [a, b, projection, boardRef]);

  /* ───────── Perubahan dari pengguna ───────── */

  const setVectors = (nextA: Vec, nextB: Vec) => {
    vecRef.current = { a: nextA, b: nextB };
    setA(nextA);
    setB(nextB);
    scene.current?.pa.setPosition(JXG.COORDS_BY_USER, nextA);
    scene.current?.pb.setPosition(JXG.COORDS_BY_USER, nextB);
    boardRef.current?.update();
  };

  const setComp = (key: CompKey, value: number) => {
    const nextA: Vec = [...vecRef.current.a];
    const nextB: Vec = [...vecRef.current.b];
    const next = clean(clampLimit(value));
    if (key === "a1") nextA[0] = next;
    else if (key === "a2") nextA[1] = next;
    else if (key === "b1") nextB[0] = next;
    else nextB[1] = next;
    setVectors(nextA, nextB);
  };

  const updateView = (patch: Partial<ViewState>) => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setStoredView(next);
  };

  const toggleShow = (key: ObjectKey) =>
    updateView({ show: { ...viewRef.current.show, [key]: !viewRef.current.show[key] } });

  const pickProjection = (mode: Projection) => {
    projRef.current = mode;
    setProjection(mode);
    boardRef.current?.update();
  };

  const resetAll = () => {
    pickProjection("a");
    setVectors([...defaultA], [...defaultB]);
    resetView();
  };

  /* ───────── Nilai turunan ───────── */

  const info = analyze(a, b);
  const proj = projection === "a" ? info.aOnB : info.bOnA;
  const onto = projection === "a" ? "b" : "a";
  const from = projection === "a" ? "a" : "b";
  const projColor = colors.proj;

  const dotTex = String.raw`\vec{a}\cdot\vec{b}=${texNumber(info.dot)}`;
  const angleTex = info.defined
    ? String.raw`\theta=${texNumber(info.angle)}^{\circ}`
    : String.raw`\theta=\text{—}`;

  const projTex = proj
    ? String.raw`\operatorname{proy}_{\vec{${onto}}}\vec{${from}}=${vecTex(proj.vector)}`
    : String.raw`\operatorname{proy}_{\vec{${onto}}}\vec{${from}}=${undefinedTex}`;
  const projScalarTex = proj
    ? String.raw`\dfrac{\vec{a}\cdot\vec{b}}{|\vec{${onto}}|}=${texNumber(proj.scalar)}`
    : undefinedTex;

  /* ───────── Tampilan ───────── */

  return (
    <SimulationShell
      title="Simulasi vektor"
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
            label="Koordinat vektor"
            pressed={view.pointLabels}
            onClick={() => updateView({ pointLabels: !view.pointLabels })}
          />
        </>
      }
      settings={
        <SimSection title="Garis dan titik">
          <SimSlider
            id="vector-curve-width"
            name="tebal vektor"
            label={`Tebal vektor: ${view.curveWidth}`}
            value={view.curveWidth}
            min={1}
            max={8}
            step={1}
            onChange={(curveWidth) => updateView({ curveWidth })}
          />
          <SimSlider
            id="vector-point-size"
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
            aria-pressed={view.snap}
            onClick={() => updateView({ snap: !view.snap })}
          >
            Tempel ujung vektor ke bilangan bulat
          </button>
          <button
            type="button"
            className="sim-text-btn"
            onClick={() =>
              updateView({
                grid: initialView.grid,
                axisNumbers: initialView.axisNumbers,
                pointLabels: initialView.pointLabels,
                snap: initialView.snap,
                curveWidth: initialView.curveWidth,
                pointSize: initialView.pointSize,
                show: initialView.show,
              })
            }
          >
            Atur ulang tampilan
          </button>
        </SimSection>
      }
      graph={
        <div
          {...boardProps}
          role="img"
          aria-label="Bidang koordinat vektor. Seret ujung vektor a (biru) atau b (oranye) untuk mengubahnya. Seret area kosong untuk menggeser, cubit atau gulir untuk memperbesar."
        />
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          <SimMath tex={info.defined ? `${dotTex}\\quad ${angleTex}` : dotTex} />
        </p>
      }
      panel={
        <>
          <SimSection title="Komponen vektor">
            {sliderConfig.map(({ key, vec, i, tex, hint }) => {
              const value = (vec === "a" ? a : b)[i];
              return (
                <SimSlider
                  key={key}
                  id={`vector-${key}`}
                  name={tex.replace(/[_{}]/g, "")}
                  label={<SimMath tex={`${tex}=${texNumber(value)}`} />}
                  hint={hint}
                  accent={colors[vec]}
                  value={clampLimit(value)}
                  min={-LIMIT}
                  max={LIMIT}
                  step={view.snap ? 1 : 0.1}
                  onChange={(next) => setComp(key, next)}
                />
              );
            })}
          </SimSection>

          <SimSection title="Contoh posisi">
            <div className="sim-seg" role="group" aria-label="Contoh posisi dua vektor">
              {presets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="sim-seg__btn"
                  aria-pressed={sameVec(a, preset.a) && sameVec(b, preset.b)}
                  onClick={() => setVectors([...preset.a], [...preset.b])}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </SimSection>

          <SimSection title="Proyeksi">
            <div className="sim-seg" role="radiogroup" aria-label="Arah proyeksi">
              {projectionOptions.map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  role="radio"
                  className="sim-seg__btn"
                  aria-checked={projection === option.mode}
                  onClick={() => pickProjection(option.mode)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </SimSection>

          <SimSection title="Hasil">
            <ul className="sim-rows" aria-live="polite">
              <SimRow
                color={colors.a}
                visible={view.show.a}
                onToggle={() => toggleShow("a")}
                toggleLabel="Tampilkan atau sembunyikan vektor a"
              >
                <SimMath tex={String.raw`\vec{a}=${vecTex(a)},\ |\vec{a}|=${texNumber(info.la)}`} />
              </SimRow>
              <SimRow
                color={colors.b}
                visible={view.show.b}
                onToggle={() => toggleShow("b")}
                toggleLabel="Tampilkan atau sembunyikan vektor b"
              >
                <SimMath tex={String.raw`\vec{b}=${vecTex(b)},\ |\vec{b}|=${texNumber(info.lb)}`} />
              </SimRow>
              <SimRow
                color={colors.sum}
                visible={view.show.sum}
                onToggle={() => toggleShow("sum")}
                toggleLabel="Tampilkan atau sembunyikan vektor a + b"
              >
                <SimMath tex={String.raw`\vec{a}+\vec{b}=${vecTex(info.sum)}`} />
              </SimRow>
              <SimRow>
                <SimMath tex={String.raw`\vec{a}-\vec{b}=${vecTex(info.diff)}`} />
              </SimRow>
              <SimRow>
                <SimMath tex={dotTex} />
              </SimRow>
              <SimRow
                color={colors.angle}
                visible={view.show.angle}
                onToggle={() => toggleShow("angle")}
                toggleLabel="Tampilkan atau sembunyikan sudut"
              >
                <SimMath tex={angleTex} />
              </SimRow>
              <SimRow
                color={projColor}
                visible={view.show.projection}
                onToggle={() => toggleShow("projection")}
                toggleLabel="Tampilkan atau sembunyikan proyeksi"
              >
                <SimMath tex={projTex} />
              </SimRow>
              <SimRow>
                <SimMath tex={projScalarTex} />
              </SimRow>
            </ul>
            <p className="sim-callout" role="status">
              {relationText(info)}
            </p>
          </SimSection>
        </>
      }
      notes={
        <>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.angle }}>Perkalian titik</strong>
            {": "}
            <SimMath
              tex={String.raw`\vec{a}\cdot\vec{b}=a_{1}b_{1}+a_{2}b_{2}=${paren(a[0])}\cdot${paren(b[0])}+${paren(a[1])}\cdot${paren(b[1])}=${texNumber(info.dot)}`}
            />
            {". Hasilnya juga sama dengan "}
            <SimMath tex={String.raw`|\vec{a}|\,|\vec{b}|\cos\theta`} />
            {", sehingga tandanya menentukan jenis sudut."}
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.sum }}>Penjumlahan</strong>
            {": "}
            <SimMath tex={String.raw`\vec{a}+\vec{b}=(a_{1}+b_{1},a_{2}+b_{2})`} />
            {" adalah diagonal jajar genjang yang dibentuk oleh a dan b."}
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.proj }}>Proyeksi</strong>
            {": vektor proyeksi a pada b adalah "}
            <SimMath
              tex={String.raw`\dfrac{\vec{a}\cdot\vec{b}}{|\vec{b}|^{2}}\,\vec{b}`}
            />
            {", sedangkan panjang proyeksinya (skalar) adalah "}
            <SimMath tex={String.raw`\dfrac{\vec{a}\cdot\vec{b}}{|\vec{b}|}`} />
            {". Garis putus-putus tegak lurus menghubungkan ujung vektor ke kaki proyeksinya."}
          </p>
        </>
      }
    />
  );
}

export default VectorSimulation;
