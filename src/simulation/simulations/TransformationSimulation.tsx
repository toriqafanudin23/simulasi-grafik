import JXG from "jsxgraph";
import { ChevronDown, ChevronUp, Pause, Play, Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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

/* Simulasi transformasi geometri: translasi, refleksi, rotasi, dilatasi.
   Beberapa langkah dapat disusun berurutan lalu dianimasikan.
   Kerangka, slider, dan CSS memakai kit umum (prefix sim-). */

/* ───────── Tipe ───────── */

type Vec = [number, number];
type Mat = number[][];
type ReflectionAxis = "x" | "y" | "yx" | "ynx" | "horizontal" | "vertical";

type Step =
  | { id: number; type: "translation"; tx: number; ty: number }
  | { id: number; type: "reflection"; axis: ReflectionAxis; value?: number }
  | { id: number; type: "rotation"; angle: number; cx: number; cy: number }
  | { id: number; type: "dilation"; k: number; cx: number; cy: number };

type StepType = Step["type"];

type Draft = {
  tx: number;
  ty: number;
  axis: ReflectionAxis;
  mirrorValue: number;
  angle: number;
  rcx: number;
  rcy: number;
  k: number;
  dcx: number;
  dcy: number;
};
type DraftNumKey = Exclude<keyof Draft, "axis">;

type PanelTab = "point" | "steps" | "result";
type ObjectKey = "original" | "image" | "ghost" | "guide";

type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean; // tampilkan koordinat di samping nama titik
  snap: boolean; // tempel titik asal ke bilangan bulat
  curveWidth: number;
  pointSize: number;
  show: Record<ObjectKey, boolean>;
};

/* ───────── Konstanta ───────── */

const MAX_STEPS = 5;
const STEP_MS = 1600;
const LIMIT = 9;
const initialBox: BoundingBox = [-10, 10, 10, -10];

const colors = {
  original: "#1565c0",
  image: "#e65100",
  ghost: "#8f8f99",
  guide: "#6557d2",
  grid: "#dcdce2",
  axis: "#4a4a55",
};

const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: true,
  snap: true,
  curveWidth: 3,
  pointSize: 4,
  show: { original: true, image: true, ghost: true, guide: true },
};

/** Selalu 4 titik; hanya `count` pertama yang dipakai. */
function defaultVertices(count: number): Vec[] {
  if (count === 1) {
    return [
      [2, 1],
      [1, 1],
      [4, 1],
      [2, 3],
    ];
  }
  if (count === 4) {
    return [
      [1, 1],
      [4, 1],
      [4, 3],
      [2, 3],
    ];
  }
  return [
    [1, 1],
    [4, 1],
    [2, 3],
    [4, 3],
  ];
}

function normalizeVertices(value: unknown): Vec[] {
  const fallback = defaultVertices(3);
  if (!Array.isArray(value)) return fallback;
  return fallback.map((def, i) => {
    const p = (value as unknown[])[i];
    return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
      ? ([p[0], p[1]] as Vec)
      : def;
  });
}

const shapeOptions = [
  { count: 1, label: "Titik" },
  { count: 3, label: "Segitiga" },
  { count: 4, label: "Segiempat" },
];

const typeOptions: { type: StepType; label: string }[] = [
  { type: "translation", label: "Translasi" },
  { type: "reflection", label: "Refleksi" },
  { type: "rotation", label: "Rotasi" },
  { type: "dilation", label: "Dilatasi" },
];

const panelTabs: { tab: PanelTab; label: string }[] = [
  { tab: "point", label: "Titik" },
  { tab: "steps", label: "Langkah" },
  { tab: "result", label: "Hasil" },
];

const speedOptions = [0.5, 1, 2];

const axisLabels: Record<ReflectionAxis, string> = {
  x: "sumbu x",
  y: "sumbu y",
  yx: "garis y = x",
  ynx: "garis y = −x",
  horizontal: "garis horizontal",
  vertical: "garis vertikal",
};
const axisShort: Record<ReflectionAxis, string> = {
  x: "sumbu x",
  y: "sumbu y",
  yx: "y = x",
  ynx: "y = −x",
  horizontal: "y = k",
  vertical: "x = k",
};
const axisKeys: ReflectionAxis[] = ["x", "y", "yx", "ynx", "horizontal", "vertical"];

const reflectionAngles: Record<ReflectionAxis, number> = {
  x: 0,
  y: 90,
  yx: 45,
  ynx: -45,
  horizontal: 0,
  vertical: 90,
};

const exactReflections: Record<Exclude<ReflectionAxis, "horizontal" | "vertical">, Mat> = {
  x: [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, 1],
  ],
  y: [
    [-1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  yx: [
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ],
  ynx: [
    [0, -1, 0],
    [-1, 0, 0],
    [0, 0, 1],
  ],
};

const mirrorEnds: Record<Exclude<ReflectionAxis, "horizontal" | "vertical">, [Vec, Vec]> = {
  x: [
    [-30, 0],
    [30, 0],
  ],
  y: [
    [0, -30],
    [0, 30],
  ],
  yx: [
    [-30, -30],
    [30, 30],
  ],
  ynx: [
    [-30, 30],
    [30, -30],
  ],
};

const initialSteps: Step[] = [
  { id: 1, type: "rotation", angle: 90, cx: 0, cy: 0 },
  { id: 2, type: "translation", tx: 4, ty: -1 },
];

const initialDraft: Draft = {
  tx: 3,
  ty: 1,
  axis: "y",
  mirrorValue: 2,
  angle: 90,
  rcx: 0,
  rcy: 0,
  k: 2,
  dcx: 0,
  dcy: 0,
};

type DraftRow = {
  key: DraftNumKey;
  tex: string;
  unit?: string;
  hint: string;
  min: number;
  max: number;
  step: number;
};

const draftRows: Record<Exclude<StepType, "reflection">, DraftRow[]> = {
  translation: [
    { key: "tx", tex: "T_x", hint: "geser mendatar", min: -9, max: 9, step: 1 },
    { key: "ty", tex: "T_y", hint: "geser tegak", min: -9, max: 9, step: 1 },
  ],
  rotation: [
    {
      key: "angle",
      tex: String.raw`\theta`,
      unit: String.raw`^{\circ}`,
      hint: "positif = berlawanan arah jarum jam",
      min: -360,
      max: 360,
      step: 5,
    },
    { key: "rcx", tex: "c_x", hint: "pusat rotasi (x)", min: -9, max: 9, step: 1 },
    { key: "rcy", tex: "c_y", hint: "pusat rotasi (y)", min: -9, max: 9, step: 1 },
  ],
  dilation: [
    { key: "k", tex: "k", hint: "faktor skala", min: -4, max: 4, step: 0.1 },
    { key: "dcx", tex: "c_x", hint: "pusat dilatasi (x)", min: -9, max: 9, step: 1 },
    { key: "dcy", tex: "c_y", hint: "pusat dilatasi (y)", min: -9, max: 9, step: 1 },
  ],
};

/* ───────── Matematika ───────── */

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const identity = (): Mat => [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function multiply(a: Mat, b: Mat): Mat {
  return a.map((_, i) =>
    b[0].map((__, j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]),
  );
}

const translationMatrix = (tx: number, ty: number): Mat => [
  [1, 0, tx],
  [0, 1, ty],
  [0, 0, 1],
];
const rotationMatrix = (rad: number): Mat => [
  [Math.cos(rad), -Math.sin(rad), 0],
  [Math.sin(rad), Math.cos(rad), 0],
  [0, 0, 1],
];
const scaleMatrix = (sx: number, sy: number): Mat => [
  [sx, 0, 0],
  [0, sy, 0],
  [0, 0, 1],
];

function aboutCenter(m: Mat, cx: number, cy: number): Mat {
  return multiply(translationMatrix(cx, cy), multiply(m, translationMatrix(-cx, -cy)));
}

function exactReflection(step: Extract<Step, { type: "reflection" }>): Mat {
  const value = step.value ?? 0;
  if (step.axis === "horizontal") {
    return [
      [1, 0, 0],
      [0, -1, 2 * value],
      [0, 0, 1],
    ];
  }
  if (step.axis === "vertical") {
    return [
      [-1, 0, 2 * value],
      [0, 1, 0],
      [0, 0, 1],
    ];
  }
  return exactReflections[step.axis];
}

function reflectionLineEnds(step: Extract<Step, { type: "reflection" }>): [Vec, Vec] {
  const value = step.value ?? 0;
  if (step.axis === "horizontal") return [[-30, value], [30, value]];
  if (step.axis === "vertical") return [[value, -30], [value, 30]];
  return mirrorEnds[step.axis];
}

/**
 * Matriks satu langkah pada progres lokal t (0..1). Pada t = 1 hasilnya adalah
 * matriks transformasi sebenarnya. Refleksi dianimasikan dengan "membalik"
 * bidang lewat skala cos(πt) tegak lurus cermin.
 */
function stepMatrix(step: Step, t: number): Mat {
  switch (step.type) {
    case "translation":
      return translationMatrix(step.tx * t, step.ty * t);
    case "rotation":
      return aboutCenter(rotationMatrix(toRadians(step.angle * t)), step.cx, step.cy);
    case "dilation": {
      const s = 1 + (step.k - 1) * t;
      return aboutCenter(scaleMatrix(s, s), step.cx, step.cy);
    }
    case "reflection": {
      if (t >= 1) return exactReflection(step);
      const phi = toRadians(reflectionAngles[step.axis]);
      const flip = multiply(
        rotationMatrix(phi),
        multiply(scaleMatrix(1, Math.cos(Math.PI * t)), rotationMatrix(-phi)),
      );
      if (step.axis !== "horizontal" && step.axis !== "vertical") return flip;
      const shift = (1 - Math.cos(Math.PI * t)) * (step.value ?? 0);
      const offset = step.axis === "horizontal" ? translationMatrix(0, shift) : translationMatrix(shift, 0);
      return multiply(offset, flip);
    }
  }
}

/** Langkah ke-i selesai penuh bila progres ≥ i + 1. */
function compositeAt(steps: Step[], progress: number): Mat {
  return steps.reduce(
    (m, step, i) => multiply(stepMatrix(step, clamp01(progress - i)), m),
    identity(),
  );
}

function applyMat(m: Mat, [x, y]: Vec): Vec {
  return [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
}

/* ───────── Format ───────── */

function cleanNumber(value: number) {
  const rounded = Math.round(value * 1000) / 1000;
  return Math.abs(rounded) < 1e-9 ? 0 : rounded;
}

const coordText = ([x, y]: Vec) => `(${formatText(x)}, ${formatText(y)})`;

function vertexNames(count: number) {
  return count === 1 ? ["P"] : ["A", "B", "C", "D"].slice(0, count);
}

function describeStep(step: Step): { name: string; detail: string } {
  switch (step.type) {
    case "translation":
      return { name: "Translasi", detail: `T(${formatText(step.tx)}, ${formatText(step.ty)})` };
    case "reflection":
      return {
        name: "Refleksi",
        detail:
          step.axis === "horizontal"
            ? `terhadap garis y = ${formatText(step.value ?? 0)}`
            : step.axis === "vertical"
              ? `terhadap garis x = ${formatText(step.value ?? 0)}`
              : `terhadap ${axisLabels[step.axis]}`,
      };
    case "rotation":
      return {
        name: "Rotasi",
        detail: `${formatText(step.angle)}° pusat ${coordText([step.cx, step.cy])}`,
      };
    case "dilation":
      return {
        name: "Dilatasi",
        detail: `k = ${formatText(step.k)} pusat ${coordText([step.cx, step.cy])}`,
      };
  }
}

const matTex = (m: Mat) =>
  String.raw`\begin{bmatrix}${m
    .map((row) => row.map((n) => texNumber(cleanNumber(n))).join(" & "))
    .join(String.raw` \\ `)}\end{bmatrix}`;

const colTex = ([x, y]: Vec) =>
  String.raw`\begin{bmatrix}${texNumber(cleanNumber(x))} \\ ${texNumber(cleanNumber(y))} \\ 1\end{bmatrix}`;

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
type PolyEl = Settable & Evented & { borders: Settable[] };
type DataCurve = Settable & {
  dataX: number[];
  dataY: number[];
  updateDataArray: () => void;
};
type Scene = {
  grid: Settable;
  axes: AxisElement[];
  points: PointEl[];
  labels: Settable[];
  tri: PolyEl;
  quad: PolyEl;
  images: Settable[];
  imageLabels: Settable[];
  imageShape: Settable;
  ghostPoints: Settable[];
  ghostCurves: Settable[];
  mirror: Settable;
  center: Settable;
  vector: Settable;
};

const isFiniteVec = (p: Vec) => Number.isFinite(p[0]) && Number.isFinite(p[1]);

/* ───────── Gaya pemutar (khusus simulasi ini, tanpa menyentuh simulation.css) ───────── */

const playerStyle: CSSProperties = {
  position: "absolute",
  left: 8,
  right: 60,
  bottom: 8,
  zIndex: 2,
  display: "grid",
  gap: 2,
  padding: "4px 8px 4px 6px",
  borderRadius: "var(--sim-radius)",
  background: "rgba(255,255,255,0.94)",
  boxShadow: "var(--sim-shadow)",
};
const playerCaptionStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 2,
  overflow: "hidden",
  color: "var(--sim-muted)",
  fontSize: 11,
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const playerRowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const speedBtnStyle: CSSProperties = {
  flex: "0 0 auto",
  width: "auto",
  height: 26,
  margin: 0,
  padding: "0 8px",
};
const badgeStyle = (active: boolean): CSSProperties => ({
  display: "inline-flex",
  flex: "0 0 auto",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  borderRadius: "50%",
  background: active ? colors.image : "var(--sim-primary-soft)",
  color: active ? "#fff" : "var(--sim-primary-dark)",
  fontSize: 11,
  fontWeight: 700,
});
const scrollX: CSSProperties = { overflowX: "auto", scrollbarWidth: "thin" };

/* ───────── Komponen utama ───────── */

export function TransformationSimulation() {
  const [tab, setTab] = useState<PanelTab>("point");
  const [selected, setSelected] = useState(0);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [storedShape, setShape] = useStoredSimulationState("transformation.shape", 3);
  const [storedVertices, setVertices] = useStoredSimulationState<Vec[]>(
    "transformation.vertices.v2",
    defaultVertices(3),
  );
  const [steps, setSteps] = useStoredSimulationState<Step[]>(
    "transformation.steps",
    initialSteps,
  );
  const [speed, setSpeed] = useStoredSimulationState("transformation.speed", 1);
  const [draftType, setDraftType] = useStoredSimulationState<StepType>(
    "transformation.draft-type",
    "rotation",
  );
  const [storedDraft, setDraft] = useStoredSimulationState<Draft>(
    "transformation.draft.v2",
    initialDraft,
  );
  const draft = useMemo<Draft>(() => ({ ...initialDraft, ...storedDraft }), [storedDraft]);
  const [sampleIndex, setSampleIndex] = useStoredSimulationState(
    "transformation.sample-index",
    0,
  );
  const [storedView, setStoredView] = useStoredSimulationState(
    "transformation.view",
    initialView,
  );

  const shape = [1, 3, 4].includes(storedShape) ? storedShape : 3;
  const vertices = useMemo(() => normalizeVertices(storedVertices), [storedVertices]);
  const view = useMemo<ViewState>(
    () => ({
      ...initialView,
      ...storedView,
      show: { ...initialView.show, ...storedView.show },
    }),
    [storedView],
  );

  const shapeRef = useRef(shape);
  shapeRef.current = shape;
  const verticesRef = useRef(vertices);
  verticesRef.current = vertices;
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const viewRef = useRef(view);
  viewRef.current = view;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const progressRef = useRef(0);
  const nextId = useRef(steps.reduce((next, step) => Math.max(next, step.id + 1), 3));
  const scene = useRef<Scene | null>(null);

  /* ───────── Papan JSXGraph ───────── */

  const setup = (board: SimBoard) => {
    const v = viewRef.current;
    const count = () => shapeRef.current;
    const names = () => vertexNames(count());
    const start = verticesRef.current;
    const thin = Math.max(1, v.curveWidth / 2);

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

    /* Titik asal (4 titik; yang dipakai ditentukan oleh `count`) */
    const points = [0, 1, 2, 3].map(
      (i) =>
        board.create("point", [start[i][0], start[i][1]], {
          name: "",
          withLabel: false,
          size: v.pointSize + 1,
          fillColor: colors.original,
          strokeColor: "#ffffff",
          strokeWidth: 2,
          snapToGrid: v.snap,
          snapSizeX: 1,
          snapSizeY: 1,
          highlight: false,
          showInfobox: false,
        }) as unknown as PointEl,
    );
    const originOf = (i: number): Vec => [points[i].X(), points[i].Y()];
    const matNow = () => compositeAt(stepsRef.current, progressRef.current);
    const imagePos = (i: number): Vec =>
      i < count() ? applyMat(matNow(), originOf(i)) : [Number.NaN, Number.NaN];
    const ghostPos = (k: number, i: number): Vec => {
      const list = stepsRef.current;
      if (i >= count() || k >= list.length || progressRef.current < k) {
        return [Number.NaN, Number.NaN];
      }
      return applyMat(compositeAt(list, k), originOf(i));
    };

    /* Pembuat kurva data (garis tertutup berisi atau jejak terbuka) */
    const dataCurve = (
      getPoints: () => Vec[] | null,
      closed: boolean,
      attrs: Record<string, unknown>,
    ) => {
      const curve = board.create("curve", [[0], [0]], {
        highlight: false,
        fixed: true,
        ...attrs,
      }) as unknown as DataCurve;
      curve.updateDataArray = () => {
        const pts = getPoints();
        if (!pts || pts.length === 0 || !pts.every(isFiniteVec)) {
          curve.dataX = [Number.NaN];
          curve.dataY = [Number.NaN];
          return;
        }
        const all = closed ? [...pts, pts[0]] : pts;
        curve.dataX = all.map((p) => p[0]);
        curve.dataY = all.map((p) => p[1]);
      };
      return curve;
    };

    /* Label nama (+ koordinat) di samping titik */
    const label = (
      pos: () => Vec,
      text: () => string,
      color: string,
      dx: number,
      dy: number,
    ) =>
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

    /* Bangun asal */
    const polyAttrs = {
      hasInnerPoints: true,
      fillColor: colors.original,
      fillOpacity: 0.12,
      highlight: false,
      borders: { strokeColor: colors.original, strokeWidth: v.curveWidth, highlight: false },
    };
    const tri = board.create(
      "polygon",
      [points[0], points[1], points[2]],
      polyAttrs,
    ) as unknown as PolyEl;
    const quad = board.create("polygon", points, polyAttrs) as unknown as PolyEl;

    /* Hasil antara: titik dan garis putus-putus setelah tiap langkah */
    const ghostPoints: Settable[] = [];
    const ghostCurves: Settable[] = [];
    for (let k = 1; k < MAX_STEPS; k += 1) {
      for (let i = 0; i < 4; i += 1) {
        ghostPoints.push(
          board.create("point", [() => ghostPos(k, i)[0], () => ghostPos(k, i)[1]], {
            name: "",
            withLabel: false,
            size: Math.max(2, v.pointSize - 1),
            fillColor: colors.ghost,
            strokeColor: "#ffffff",
            strokeWidth: 1,
            fixed: true,
            highlight: false,
            showInfobox: false,
          }) as unknown as Settable,
        );
      }
      ghostCurves.push(
        dataCurve(
          () => (count() >= 3 ? Array.from({ length: count() }, (_, i) => ghostPos(k, i)) : null),
          true,
          { strokeColor: colors.ghost, strokeWidth: thin, dash: 2 },
        ),
      );
    }
    // Jejak titik tunggal: asal → hasil antara → bayangan
    ghostCurves.push(
      dataCurve(
        () => {
          if (count() !== 1) return null;
          const path: Vec[] = [originOf(0)];
          for (let k = 1; k < MAX_STEPS; k += 1) {
            const g = ghostPos(k, 0);
            if (isFiniteVec(g)) path.push(g);
          }
          path.push(imagePos(0));
          return path;
        },
        false,
        { strokeColor: colors.ghost, strokeWidth: thin, dash: 2 },
      ),
    );

    /* Bayangan */
    const imageShape = dataCurve(
      () => (count() >= 3 ? Array.from({ length: count() }, (_, i) => imagePos(i)) : null),
      true,
      {
        strokeColor: colors.image,
        strokeWidth: v.curveWidth,
        fillColor: colors.image,
        fillOpacity: 0.16,
      },
    ) as Settable;
    const images = [0, 1, 2, 3].map(
      (i) =>
        board.create("point", [() => imagePos(i)[0], () => imagePos(i)[1]], {
          name: "",
          withLabel: false,
          size: v.pointSize,
          fillColor: colors.image,
          strokeColor: "#ffffff",
          strokeWidth: 1.5,
          fixed: true,
          highlight: false,
          showInfobox: false,
        }) as unknown as Settable,
    );

    const labels = [0, 1, 2, 3].map((i) =>
      label(
        () => originOf(i),
        () =>
          `${names()[i] ?? ""}${viewRef.current.pointLabels ? coordText(originOf(i)) : ""}`,
        colors.original,
        8,
        6,
      ),
    );
    const imageLabels = [0, 1, 2, 3].map((i) =>
      label(
        () => imagePos(i),
        () =>
          `${names()[i] ?? ""}′${viewRef.current.pointLabels ? coordText(imagePos(i)) : ""}`,
        colors.image,
        8,
        -16,
      ),
    );

    /* Penunjuk langkah aktif: cermin, pusat, dan vektor translasi */
    const guideStep = (): Step | null => {
      const list = stepsRef.current;
      if (list.length === 0) return null;
      const index = Math.max(0, Math.min(Math.floor(progressRef.current), list.length - 1));
      return list[index] ?? null;
    };
    const guideIndex = () =>
      Math.max(0, Math.min(Math.floor(progressRef.current), stepsRef.current.length - 1));

    const mirrorCoord = (end: 0 | 1, coord: 0 | 1) => () => {
      const step = guideStep();
      return step && step.type === "reflection"
        ? reflectionLineEnds(step)[end][coord]
        : 1000 + end;
    };
    const mirror = board.create(
      "segment",
      [
        [mirrorCoord(0, 0), mirrorCoord(0, 1)],
        [mirrorCoord(1, 0), mirrorCoord(1, 1)],
      ],
      {
        strokeColor: colors.guide,
        strokeWidth: 2,
        dash: 3,
        highlight: false,
        fixed: true,
        point1: { visible: false },
        point2: { visible: false },
      },
    ) as unknown as Settable;

    const centerCoord = (coord: "cx" | "cy") => () => {
      const step = guideStep();
      return step && (step.type === "rotation" || step.type === "dilation")
        ? step[coord]
        : Number.NaN;
    };
    const center = board.create("point", [centerCoord("cx"), centerCoord("cy")], {
      name: "pusat",
      withLabel: true,
      size: 5,
      face: "cross",
      fillColor: colors.guide,
      strokeColor: colors.guide,
      strokeWidth: 2,
      fixed: true,
      highlight: false,
      showInfobox: false,
      label: { offset: [8, -14], fontSize: 11, strokeColor: colors.guide },
    }) as unknown as Settable;

    const vectorEnd = (which: "from" | "to", coord: 0 | 1) => () => {
      const off = 1000 + (which === "to" ? 1 : 0);
      const step = guideStep();
      if (!step || step.type !== "translation" || count() < 1) return off;
      const from = applyMat(compositeAt(stepsRef.current, guideIndex()), originOf(0));
      const to = imagePos(0);
      if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 1e-6) return off;
      return (which === "from" ? from : to)[coord];
    };
    const vector = board.create(
      "segment",
      [
        [vectorEnd("from", 0), vectorEnd("from", 1)],
        [vectorEnd("to", 0), vectorEnd("to", 1)],
      ],
      {
        strokeColor: colors.guide,
        strokeWidth: 2,
        lastArrow: { type: 2, size: 6 },
        highlight: false,
        fixed: true,
        point1: { visible: false },
        point2: { visible: false },
      },
    ) as unknown as Settable;

    /* Sinkronkan koordinat awal ke state saat titik / bangun digeser */
    const syncVertices = () => {
      const next = points.map((p) => [cleanNumber(p.X()), cleanNumber(p.Y())] as Vec);
      verticesRef.current = next;
      setVertices(next);
    };
    points.forEach((point, i) => {
      point.on("down", () => setSelected(i));
      point.on("drag", syncVertices);
    });
    [tri, quad].forEach((poly) => {
      poly.on("drag", syncVertices);
      poly.on("up", () => {
        if (viewRef.current.snap) {
          points.forEach((p) =>
            p.setPosition(JXG.COORDS_BY_USER, [Math.round(p.X()), Math.round(p.Y())]),
          );
          board.update();
        }
        syncVertices();
      });
    });

    scene.current = {
      grid,
      axes: [xAxis, yAxis],
      points,
      labels,
      tri,
      quad,
      images,
      imageLabels,
      imageShape,
      ghostPoints,
      ghostCurves,
      mirror,
      center,
      vector,
    };
    applyView();
  };

  const { boardProps, boardRef, zoomIn, zoomOut, resetView } = useJsxBoard({
    boundingBox: initialBox,
    setup,
  });

  /** Menerapkan toggle, jumlah titik, ketebalan garis, dan ukuran titik. */
  function applyView() {
    const s = scene.current;
    if (!s) return;
    const v = viewRef.current;
    const count = shapeRef.current;
    const thin = Math.max(1, v.curveWidth / 2);

    s.grid.setAttribute({ visible: v.grid });
    s.axes.forEach((axis) =>
      axis.defaultTicks.setAttribute({ visible: v.axisNumbers, drawLabels: v.axisNumbers }),
    );

    // Poligon asal: sembunyikan/tampilkan dulu, lalu atur titik satu per satu
    // (menyembunyikan poligon ikut menyembunyikan titik sudutnya).
    const origin = v.show.original;
    s.tri.setAttribute({ visible: origin && count === 3 });
    s.quad.setAttribute({ visible: origin && count === 4 });
    [s.tri, s.quad].forEach((poly) =>
      poly.borders.forEach((border) => border.setAttribute({ strokeWidth: v.curveWidth })),
    );
    s.points.forEach((point, i) =>
      point.setAttribute({
        visible: origin && i < count,
        size: v.pointSize + 1,
        snapToGrid: v.snap,
      }),
    );
    s.labels.forEach((text, i) => text.setAttribute({ visible: origin && i < count }));

    const image = v.show.image;
    s.imageShape.setAttribute({ visible: image, strokeWidth: v.curveWidth });
    s.images.forEach((point, i) =>
      point.setAttribute({ visible: image && i < count, size: v.pointSize }),
    );
    s.imageLabels.forEach((text, i) => text.setAttribute({ visible: image && i < count }));

    s.ghostPoints.forEach((point) =>
      point.setAttribute({ visible: v.show.ghost, size: Math.max(2, v.pointSize - 1) }),
    );
    s.ghostCurves.forEach((curve) =>
      curve.setAttribute({ visible: v.show.ghost, strokeWidth: thin }),
    );

    s.mirror.setAttribute({ visible: v.show.guide, strokeWidth: thin + 0.5 });
    s.vector.setAttribute({ visible: v.show.guide, strokeWidth: thin + 0.5 });
    s.center.setAttribute({ visible: v.show.guide });

    boardRef.current?.update();
  }

  useEffect(() => {
    applyView();
  }, [view, shape]);

  useEffect(() => {
    boardRef.current?.update();
  }, [steps, boardRef]);

  /* ───────── Perubahan dari pengguna ───────── */

  const updateView = (patch: Partial<ViewState>) => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setStoredView(next);
  };

  const toggleShow = (key: ObjectKey) =>
    updateView({ show: { ...viewRef.current.show, [key]: !viewRef.current.show[key] } });

  const setProgressValue = (value: number) => {
    const safe = Number.isFinite(value)
      ? Math.min(Math.max(0, value), stepsRef.current.length)
      : 0;
    progressRef.current = safe;
    setProgress(safe);
    boardRef.current?.update();
  };

  const updateSteps = (next: Step[]) => {
    stepsRef.current = next;
    setSteps(next);
    if (next.length === 0) setPlaying(false);
    setProgressValue(Math.min(progressRef.current, next.length));
  };

  const setDraftNum = (key: DraftNumKey, value: number) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const addStep = () => {
    if (stepsRef.current.length >= MAX_STEPS) return;
    const id = nextId.current++;
    let step: Step;
    switch (draftType) {
      case "translation":
        step = { id, type: "translation", tx: draft.tx, ty: draft.ty };
        break;
      case "reflection":
        step = { id, type: "reflection", axis: draft.axis, value: draft.mirrorValue };
        break;
      case "rotation":
        step = { id, type: "rotation", angle: draft.angle, cx: draft.rcx, cy: draft.rcy };
        break;
      default:
        step = { id, type: "dilation", k: draft.k, cx: draft.dcx, cy: draft.dcy };
    }
    updateSteps([...stepsRef.current, step]);
  };

  const removeStep = (id: number) =>
    updateSteps(stepsRef.current.filter((step) => step.id !== id));

  const moveStep = (index: number, direction: 1 | -1) => {
    const target = index + direction;
    const list = [...stepsRef.current];
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    updateSteps(list);
  };

  const applyVertices = (next: Vec[]) => {
    verticesRef.current = next;
    setVertices(next);
    scene.current?.points.forEach((point, i) => {
      if (next[i]) point.setPosition(JXG.COORDS_BY_USER, next[i]);
    });
    boardRef.current?.update();
  };

  const setVertexCoord = (index: number, axis: 0 | 1, value: number) => {
    const next = verticesRef.current.map((p) => [...p] as Vec);
    if (!next[index]) return;
    next[index][axis] = clamp(value, -LIMIT, LIMIT);
    applyVertices(next);
  };

  const changeShape = (count: number) => {
    if (count === shape) return;
    shapeRef.current = count;
    setShape(count);
    setSelected(0);
    applyVertices(defaultVertices(count));
  };

  const resetPoints = () => applyVertices(defaultVertices(shape));

  const resetAll = () => {
    setPlaying(false);
    shapeRef.current = 3;
    setShape(3);
    setSelected(0);
    applyVertices(defaultVertices(3));
    updateSteps(initialSteps);
    setDraft(initialDraft);
    setDraftType("rotation");
    setProgressValue(0);
  };

  /* ───────── Pemutar ───────── */

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    const count = stepsRef.current.length;
    if (count === 0) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setProgressValue(count);
      return;
    }
    if (progressRef.current >= count) setProgressValue(0);
    setPlaying(true);
  };

  const cycleSpeed = () => {
    const next = speedOptions[(speedOptions.indexOf(speed) + 1) % speedOptions.length];
    speedRef.current = next;
    setSpeed(next);
  };

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // Jepit delta agar progres tidak melompat saat tab tertidur.
      const delta = Math.max(0, Math.min(now - last, 64));
      last = now;
      const count = stepsRef.current.length;
      const next = Math.max(
        0,
        Math.min(count, progressRef.current + (delta / STEP_MS) * speedRef.current),
      );
      progressRef.current = next;
      setProgress(next);
      boardRef.current?.update();
      if (next >= count) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, boardRef]);

  /* ───────── Nilai turunan ───────── */

  const total = steps.length;
  const names = vertexNames(shape);
  const sel = Math.max(0, Math.min(selected, shape - 1));
  const sample = Math.max(0, Math.min(sampleIndex, shape - 1));
  const selVertex: Vec = vertices[sel] ?? [0, 0];
  const currentMatrix = compositeAt(steps, progress);
  const finalMatrix = compositeAt(steps, total);
  const activeIndex =
    total === 0 ? -1 : Math.max(0, Math.min(Math.floor(progress) || 0, total - 1));
  const isDone = total > 0 && progress >= total;
  const sampleStart: Vec = vertices[sample] ?? [0, 0];
  const sampleEnd = applyMat(finalMatrix, sampleStart);
  const progressPct = total === 0 ? 0 : (progress / total) * 100;
  const speedText = String(speed);
  const vertexStep = view.snap ? 1 : 0.1;

  let caption = "Belum ada langkah. Tambahkan di bagian Langkah.";
  let shortCaption = "Belum ada langkah";
  if (total > 0 && steps[activeIndex]) {
    const info = describeStep(steps[activeIndex]);
    caption = isDone
      ? `Selesai: ${total} langkah diterapkan.`
      : `Langkah ${activeIndex + 1}/${total}: ${info.name} ${info.detail}`;
    shortCaption = isDone
      ? `Selesai (${total} langkah)`
      : `Langkah ${activeIndex + 1}/${total}: ${info.name}`;
  }

  const compositeTex =
    total === 0
      ? "M=I"
      : `M=${steps
          .map((_, i) => `M_{${i + 1}}`)
          .reverse()
          .join(String.raw`\cdot `)}`;

  const progressStyle = {
    "--sim-fill": `${progressPct}%`,
    "--sim-accent": colors.image,
  } as CSSProperties;

  /* ───────── Tampilan ───────── */

  return (
    <SimulationShell
      title="Simulasi transformasi geometri"
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
            id="transformation-curve-width"
            name="tebal garis"
            label={`Tebal garis: ${view.curveWidth}`}
            value={view.curveWidth}
            min={1}
            max={8}
            step={1}
            onChange={(curveWidth) => updateView({ curveWidth })}
          />
          <SimSlider
            id="transformation-point-size"
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
            Tempel titik asal ke bilangan bulat
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
        <>
          <div
            {...boardProps}
            role="img"
            aria-label="Bidang koordinat interaktif. Seret titik atau bangun biru untuk mengubah posisi awal; bayangan berwarna oranye. Seret area kosong untuk menggeser, cubit atau gulir untuk memperbesar."
          />
          <div style={playerStyle} role="group" aria-label="Pemutar animasi">
            <p style={playerCaptionStyle} aria-live="polite">
              {caption}
            </p>
            <div style={playerRowStyle}>
              <button
                type="button"
                className="sim-fab"
                style={{ flex: "0 0 auto" }}
                onClick={togglePlay}
                disabled={total === 0}
                aria-label={playing ? "Jeda" : isDone ? "Putar ulang" : "Mainkan"}
                title={playing ? "Jeda" : isDone ? "Putar ulang" : "Mainkan"}
              >
                {playing ? (
                  <Pause size={15} aria-hidden="true" />
                ) : isDone ? (
                  <RotateCcw size={15} aria-hidden="true" />
                ) : (
                  <Play size={15} aria-hidden="true" />
                )}
              </button>
              <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                <input
                  className="sim-range"
                  type="range"
                  min={0}
                  max={Math.max(total, 1)}
                  step={0.01}
                  value={progress}
                  disabled={total === 0}
                  style={progressStyle}
                  aria-label="Progres animasi"
                  aria-valuetext={caption}
                  onChange={(event) => {
                    setPlaying(false);
                    setProgressValue(Number(event.currentTarget.value));
                  }}
                />
              </div>
              <button
                type="button"
                className="sim-text-btn"
                style={speedBtnStyle}
                onClick={cycleSpeed}
                aria-label={`Kecepatan ${speedText} kali, ketuk untuk mengganti`}
                title="Kecepatan animasi"
              >
                {speedText}×
              </button>
            </div>
          </div>
        </>
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          {shortCaption}
        </p>
      }
      panel={
        <>
          <SimSection title="Transformasi geometri" sticky>
            <div className="sim-seg" role="group" aria-label="Bagian panel">
              {panelTabs.map((item) => (
                <button
                  key={item.tab}
                  type="button"
                  className="sim-seg__btn"
                  aria-pressed={tab === item.tab}
                  onClick={() => setTab(item.tab)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </SimSection>

          {/* ── Titik ── */}
          {tab === "point" && (
            <>
              <SimSection title="Bangun asal">
                <div className="sim-seg" role="radiogroup" aria-label="Bentuk bangun">
                  {shapeOptions.map((option) => (
                    <button
                      key={option.count}
                      type="button"
                      role="radio"
                      className="sim-seg__btn"
                      aria-checked={shape === option.count}
                      onClick={() => changeShape(option.count)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {shape > 1 && (
                  <div
                    className="sim-seg"
                    style={{ marginTop: 6 }}
                    role="radiogroup"
                    aria-label="Pilih titik"
                  >
                    {names.map((name, i) => (
                      <button
                        key={name}
                        type="button"
                        role="radio"
                        className="sim-seg__btn"
                        aria-checked={sel === i}
                        onClick={() => setSelected(i)}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
              </SimSection>
              <SimSection title={`Koordinat awal ${names[sel]}`}>
                <SimSlider
                  id="transformation-vertex-x"
                  name={`x titik ${names[sel]}`}
                  label={<SimMath tex={`x_{${names[sel]}}=${texNumber(selVertex[0])}`} />}
                  hint="absis"
                  accent={colors.original}
                  value={clamp(selVertex[0], -LIMIT, LIMIT)}
                  min={-LIMIT}
                  max={LIMIT}
                  step={vertexStep}
                  onChange={(value) => setVertexCoord(sel, 0, value)}
                />
                <SimSlider
                  id="transformation-vertex-y"
                  name={`y titik ${names[sel]}`}
                  label={<SimMath tex={`y_{${names[sel]}}=${texNumber(selVertex[1])}`} />}
                  hint="ordinat"
                  accent={colors.original}
                  value={clamp(selVertex[1], -LIMIT, LIMIT)}
                  min={-LIMIT}
                  max={LIMIT}
                  step={vertexStep}
                  onChange={(value) => setVertexCoord(sel, 1, value)}
                />
                <button type="button" className="sim-text-btn" onClick={resetPoints}>
                  Posisi awal bangun
                </button>
                <p className="sim-hint">
                  Titik atau seluruh bangun biru juga dapat diseret langsung di grafik.
                </p>
              </SimSection>
            </>
          )}

          {/* ── Langkah ── */}
          {tab === "steps" && (
            <>
              <SimSection title={`Urutan transformasi (${total}/${MAX_STEPS})`}>
                {total === 0 ? (
                  <p className="sim-hint">Belum ada langkah.</p>
                ) : (
                  <ol className="sim-rows" style={{ margin: 0, padding: 0, listStyle: "none" }}>
                    {steps.map((step, i) => {
                      const info = describeStep(step);
                      const active = i === activeIndex;
                      return (
                        <li key={step.id} className="sim-row" style={{ gap: 6 }}>
                          <span style={badgeStyle(active)} aria-hidden="true">
                            {i + 1}
                          </span>
                          <div className="sim-row__body">
                            <button
                              type="button"
                              className="sim-link"
                              style={{
                                color: "inherit",
                                fontSize: "inherit",
                                textAlign: "left",
                                textDecoration: "none",
                              }}
                              title="Tampilkan hasil sampai langkah ini"
                              onClick={() => {
                                setPlaying(false);
                                setProgressValue(i + 1);
                              }}
                            >
                              <b>{info.name}</b> {info.detail}
                            </button>
                          </div>
                          {total > 1 && (
                            <>
                              <button
                                type="button"
                                className="sim-icon-btn"
                                disabled={i === 0}
                                aria-label={`Naikkan langkah ${i + 1}`}
                                onClick={() => moveStep(i, -1)}
                              >
                                <ChevronUp size={14} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="sim-icon-btn"
                                disabled={i === total - 1}
                                aria-label={`Turunkan langkah ${i + 1}`}
                                onClick={() => moveStep(i, 1)}
                              >
                                <ChevronDown size={14} aria-hidden="true" />
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            className="sim-icon-btn"
                            aria-label={`Hapus langkah ${i + 1}: ${info.name}`}
                            onClick={() => removeStep(step.id)}
                          >
                            <X size={14} aria-hidden="true" />
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
                <div className="sim-btn-row">
                  <button
                    type="button"
                    className="sim-text-btn"
                    onClick={() => updateSteps([])}
                    disabled={total === 0}
                  >
                    Kosongkan
                  </button>
                </div>
                {total > 1 && (
                  <p className="sim-hint">
                    Urutan berpengaruh: coba tukar langkah dengan tombol panah.
                  </p>
                )}
              </SimSection>

              <SimSection title="Tambah langkah">
                <div className="sim-seg" role="radiogroup" aria-label="Jenis transformasi">
                  {typeOptions.map((option) => (
                    <button
                      key={option.type}
                      type="button"
                      role="radio"
                      className="sim-seg__btn"
                      aria-checked={draftType === option.type}
                      onClick={() => setDraftType(option.type)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                {draftType === "reflection" ? (
                  <>
                    <div
                      className="sim-seg"
                      style={{ marginTop: 6 }}
                      role="radiogroup"
                      aria-label="Garis cermin"
                    >
                      {axisKeys.map((axis) => (
                        <button
                          key={axis}
                          type="button"
                          role="radio"
                          className="sim-seg__btn"
                          aria-checked={draft.axis === axis}
                          onClick={() => setDraft((current) => ({ ...current, axis }))}
                        >
                          {axisShort[axis]}
                        </button>
                      ))}
                    </div>
                    {(draft.axis === "horizontal" || draft.axis === "vertical") && (
                      <SimSlider
                        id="transformation-draft-reflection-value"
                        name={draft.axis === "horizontal" ? "nilai y garis cermin" : "nilai x garis cermin"}
                        label={
                          <SimMath
                            tex={`${draft.axis === "horizontal" ? "y" : "x"}=${texNumber(draft.mirrorValue)}`}
                          />
                        }
                        hint="posisi garis cermin"
                        accent={colors.guide}
                        value={draft.mirrorValue}
                        min={-9}
                        max={9}
                        step={0.5}
                        onChange={(value) => setDraftNum("mirrorValue", value)}
                      />
                    )}
                  </>
                ) : (
                  draftRows[draftType].map((row) => (
                    <SimSlider
                      key={`${draftType}-${row.key}`}
                      id={`transformation-draft-${draftType}-${row.key}`}
                      name={row.hint}
                      label={
                        <SimMath tex={`${row.tex}=${texNumber(draft[row.key])}${row.unit ?? ""}`} />
                      }
                      hint={row.hint}
                      accent={colors.image}
                      value={draft[row.key]}
                      min={row.min}
                      max={row.max}
                      step={row.step}
                      onChange={(value) => setDraftNum(row.key, value)}
                    />
                  ))
                )}

                <button
                  type="button"
                  className="sim-text-btn sim-text-btn--icon"
                  onClick={addStep}
                  disabled={total >= MAX_STEPS}
                >
                  <Plus size={14} aria-hidden="true" />
                  <span>Tambah langkah</span>
                </button>
                {total >= MAX_STEPS && (
                  <p className="sim-hint">Maksimal {MAX_STEPS} langkah.</p>
                )}
              </SimSection>
            </>
          )}

          {/* ── Hasil ── */}
          {tab === "result" && (
            <>
              <SimSection title="Objek">
                <ul className="sim-rows">
                  <SimRow
                    color={colors.original}
                    visible={view.show.original}
                    onToggle={() => toggleShow("original")}
                    toggleLabel="Tampilkan atau sembunyikan bangun asal"
                  >
                    Bangun asal
                  </SimRow>
                  <SimRow
                    color={colors.image}
                    visible={view.show.image}
                    onToggle={() => toggleShow("image")}
                    toggleLabel="Tampilkan atau sembunyikan bayangan"
                  >
                    Bayangan
                  </SimRow>
                  <SimRow
                    color={colors.ghost}
                    visible={view.show.ghost}
                    onToggle={() => toggleShow("ghost")}
                    toggleLabel="Tampilkan atau sembunyikan hasil antara"
                  >
                    Hasil antara
                  </SimRow>
                  <SimRow
                    color={colors.guide}
                    visible={view.show.guide}
                    onToggle={() => toggleShow("guide")}
                    toggleLabel="Tampilkan atau sembunyikan cermin, pusat, dan vektor"
                  >
                    Cermin / pusat / vektor
                  </SimRow>
                </ul>
              </SimSection>

              <SimSection title="Koordinat titik">
                <div className="sim-table-wrap">
                  <table className="sim-table">
                    <thead>
                      <tr>
                        <th scope="col" style={{ textAlign: "left" }}>
                          Titik
                        </th>
                        <th scope="col">Awal</th>
                        <th scope="col">Saat ini</th>
                        <th scope="col">Akhir</th>
                      </tr>
                    </thead>
                    <tbody>
                      {names.map((name, i) => {
                        const origin: Vec = vertices[i] ?? [0, 0];
                        return (
                          <tr key={name}>
                            <th scope="row">
                              {name} → {name}′
                            </th>
                            <td style={{ color: colors.original }}>{coordText(origin)}</td>
                            <td>{coordText(applyMat(currentMatrix, origin))}</td>
                            <td style={{ color: colors.image }}>
                              {coordText(applyMat(finalMatrix, origin))}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </SimSection>

              <SimSection title="Matriks transformasi">
                <p className="sim-hint">
                  Matriks homogen 3 × 3; kolom ketiga menyimpan pergeseran.
                </p>
                {steps.map((step, i) => {
                  const info = describeStep(step);
                  return (
                    <div
                      key={step.id}
                      className="sim-callout"
                      style={
                        { "--sim-accent": i === activeIndex ? colors.image : colors.ghost } as CSSProperties
                      }
                    >
                      <b>
                        M<sub>{i + 1}</sub> · {info.name}
                      </b>{" "}
                      {info.detail}
                      <div style={scrollX}>
                        <SimMath tex={`M_{${i + 1}}=${matTex(stepMatrix(step, 1))}`} />
                      </div>
                    </div>
                  );
                })}
                <div
                  className="sim-callout"
                  style={{ "--sim-accent": colors.guide } as CSSProperties}
                >
                  <b>Matriks komposisi</b>{" "}
                  {total > 1 && "(dibaca dari kanan ke kiri)"}
                  <div style={scrollX}>
                    <SimMath tex={`${compositeTex}=${matTex(finalMatrix)}`} />
                  </div>
                </div>
              </SimSection>

              <SimSection title="Contoh perhitungan">
                {shape > 1 && (
                  <div className="sim-seg" role="radiogroup" aria-label="Titik contoh">
                    {names.map((name, i) => (
                      <button
                        key={name}
                        type="button"
                        role="radio"
                        className="sim-seg__btn"
                        aria-checked={sample === i}
                        onClick={() => setSampleIndex(i)}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
                <div style={{ ...scrollX, marginTop: 6 }}>
                  <SimMath
                    tex={`${colTex(sampleEnd)}=${matTex(finalMatrix)}${colTex(sampleStart)}`}
                  />
                </div>
                <p className="sim-hint">
                  {names[sample]}
                  {coordText(sampleStart)} → {names[sample]}′{coordText(sampleEnd)}
                </p>
              </SimSection>
            </>
          )}
        </>
      }
      notes={
        <>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.image }}>Translasi</strong>
            {": setiap titik digeser sejauh vektor yang sama, "}
            <SimMath tex={String.raw`(x',y')=(x+T_x,\ y+T_y)`} />
            {"."}
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.guide }}>Refleksi</strong>
            {": setiap titik dicerminkan terhadap garis cermin (garis putus-putus ungu). Jarak titik dan bayangannya ke cermin sama besar, misalnya terhadap sumbu x: "}
            <SimMath tex={String.raw`(x,y)\to(x,-y)`} />
            {"."}
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.image }}>Rotasi</strong>
            {": titik diputar sebesar "}
            <SimMath tex={String.raw`\theta`} />
            {" terhadap pusat "}
            <SimMath tex={String.raw`(c_x,c_y)`} />
            {", positif berlawanan arah jarum jam: "}
            <SimMath
              tex={String.raw`x'=c_x+(x-c_x)\cos\theta-(y-c_y)\sin\theta`}
            />
            {"."}
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.image }}>Dilatasi</strong>
            {": jarak ke pusat dikalikan faktor "}
            <SimMath tex="k" />
            {": "}
            <SimMath tex={String.raw`x'=c_x+k(x-c_x)`} />
            {". Bila "}
            <SimMath tex="k<0" />
            {", bayangan berada di seberang pusat."}
          </p>
        </>
      }
    />
  );
}

export default TransformationSimulation;
