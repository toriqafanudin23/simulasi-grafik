import { ArrowUpDown, Download, Link2, Pause, Play, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
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
import { clamp } from "../common/utils/simUtils";
import { useJsxBoard, type SimBoard } from "../common/hooks/useJsxBoard";
import { useStoredSimulationState } from "../common/hooks/useStoredSimulationState";
import {
  PARAM_NAMES,
  derivative,
  findExtrema,
  findRoots,
  parseLatex,
  type Extremum,
  type Params,
} from "../math/latexMath";

/* Penggambar grafik (mode kosong ala GeoGebra): hingga enam fungsi, titik
   potong antargrafik, titik potong sumbu, maksimum/minimum, garis singgung,
   dan titik yang dapat disematkan.
   Kerangka, slider, dan CSS memakai kit umum (prefix sim-). */

/* ───────── Tipe ───────── */

type Slot = { src: string; on: boolean; der: boolean };
type Pt = { x: number; y: number };
type PairResult = { i: number; j: number; pts: Pt[]; coincident: boolean };
type AxisResult = { i: number; yInt: Pt | null; xInts: Pt[]; ext: Extremum[] };
type Results = { pairs: PairResult[]; axes: AxisResult[] };
type Pin = {
  id: number;
  x: number;
  y: number;
  slot: number | null;
  slope: number | null;
};
type TraceRow = { i: number; y: number; dy: number };
type Trace = { x: number; rows: TraceRow[] };
type View = [number, number, number, number];
type Shared = {
  slots: Slot[];
  params: Params;
  view: View | null;
  lock: boolean;
};
type PlotOptions = {
  inter: boolean;
  axis: boolean;
  ext: boolean;
  tan: boolean;
  lock: boolean;
};
type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean;
  curveWidth: number;
  pointSize: number;
};

type Settable = { setAttribute: (attributes: Record<string, unknown>) => unknown };
type AxisElement = Settable & { defaultTicks: Settable };
type Scene = {
  grid: Settable;
  axes: AxisElement[];
  curves: Settable[];
  ders: Settable[];
  tans: Settable[];
  points: { el: Settable; extra: number }[];
  labels: Settable[];
};

/* ───────── Konstanta ───────── */

const MAX_SLOTS = 6;
const MAX_PINS = 12;
const SLOT_COLORS = [
  "#087f8c",
  "#d16b36",
  "#6b4e9b",
  "#3c8d2f",
  "#2f6bd0",
  "#8a5a2b",
];
const INTER_COLOR = "#b23a48";
const PIN_COLOR = "#183e54";
const AXIS_COLOR = "#2e7d32";
const EXT_COLOR = "#6b4e9b";
const TRACE_COLOR = "#087f8c";
const PARAM_COLOR = "#6557d2";
const INTER_POOL = 40;
const AXIS_POOL = 7; // 1 titik potong sumbu y + maksimal 6 akar per grafik
const EXT_POOL = 6;
const HOME_BOX: View = [-10, 10, 10, -10];
const PARAM_MIN = -10;
const PARAM_MAX = 10;
const PARAM_SPEED = 2; // satuan per detik saat animasi parameter
const DEFAULT_PARAMS: Params = { a: 1, b: 1, c: 1, k: 1 };

const initialSlots: Slot[] = [
  { src: "x^{2}", on: true, der: false },
  { src: "2x+3", on: true, der: false },
  { src: "", on: true, der: false },
];
const initialOptions: PlotOptions = {
  inter: true,
  axis: false,
  ext: false,
  tan: false,
  lock: true,
};
const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: true,
  curveWidth: 3,
  pointSize: 4,
};

const PLACEHOLDERS = [
  "x^{2}-2",
  "\\frac{x+1}{2}",
  "e^{-x}",
  "a\\sin(kx)",
  "|x-1|",
  "\\sqrt{x}",
];

type Preset = { label: string; srcs: string[]; params?: Params; der?: boolean };
const PRESETS: Preset[] = [
  { label: "Parabola & garis", srcs: ["x^{2}", "2x+3"] },
  { label: "eˣ, ln x, y = x", srcs: ["e^{x}", "\\ln x", "x"] },
  { label: "sin, cos, ½", srcs: ["\\sin x", "\\cos x", "\\frac{1}{2}"] },
  {
    label: "1/x, parabola, akar",
    srcs: ["\\frac{1}{x}", "x^{2}-2", "\\sqrt{x}"],
  },
  {
    label: "Parabola ax²+bx+c",
    srcs: ["ax^{2}+bx+c", "0"],
    params: { a: 1, b: -2, c: -3 },
  },
  {
    label: "Gelombang a·sin(kx)",
    srcs: ["a\\sin(kx)", "a\\sin(kx+b)"],
    params: { a: 2, k: 1, b: 1 },
  },
  { label: "Fungsi & turunannya", srcs: ["x^{3}-3x"], der: true },
  {
    label: "Transformasi |x|",
    srcs: ["|x|", "a|x-b|+c"],
    params: { a: 2, b: 3, c: -1 },
  },
];

// § menandai posisi kursor setelah disisipkan
const SNIPPETS: { label: string; title: string; text: string }[] = [
  { label: "xⁿ", title: "Pangkat", text: "^{§}" },
  { label: "a/b", title: "Pecahan", text: "\\frac{§}{}" },
  { label: "√", title: "Akar kuadrat", text: "\\sqrt{§}" },
  { label: "ⁿ√", title: "Akar pangkat n", text: "\\sqrt[§]{}" },
  { label: "eˣ", title: "Eksponen basis e", text: "e^{§}" },
  { label: "π", title: "Pi", text: "\\pi§" },
  { label: "|x|", title: "Nilai mutlak", text: "\\left|§\\right|" },
  { label: "sin", title: "Sinus", text: "\\sin(§)" },
  { label: "cos", title: "Kosinus", text: "\\cos(§)" },
  { label: "tan", title: "Tangen", text: "\\tan(§)" },
  { label: "ln", title: "Logaritma natural", text: "\\ln(§)" },
  { label: "log", title: "Logaritma basis tertentu", text: "\\log_{§}()" },
];

/* ───────── Format angka (titik desimal, minus sebenarnya) ───────── */

function fmt(value: number, digits = 4) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < Math.pow(10, -digits) / 2) return "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    useGrouping: false,
  })
    .format(value)
    .replace("-", "−");
}

function ptText(p: Pt) {
  return `(${fmt(p.x)}, ${fmt(p.y)})`;
}

/** Angka untuk KaTeX: titik desimal tanpa spasi, minus sebagai "-". */
function texNum(value: number, digits = 2) {
  return fmt(value, digits).replace("−", "-");
}

/* ───────── Tautan yang dapat dibagikan (?grafik=...) ───────── */

function toB64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(text: string) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function readShared(): Shared | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = new URLSearchParams(window.location.search).get("grafik");
    if (!raw) return null;
    const data = JSON.parse(fromB64(raw)) as {
      s?: unknown;
      p?: unknown;
      v?: unknown;
      r?: unknown;
    };
    if (!Array.isArray(data.s) || data.s.length === 0) return null;
    const slots: Slot[] = data.s.slice(0, MAX_SLOTS).map((row: unknown) => {
      const r = Array.isArray(row) ? row : [];
      return {
        src: typeof r[0] === "string" ? r[0].slice(0, 300) : "",
        on: r[1] !== 0,
        der: r[2] === 1,
      };
    });
    const params: Params = { ...DEFAULT_PARAMS };
    if (data.p && typeof data.p === "object") {
      PARAM_NAMES.forEach((name) => {
        const v = (data.p as Record<string, unknown>)[name];
        if (typeof v === "number" && Number.isFinite(v)) params[name] = v;
      });
    }
    let view: View | null = null;
    if (
      Array.isArray(data.v) &&
      data.v.length === 4 &&
      data.v.every((n) => typeof n === "number" && Number.isFinite(n)) &&
      data.v[0] < data.v[2] &&
      data.v[3] < data.v[1]
    ) {
      view = data.v as View;
    }
    return { slots, params, view, lock: data.r !== 0 };
  } catch {
    return null;
  }
}

/* ───────── Ikon ───────── */

function RatioIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4h16v16H4z M4 20L20 4" />
    </svg>
  );
}

export function GraphPlotterSimulation() {
  const sharedRef = useRef<Shared | null | undefined>(undefined);
  if (sharedRef.current === undefined) sharedRef.current = readShared();
  const shared = sharedRef.current;

  /* ───────── Keadaan tersimpan ───────── */

  const [slots, setSlots] = useStoredSimulationState<Slot[]>(
    "graph-plotter.slots",
    shared?.slots ?? initialSlots,
    !shared,
  );
  const [params, setParams] = useStoredSimulationState<Params>(
    "graph-plotter.params",
    shared?.params ?? DEFAULT_PARAMS,
    !shared,
  );
  const [active, setActive] = useStoredSimulationState(
    "graph-plotter.active-slot",
    0,
    !shared,
  );
  const [storedOptions, setStoredOptions] = useStoredSimulationState<PlotOptions>(
    "graph-plotter.options",
    shared ? { ...initialOptions, lock: shared.lock } : initialOptions,
    !shared,
  );
  const [storedView, setStoredView] = useStoredSimulationState<ViewState>(
    "graph-plotter.view",
    initialView,
  );
  const options = useMemo<PlotOptions>(
    () => ({ ...initialOptions, ...storedOptions }),
    [storedOptions],
  );
  const view = useMemo<ViewState>(
    () => ({ ...initialView, ...storedView }),
    [storedView],
  );

  const [anim, setAnim] = useState<string | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [results, setResults] = useState<Results>({ pairs: [], axes: [] });
  const [message, setMessage] = useState("");

  /* ───────── Data yang dibaca papan (selalu lewat ref agar tidak basi) ───────── */

  const scene = useRef<Scene | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const fnsRef = useRef<(((x: number) => number) | null)[]>(
    Array(MAX_SLOTS).fill(null),
  );
  const derRef = useRef<boolean[]>(Array(MAX_SLOTS).fill(false));
  const interRef = useRef<Pt[]>([]);
  const axisRef = useRef<Pt[][]>(Array.from({ length: MAX_SLOTS }, () => []));
  const extRef = useRef<Pt[][]>(Array.from({ length: MAX_SLOTS }, () => []));
  const pinRef = useRef<Pin[]>([]);
  const traceXRef = useRef(Number.NaN);
  const tanRef = useRef<({ x: number; y: number; m: number } | null)[]>([]);
  const pinIdRef = useRef(1);
  const rafRef = useRef<number | null>(null);
  const lastKeyRef = useRef("");
  // true saat papan sedang digeser: hitung ulang ditunda sampai tombol dilepas
  const panningRef = useRef(false);

  const pRef = useRef<Params>({ ...params });
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const viewRef = useRef(view);
  viewRef.current = view;
  const lockRef = useRef(options.lock);
  lockRef.current = options.lock;

  const parsed = useMemo(
    () => slots.map((slot) => parseLatex(slot.src, pRef.current)),
    [slots],
  );

  const drawn = slots.map((slot, i) => {
    const result = parsed[i];
    return slot.on && !!result && result.ok;
  });
  const drawnCount = drawn.filter(Boolean).length;

  const usedParams = useMemo(() => {
    const set = new Set<string>();
    parsed.forEach((result, i) => {
      if (slots[i]?.on && result && result.ok)
        result.params.forEach((name) => set.add(name));
    });
    return PARAM_NAMES.filter((name) => set.has(name));
  }, [parsed, slots]);

  const setSlot = (index: number, patch: Partial<Slot>) =>
    setSlots((prev) =>
      prev.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)),
    );

  const updateOptions = (patch: Partial<PlotOptions>) =>
    setStoredOptions({ ...optionsRef.current, ...patch });

  const updateView = (patch: Partial<ViewState>) => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setStoredView(next);
  };

  const flash = (text: string) => setMessage(text);

  /* ───────── Papan JSXGraph ───────── */

  function setup(board: SimBoard) {
    const v = viewRef.current;
    if (shared?.view) board.setBoundingBox(shared.view, lockRef.current);

    const grid = board.create("grid", [], {
      strokeColor: "#dcdce2",
      strokeOpacity: 1,
      strokeWidth: 1,
      highlight: false,
    }) as unknown as Settable;

    const axisStyle = {
      strokeColor: "#4a4a55",
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

    // turunan (garis putus-putus)
    const ders = SLOT_COLORS.map(
      (color, i) =>
        board.create(
          "functiongraph",
          [
            (x: number) => {
              const fn = fnsRef.current[i];
              return fn && derRef.current[i] ? derivative(fn, x) : Number.NaN;
            },
          ],
          {
            strokeColor: color,
            strokeWidth: 2,
            dash: 3,
            strokeOpacity: 0.75,
            highlight: false,
          },
        ) as unknown as Settable,
    );

    // garis singgung di posisi pelacak
    const tans = SLOT_COLORS.map(
      (color, i) =>
        board.create(
          "functiongraph",
          [
            (x: number) => {
              const t = tanRef.current[i];
              if (
                !optionsRef.current.tan ||
                !t ||
                !Number.isFinite(traceXRef.current)
              )
                return Number.NaN;
              return t.y + t.m * (x - t.x);
            },
          ],
          {
            strokeColor: color,
            strokeWidth: 1.6,
            dash: 1,
            strokeOpacity: 0.9,
            highlight: false,
          },
        ) as unknown as Settable,
    );

    // grafik fungsi
    const curves = SLOT_COLORS.map(
      (color, i) =>
        board.create(
          "functiongraph",
          [
            (x: number) => {
              const fn = fnsRef.current[i];
              return fn ? fn(x) : Number.NaN;
            },
          ],
          { strokeColor: color, strokeWidth: v.curveWidth, highlight: false },
        ) as unknown as Settable,
    );

    const points: Scene["points"] = [];
    const labels: Settable[] = [];
    const finite = (n: number) => Number.isFinite(n);

    const marker = (
      x: () => number,
      y: () => number,
      color: string,
      extra: number,
      info: boolean,
      face = "o",
      withLabel = false,
    ) => {
      const el = board.create("point", [x, y], {
        name: "",
        withLabel: false,
        size: v.pointSize + extra,
        face,
        fillColor: color,
        strokeColor: "#ffffff",
        strokeWidth: 1.5,
        highlightFillColor: color,
        highlightStrokeColor: "#ffffff",
        fixed: true,
        highlight: info,
        showInfobox: info,
        infoboxDigits: 4,
      }) as unknown as Settable;
      points.push({ el, extra });
      if (withLabel) {
        const label = board.create(
          "text",
          [
            () => (finite(x()) ? x() + 8 / board.unitX : 0),
            () => (finite(y()) ? y() + 6 / board.unitY : 0),
            () =>
              finite(x()) && finite(y()) ? `(${fmt(x())}, ${fmt(y())})` : "",
          ],
          {
            anchorX: "left",
            anchorY: "bottom",
            fontSize: 12,
            strokeColor: color,
            highlight: false,
            fixed: true,
            visible: v.pointLabels,
            cssStyle:
              "font-weight:600;white-space:nowrap;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;",
          },
        ) as unknown as Settable;
        labels.push(label);
      }
    };

    // titik potong sumbu (per grafik)
    SLOT_COLORS.forEach((color, i) => {
      for (let k = 0; k < AXIS_POOL; k += 1) {
        marker(
          () =>
            optionsRef.current.axis
              ? (axisRef.current[i][k]?.x ?? Number.NaN)
              : Number.NaN,
          () =>
            optionsRef.current.axis
              ? (axisRef.current[i][k]?.y ?? Number.NaN)
              : Number.NaN,
          color,
          -0.5,
          true,
        );
      }
    });
    // titik ekstrem (belah ketupat)
    SLOT_COLORS.forEach((color, i) => {
      for (let k = 0; k < EXT_POOL; k += 1) {
        marker(
          () =>
            optionsRef.current.ext
              ? (extRef.current[i][k]?.x ?? Number.NaN)
              : Number.NaN,
          () =>
            optionsRef.current.ext
              ? (extRef.current[i][k]?.y ?? Number.NaN)
              : Number.NaN,
          color,
          1,
          true,
          "<>",
        );
      }
    });
    // titik potong antargrafik
    for (let k = 0; k < INTER_POOL; k += 1) {
      marker(
        () =>
          optionsRef.current.inter
            ? (interRef.current[k]?.x ?? Number.NaN)
            : Number.NaN,
        () =>
          optionsRef.current.inter
            ? (interRef.current[k]?.y ?? Number.NaN)
            : Number.NaN,
        INTER_COLOR,
        1,
        true,
        "o",
        true,
      );
    }
    // titik tersemat (klik)
    for (let k = 0; k < MAX_PINS; k += 1) {
      marker(
        () => pinRef.current[k]?.x ?? Number.NaN,
        () => pinRef.current[k]?.y ?? Number.NaN,
        PIN_COLOR,
        0.5,
        true,
        "[]",
        true,
      );
    }

    // pelacak: garis tegak + titik pada tiap grafik
    board.create(
      "curve",
      [
        () => traceXRef.current,
        (t: number) => t,
        () => board.getBoundingBox()[3],
        () => board.getBoundingBox()[1],
      ],
      { strokeColor: "#63727d", strokeWidth: 1, dash: 2, highlight: false },
    );
    SLOT_COLORS.forEach((color, i) => {
      marker(
        () => (fnsRef.current[i] ? traceXRef.current : Number.NaN),
        () => {
          const fn = fnsRef.current[i];
          return fn && Number.isFinite(traceXRef.current)
            ? fn(traceXRef.current)
            : Number.NaN;
        },
        color,
        0,
        false,
      );
    });

    board.on("boundingbox", scheduleRecompute);

    scene.current = {
      grid,
      axes: [xAxis, yAxis],
      curves,
      ders,
      tans,
      points,
      labels,
    };
    applyView();
  }

  const { boardProps, boardRef, zoomIn: hookZoomIn, zoomOut: hookZoomOut } =
    useJsxBoard({
      boundingBox: HOME_BOX,
      setup,
      zoomRange: [0.001, 1000],
      keepAspectRatio: options.lock,
    });
  const containerRef = boardProps.ref;

  /** Menerapkan toggle tampilan, ketebalan garis, dan ukuran titik ke papan. */
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
    const thin = Math.max(1.5, v.curveWidth * 0.6);
    s.curves.forEach((c) => c.setAttribute({ strokeWidth: v.curveWidth }));
    s.ders.forEach((c) => c.setAttribute({ strokeWidth: thin }));
    s.tans.forEach((c) => c.setAttribute({ strokeWidth: Math.max(1.2, thin - 0.4) }));
    s.points.forEach(({ el, extra }) =>
      el.setAttribute({ size: Math.max(1.5, v.pointSize + extra) }),
    );
    s.labels.forEach((l) => l.setAttribute({ visible: v.pointLabels }));
    boardRef.current?.update();
  }

  /* ───────── Pelacak ───────── */

  // Nilai f(x) dan gradien semua grafik pada satu x (juga menyiapkan garis singgung)
  const traceRows = (x: number): TraceRow[] => {
    const rows: TraceRow[] = [];
    const tans: ({ x: number; y: number; m: number } | null)[] = [];
    fnsRef.current.forEach((fn, i) => {
      if (!fn) {
        tans[i] = null;
        return;
      }
      const y = fn(x);
      const dy = derivative(fn, x);
      tans[i] =
        Number.isFinite(y) && Number.isFinite(dy) ? { x, y, m: dy } : null;
      rows.push({ i, y, dy });
    });
    tanRef.current = tans;
    return rows;
  };

  const applyTrace = (x: number | null) => {
    const board = boardRef.current;
    if (!board) return;
    if (x === null || !Number.isFinite(x)) {
      traceXRef.current = Number.NaN;
      tanRef.current = [];
      board.update();
      setTrace(null);
      return;
    }
    traceXRef.current = x;
    const rows = traceRows(x);
    board.update();
    setTrace({ x, rows });
  };

  /* ───────── Titik potong, ekstrem, dan titik potong sumbu ───────── */

  // Dihitung pada rentang yang sedang terlihat.
  const recompute = () => {
    const board = boardRef.current;
    if (!board) return;
    const [x1, y1, x2, y2] = board.getBoundingBox();
    const ySpan = Math.abs(y1 - y2);
    const cx = (x1 + x2) / 2;
    const fns = fnsRef.current;

    const pairs: PairResult[] = [];
    const flat: Pt[] = [];
    for (let i = 0; i < MAX_SLOTS; i += 1) {
      for (let j = i + 1; j < MAX_SLOTS; j += 1) {
        const fi = fns[i];
        const fj = fns[j];
        if (!fi || !fj) continue;
        const { roots, coincident } = findRoots(
          (x) => fi(x) - fj(x),
          x1,
          x2,
          2500,
        );
        const pts = roots
          .map((x) => ({ x, y: (fi(x) + fj(x)) / 2 }))
          .filter((p) => Number.isFinite(p.y));
        pairs.push({ i, j, pts, coincident });
        pts.forEach((p) => flat.push(p));
      }
    }

    const axes: AxisResult[] = [];
    const axisPts: Pt[][] = Array.from({ length: MAX_SLOTS }, () => []);
    const extPts: Pt[][] = Array.from({ length: MAX_SLOTS }, () => []);
    fns.forEach((fn, i) => {
      if (!fn) return;
      const y0 = fn(0);
      const yInt = Number.isFinite(y0) ? { x: 0, y: y0 } : null;
      const { roots, coincident } = findRoots(fn, x1, x2, 2500);
      const xInts = coincident ? [] : roots.map((x) => ({ x, y: 0 }));
      let ext: Extremum[] = [];
      if (optionsRef.current.ext) {
        ext = findExtrema(fn, x1, x2, ySpan)
          .sort((p, q) => Math.abs(p.x - cx) - Math.abs(q.x - cx))
          .slice(0, EXT_POOL)
          .sort((p, q) => p.x - q.x);
      }
      axes.push({ i, yInt, xInts, ext });
      if (yInt) axisPts[i].push(yInt);
      xInts.slice(0, AXIS_POOL - 1).forEach((p) => axisPts[i].push(p));
      ext.forEach((p) => extPts[i].push({ x: p.x, y: p.y }));
    });

    interRef.current = flat.slice(0, INTER_POOL);
    axisRef.current = axisPts;
    extRef.current = extPts;
    board.update();

    const key = JSON.stringify({ pairs, axes });
    if (key !== lastKeyRef.current) {
      lastKeyRef.current = key;
      setResults({ pairs, axes });
    }
  };

  const scheduleRecompute = () => {
    if (panningRef.current) return;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      recompute();
    });
  };

  /* ───────── Navigasi tampilan ───────── */

  const zoomIn = () => {
    hookZoomIn();
    scheduleRecompute();
  };
  const zoomOut = () => {
    hookZoomOut();
    scheduleRecompute();
  };
  const resetView = () => {
    boardRef.current?.setBoundingBox(HOME_BOX, lockRef.current);
    scheduleRecompute();
  };
  const panBy = (fx: number, fy: number) => {
    const board = boardRef.current;
    if (!board) return;
    const [x1, y1, x2, y2] = board.getBoundingBox();
    const dx = (x2 - x1) * fx;
    const dy = (y1 - y2) * fy;
    board.setBoundingBox([x1 + dx, y1 + dy, x2 + dx, y2 + dy], lockRef.current);
    scheduleRecompute();
  };

  // Sesuaikan tinggi jendela dengan nilai grafik (kebal terhadap asimtot)
  const fitView = () => {
    const board = boardRef.current;
    if (!board) return;
    const [x1, , x2] = board.getBoundingBox();
    const ys: number[] = [];
    fnsRef.current.forEach((fn) => {
      if (!fn) return;
      for (let k = 0; k <= 400; k += 1) {
        const value = fn(x1 + ((x2 - x1) * k) / 400);
        if (Number.isFinite(value)) ys.push(value);
      }
    });
    if (ys.length < 2) return;
    ys.sort((p, q) => p - q);
    const lo = ys[Math.floor(ys.length * 0.03)];
    const hi = ys[Math.ceil(ys.length * 0.97) - 1];
    const span = hi - lo < 1e-6 ? 2 : hi - lo;
    const mid = (hi + lo) / 2;
    const half = span * 0.65;
    lockRef.current = false;
    updateOptions({ lock: false });
    board.setBoundingBox([x1, mid + half, x2, mid - half], false);
    scheduleRecompute();
  };

  /* ───────── Ekspor dan tautan ───────── */

  const exportPng = () => {
    const svg = containerRef.current?.querySelector("svg");
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(w));
    clone.setAttribute("height", String(h));
    const xml = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) {
          flash("Gagal membuat gambar.");
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "grafik.png";
        link.click();
        URL.revokeObjectURL(url);
        flash("Gambar diunduh.");
      }, "image/png");
    };
    img.onerror = () => flash("Gagal membuat gambar.");
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  };

  const copyLink = () => {
    const board = boardRef.current;
    const box = board
      ? (board
          .getBoundingBox()
          .map((n: number) => Math.round(n * 1e4) / 1e4) as View)
      : undefined;
    const payload = {
      s: slots.map((slot) => [slot.src, slot.on ? 1 : 0, slot.der ? 1 : 0]),
      p: params,
      v: box,
      r: options.lock ? 1 : 0,
    };
    const url = new URL(window.location.href);
    url.searchParams.set("grafik", toB64(JSON.stringify(payload)));
    const text = url.toString();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => flash("Tautan disalin."),
        () => window.prompt("Salin tautan ini:", text),
      );
    } else {
      window.prompt("Salin tautan ini:", text);
    }
  };

  const onBoardKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 0.4 : 0.1;
    switch (event.key) {
      case "ArrowLeft":
        panBy(-step, 0);
        break;
      case "ArrowRight":
        panBy(step, 0);
        break;
      case "ArrowUp":
        panBy(0, step);
        break;
      case "ArrowDown":
        panBy(0, -step);
        break;
      case "+":
      case "=":
        zoomIn();
        break;
      case "-":
      case "_":
        zoomOut();
        break;
      case "0":
        resetView();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  /* ───────── Masukan fungsi ───────── */

  const insertSnippet = (snippet: string) => {
    const index = Math.min(active, slots.length - 1);
    const el = inputRefs.current[index];
    const cursor = snippet.indexOf("§");
    const clean = snippet.replace("§", "");
    const src = slots[index].src;
    const start = el?.selectionStart ?? src.length;
    const end = el?.selectionEnd ?? start;
    setSlot(index, {
      src: src.slice(0, start) + clean + src.slice(end),
      on: true,
    });
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + (cursor >= 0 ? cursor : clean.length);
      el?.setSelectionRange(pos, pos);
    });
  };

  const applyPreset = (preset: Preset) => {
    setSlots(
      preset.srcs
        .slice(0, MAX_SLOTS)
        .map((src) => ({ src, on: true, der: !!preset.der })),
    );
    if (preset.params) setParams((prev) => ({ ...prev, ...preset.params }));
    setPins([]);
    setActive(0);
    setAnim(null);
    resetView();
  };

  const addSlot = () => {
    if (slots.length >= MAX_SLOTS) return;
    setSlots((prev) => [...prev, { src: "", on: true, der: false }]);
    setActive(slots.length);
    requestAnimationFrame(() => inputRefs.current[slots.length]?.focus());
  };

  const removeSlot = (index: number) => {
    if (slots.length <= 1) return;
    setSlots((prev) => prev.filter((_, i) => i !== index));
    setActive((a) =>
      Math.max(0, Math.min(a > index ? a - 1 : a, slots.length - 2)),
    );
    setPins((prev) =>
      prev.map((pin) =>
        pin.slot === null
          ? pin
          : pin.slot === index
            ? { ...pin, slot: null, slope: null }
            : pin.slot > index
              ? { ...pin, slot: pin.slot - 1 }
              : pin,
      ),
    );
  };

  const setParam = (name: string, value: number) =>
    setParams((prev) => ({ ...prev, [name]: value }));

  const resetAll = () => {
    setSlots(initialSlots);
    setParams(DEFAULT_PARAMS);
    setPins([]);
    setActive(0);
    setAnim(null);
    resetView();
  };

  /* ───────── Interaksi pointer: pelacak, klik untuk menyematkan ───────── */

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const toUsr = (e: { clientX: number; clientY: number }) => {
      const board = boardRef.current;
      if (!board) return null;
      const r = el.getBoundingClientRect();
      const [x1, y1, x2, y2] = board.getBoundingBox();
      return {
        x: x1 + ((e.clientX - r.left) / r.width) * (x2 - x1),
        y: y1 - ((e.clientY - r.top) / r.height) * (y1 - y2),
        w: r.width,
        h: r.height,
        x1,
        y1,
        x2,
        y2,
      };
    };

    let traceRaf: number | null = null;
    let pendingX: number | null = null;
    const queueTrace = (x: number | null) => {
      pendingX = x;
      if (traceRaf !== null) return;
      traceRaf = requestAnimationFrame(() => {
        traceRaf = null;
        applyTrace(pendingX);
      });
    };

    const handleClick = (e: PointerEvent) => {
      const u = toUsr(e);
      if (!u) return;
      const sx = u.w / (u.x2 - u.x1);
      const sy = u.h / (u.y1 - u.y2);
      type Cand = { x: number; y: number; slot: number | null; d: number };
      const specials: Cand[] = [];
      const curves: Cand[] = [];
      const consider = (
        list: Cand[],
        x: number,
        y: number,
        slot: number | null,
        tol: number,
      ) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const d = Math.hypot((x - u.x) * sx, (y - u.y) * sy);
        if (d <= tol) list.push({ x, y, slot, d });
      };
      if (optionsRef.current.inter)
        interRef.current.forEach((p) => consider(specials, p.x, p.y, null, 16));
      if (optionsRef.current.axis)
        axisRef.current.forEach((arr, i) =>
          arr.forEach((p) => consider(specials, p.x, p.y, i, 14)),
        );
      if (optionsRef.current.ext)
        extRef.current.forEach((arr, i) =>
          arr.forEach((p) => consider(specials, p.x, p.y, i, 14)),
        );
      fnsRef.current.forEach((fn, i) => {
        if (!fn) return;
        const y = fn(u.x);
        if (!Number.isFinite(y)) return;
        const d = Math.abs(y - u.y) * sy;
        if (d <= 26) curves.push({ x: u.x, y, slot: i, d });
      });
      const pool = specials.length > 0 ? specials : curves;
      if (pool.length === 0) {
        if (e.pointerType === "touch") queueTrace(u.x);
        return;
      }
      const best = pool.reduce((p, q) => (q.d < p.d ? q : p));
      const fn = best.slot !== null ? fnsRef.current[best.slot] : null;
      const slope = fn ? derivative(fn, best.x) : null;
      if (e.pointerType === "touch") queueTrace(best.x);
      setPins((prev) => {
        const dup = prev.some(
          (p) => Math.abs(p.x - best.x) < 1e-9 && Math.abs(p.y - best.y) < 1e-9,
        );
        if (dup) return prev;
        const next = [
          ...prev,
          {
            id: pinIdRef.current++,
            x: best.x,
            y: best.y,
            slot: best.slot,
            slope: slope !== null && Number.isFinite(slope) ? slope : null,
          },
        ];
        return next.slice(-MAX_PINS);
      });
    };

    // Geser dan zoom ditangani JSXGraph; di sini hanya dipantau agar
    // perhitungan titik ditunda sampai geser selesai dan klik bisa dikenali.
    const pointers = new Set<number>();
    let down: { x: number; y: number } | null = null;

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointers.add(e.pointerId);
      panningRef.current = true;
      down = pointers.size === 1 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons !== 0) {
        if (!Number.isNaN(traceXRef.current)) queueTrace(null);
        return;
      }
      // Kursor hanya menampilkan titik/nilai bila opsi garis singgung aktif.
      if (!optionsRef.current.tan) return;
      const u = toUsr(e);
      if (u) queueTrace(u.x);
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== "touch") queueTrace(null);
    };
    const onWinUp = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      const start = down;
      down = null;
      if (pointers.size === 0 && panningRef.current) {
        panningRef.current = false;
        scheduleRecompute();
      }
      if (!start || e.type === "pointercancel") return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) >= 5) return;
      if (!el.contains(e.target as Node)) return;
      handleClick(e);
    };
    const onWheel = () => {
      scheduleRecompute();
      if (!Number.isNaN(traceXRef.current)) queueTrace(null);
    };

    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointermove", onMove, true);
    el.addEventListener("pointerleave", onLeave);
    window.addEventListener("pointerup", onWinUp);
    window.addEventListener("pointercancel", onWinUp);
    el.addEventListener("wheel", onWheel, { passive: true });
    const observer = new ResizeObserver(() => scheduleRecompute());
    observer.observe(el);

    return () => {
      observer.disconnect();
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointermove", onMove, true);
      el.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointerup", onWinUp);
      window.removeEventListener("pointercancel", onWinUp);
      el.removeEventListener("wheel", onWheel);
      if (traceRaf !== null) cancelAnimationFrame(traceRaf);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      panningRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ───────── Sinkronisasi ke papan ───────── */

  // Sinkronkan fungsi yang aktif ke papan lalu hitung ulang
  useEffect(() => {
    Object.assign(pRef.current, params);
    fnsRef.current = Array.from({ length: MAX_SLOTS }, (_, i) => {
      const slot = slots[i];
      const result = parsed[i];
      return slot && slot.on && result && result.ok ? result.fn : null;
    });
    derRef.current = Array.from(
      { length: MAX_SLOTS },
      (_, i) => !!slots[i]?.der,
    );
    boardRef.current?.update();
    recompute();
    if (Number.isFinite(traceXRef.current)) {
      setTrace({ x: traceXRef.current, rows: traceRows(traceXRef.current) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, parsed, params, options.inter, options.axis, options.ext, options.tan]);

  useEffect(() => {
    if (!options.tan) {
      traceXRef.current = Number.NaN;
      tanRef.current = [];
      boardRef.current?.update();
      setTrace(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.tan]);

  useEffect(() => {
    applyView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    pinRef.current = pins;
    boardRef.current?.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins]);

  // Kunci / lepas rasio 1 : 1
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const raw = board as unknown as {
      keepaspectratio?: boolean;
      attr?: { keepaspectratio?: boolean };
    };
    raw.keepaspectratio = options.lock;
    if (raw.attr) raw.attr.keepaspectratio = options.lock;
    if (options.lock) board.setBoundingBox(board.getBoundingBox(), true);
    scheduleRecompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.lock]);

  // Animasi parameter (bolak-balik antara PARAM_MIN dan PARAM_MAX)
  useEffect(() => {
    if (!anim) return undefined;
    let raf = 0;
    let last = performance.now();
    let dir = 1;
    let value = pRef.current[anim] ?? 1;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      value += dir * dt * PARAM_SPEED;
      if (value >= PARAM_MAX) {
        value = PARAM_MAX;
        dir = -1;
      } else if (value <= PARAM_MIN) {
        value = PARAM_MIN;
        dir = 1;
      }
      const rounded = Math.round(value * 100) / 100;
      setParams((prev) => ({ ...prev, [anim]: rounded }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anim]);

  useEffect(() => {
    if (anim && !usedParams.includes(anim as (typeof PARAM_NAMES)[number]))
      setAnim(null);
  }, [anim, usedParams]);

  useEffect(() => {
    if (!message) return undefined;
    const timer = window.setTimeout(() => setMessage(""), 2400);
    return () => window.clearTimeout(timer);
  }, [message]);

  /* ───────── Nilai turunan ───────── */

  const pairList = results.pairs.filter(
    (pair) => drawn[pair.i] && drawn[pair.j],
  );
  const tableAxes = results.axes.filter((axis) => drawn[axis.i]);
  const activeSlot = Math.min(active, slots.length - 1);
  const hasSpecial = options.axis || options.ext;

  /* ───────── Tampilan ───────── */

  return (
    <SimulationShell
      title="Penggambar grafik"
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
          <SimToggle
            icon={<RatioIcon />}
            label="Skala 1 : 1"
            pressed={options.lock}
            onClick={() => updateOptions({ lock: !options.lock })}
          />
          <button
            type="button"
            className="sim-btn"
            aria-label="Sesuaikan tinggi jendela dengan nilai grafik"
            title="Sesuaikan tinggi jendela dengan nilai grafik"
            onClick={fitView}
          >
            <ArrowUpDown size={17} aria-hidden="true" />
            <span className="sim-btn__label">Sesuaikan tinggi</span>
          </button>
        </>
      }
      settings={
        <SimSection title="Garis dan titik">
          <SimSlider
            id="plot-curve-width"
            name="tebal kurva"
            label={`Tebal kurva: ${view.curveWidth}`}
            value={view.curveWidth}
            min={1}
            max={8}
            step={1}
            onChange={(curveWidth) => updateView({ curveWidth })}
          />
          <SimSlider
            id="plot-point-size"
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
          <button
            type="button"
            className="sim-text-btn sim-text-btn--icon"
            onClick={exportPng}
          >
            <Download size={14} aria-hidden="true" />
            Unduh PNG
          </button>
          <button
            type="button"
            className="sim-text-btn sim-text-btn--icon"
            onClick={copyLink}
          >
            <Link2 size={14} aria-hidden="true" />
            Salin tautan
          </button>
        </SimSection>
      }
      graph={
        <>
          <div
            {...boardProps}
            role="group"
            tabIndex={0}
            onKeyDown={onBoardKey}
            aria-label="Grafik hingga enam fungsi. Seret untuk menggeser, roda mouse atau cubit untuk zoom, ketuk atau klik untuk menyematkan titik. Tombol panah menggeser, plus dan minus memperbesar atau memperkecil, nol mengembalikan tampilan."
          />

          {drawnCount === 0 && (
            <p className="sim-empty">
              Ketik rumus di panel <strong>&nbsp;Fungsi&nbsp;</strong> untuk
              mulai menggambar.
            </p>
          )}

          {trace && trace.rows.length > 0 && (
            <div className="sim-trace" aria-live="off">
              <b>x = {fmt(trace.x)}</b>
              {trace.rows.map((row) => (
                <span key={row.i}>
                  <i
                    className="sim-swatch"
                    style={{ background: SLOT_COLORS[row.i] }}
                  />
                  y = {fmt(row.y)} <small>gradien {fmt(row.dy)}</small>
                </span>
              ))}
            </div>
          )}

          {message && (
            <p className="sim-toast" role="status">
              {message}
            </p>
          )}
        </>
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          {drawnCount === 0 ? (
            <span>Belum ada grafik</span>
          ) : (
            slots.map((slot, i) =>
              drawn[i] ? (
                <span
                  key={i}
                  style={{ color: SLOT_COLORS[i], marginRight: 14 }}
                >
                  <SimMath tex={`y=${slot.src}`} />
                </span>
              ) : null,
            )
          )}
        </p>
      }
      panel={
        <>
          <SimSection title="Fungsi">
            <ul className="sim-rows">
              {slots.map((slot, i) => {
                const result = parsed[i];
                const isError = !!result && !result.ok;
                const statusId = `plot-status-${i}`;
                return (
                  <SimRow
                    key={i}
                    color={SLOT_COLORS[i]}
                    visible={slot.on}
                    onToggle={() => setSlot(i, { on: !slot.on })}
                    toggleLabel={`Tampilkan atau sembunyikan grafik ${i + 1}`}
                  >
                    <div className="sim-slot">
                      <input
                        id={`plot-src-${i}`}
                        ref={(el) => {
                          inputRefs.current[i] = el;
                        }}
                        className="sim-input"
                        type="text"
                        value={slot.src}
                        placeholder={`y = ${PLACEHOLDERS[i]}`}
                        spellCheck={false}
                        autoComplete="off"
                        autoCapitalize="off"
                        aria-label={`Rumus grafik ${i + 1}, y sama dengan`}
                        aria-invalid={isError}
                        aria-describedby={statusId}
                        onFocus={() => setActive(i)}
                        onChange={(event) =>
                          setSlot(i, { src: event.currentTarget.value })
                        }
                      />
                      <button
                        type="button"
                        className="sim-chip"
                        aria-pressed={slot.der}
                        aria-label={`Gambar turunan grafik ${i + 1}`}
                        title="Gambar turunan f′(x) sebagai garis putus-putus"
                        onClick={() => setSlot(i, { der: !slot.der })}
                      >
                        f′
                      </button>
                      {slots.length > 1 && (
                        <button
                          type="button"
                          className="sim-icon-btn"
                          aria-label={`Hapus grafik ${i + 1}`}
                          title="Hapus grafik ini"
                          onClick={() => removeSlot(i)}
                        >
                          <X size={13} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <p
                      id={statusId}
                      className={`sim-status${isError ? " is-error" : ""}`}
                    >
                      {!result
                        ? "Kosong: grafik tidak digambar."
                        : result.ok
                          ? `Terbaca: y = ${result.text}`
                          : result.error}
                    </p>
                  </SimRow>
                );
              })}
            </ul>

            {slots.length < MAX_SLOTS && (
              <button
                type="button"
                className="sim-text-btn sim-text-btn--icon"
                onClick={addSlot}
              >
                <Plus size={14} aria-hidden="true" />
                Tambah grafik
              </button>
            )}

            <h3 className="sim-section__title" style={{ marginTop: 8 }}>
              Sisipkan ke grafik {activeSlot + 1}
            </h3>
            <div className="sim-chips" role="group" aria-label="Sisipkan rumus">
              {SNIPPETS.map((snippet) => (
                <button
                  key={snippet.label}
                  type="button"
                  className="sim-chip"
                  title={snippet.title}
                  aria-label={snippet.title}
                  // mencegah papan ketik layar menutup saat menyisipkan
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => insertSnippet(snippet.text)}
                >
                  {snippet.label}
                </button>
              ))}
            </div>
          </SimSection>

          {usedParams.length > 0 && (
            <SimSection title="Parameter">
              {usedParams.map((name) => (
                <SimSlider
                  key={name}
                  id={`plot-par-${name}`}
                  name={name}
                  label={<SimMath tex={`${name}=${texNum(params[name] ?? 1)}`} />}
                  accent={PARAM_COLOR}
                  value={clamp(params[name] ?? 1, PARAM_MIN, PARAM_MAX)}
                  min={PARAM_MIN}
                  max={PARAM_MAX}
                  step={0.1}
                  valueText={`${name} sama dengan ${fmt(params[name] ?? 1, 2)}`}
                  onChange={(value) => {
                    setAnim(null);
                    setParam(name, value);
                  }}
                />
              ))}
              <div className="sim-chips" role="group" aria-label="Animasikan parameter">
                {usedParams.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="sim-chip"
                    aria-pressed={anim === name}
                    aria-label={
                      anim === name
                        ? `Hentikan animasi ${name}`
                        : `Animasikan ${name}`
                    }
                    onClick={() => setAnim(anim === name ? null : name)}
                  >
                    {anim === name ? (
                      <Pause size={11} aria-hidden="true" />
                    ) : (
                      <Play size={11} aria-hidden="true" />
                    )}{" "}
                    {name}
                  </button>
                ))}
              </div>
            </SimSection>
          )}

          <SimSection title="Hasil">
            {pins.length > 0 && (
              <>
                <div className="sim-subhead">
                  <span>Titik tersemat</span>
                  <button
                    type="button"
                    className="sim-link"
                    onClick={() => setPins([])}
                  >
                    Hapus semua
                  </button>
                </div>
                <ul className="sim-rows">
                  {pins.map((pin) => (
                    <SimRow
                      key={pin.id}
                      color={pin.slot === null ? INTER_COLOR : SLOT_COLORS[pin.slot]}
                    >
                      <span>{ptText(pin)}</span>
                      {pin.slope !== null && (
                        <small className="sim-muted">
                          {" "}
                          gradien {fmt(pin.slope)}
                        </small>
                      )}
                      <button
                        type="button"
                        className="sim-icon-btn"
                        aria-label={`Hapus titik ${ptText(pin)}`}
                        onClick={() =>
                          setPins((prev) => prev.filter((p) => p.id !== pin.id))
                        }
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </SimRow>
                  ))}
                </ul>
              </>
            )}

            {drawnCount < 2 && (
              <p className="sim-hint" role="status">
                Aktifkan dan isi minimal dua grafik untuk melihat titik potong
                antargrafik.
              </p>
            )}

            <div aria-live="polite">
              {pairList.map((pair) => (
                <div className="sim-result" key={`${pair.i}-${pair.j}`}>
                  <div className="sim-result__head">
                    <i
                      className="sim-swatch"
                      style={{ background: SLOT_COLORS[pair.i] }}
                    />
                    <i
                      className="sim-swatch"
                      style={{ background: SLOT_COLORS[pair.j] }}
                    />
                    Grafik {pair.i + 1} ∩ Grafik {pair.j + 1}
                  </div>
                  {pair.coincident ? (
                    <p className="sim-result__note">Berimpit</p>
                  ) : pair.pts.length === 0 ? (
                    <p className="sim-result__note">Tidak berpotongan</p>
                  ) : (
                    <div className="sim-points">
                      {pair.pts.slice(0, 8).map((p, k) => (
                        <span key={k}>{ptText(p)}</span>
                      ))}
                    </div>
                  )}
                  {!pair.coincident && (
                    <small className="sim-muted">
                      {pair.pts.length > 8
                        ? `${pair.pts.length} titik (8 pertama ditampilkan)`
                        : `${pair.pts.length} titik pada tampilan`}
                    </small>
                  )}
                </div>
              ))}

              {hasSpecial &&
                tableAxes.map((axis) => (
                  <div className="sim-result" key={`axis-${axis.i}`}>
                    <div className="sim-result__head">
                      <i
                        className="sim-swatch"
                        style={{ background: SLOT_COLORS[axis.i] }}
                      />
                      Grafik {axis.i + 1}: titik istimewa
                    </div>
                    {options.axis && (
                      <p className="sim-result__note">
                        Sumbu y: {axis.yInt ? ptText(axis.yInt) : "tidak ada"}
                        <br />
                        Sumbu x:{" "}
                        {axis.xInts.length === 0
                          ? "tidak ada"
                          : axis.xInts
                              .slice(0, 6)
                              .map((p) => ptText(p))
                              .join("  ")}
                      </p>
                    )}
                    {options.ext && (
                      <p className="sim-result__note">
                        Maks / min:{" "}
                        {axis.ext.length === 0
                          ? "tidak ada"
                          : axis.ext
                              .map(
                                (p) =>
                                  `${p.kind === "max" ? "maks" : "min"} ${ptText(p)}`,
                              )
                              .join("  ")}
                      </p>
                    )}
                  </div>
                ))}
            </div>
          </SimSection>

          <SimSection title="Tampilkan">
            <ul className="sim-rows">
              <SimRow
                color={INTER_COLOR}
                visible={options.inter}
                onToggle={() => updateOptions({ inter: !options.inter })}
                toggleLabel="Tampilkan atau sembunyikan titik potong antargrafik"
              >
                <span>Titik potong antargrafik</span>
              </SimRow>
              <SimRow
                color={AXIS_COLOR}
                visible={options.axis}
                onToggle={() => updateOptions({ axis: !options.axis })}
                toggleLabel="Tampilkan atau sembunyikan titik potong sumbu x dan y"
              >
                <span>Titik potong sumbu x dan y</span>
              </SimRow>
              <SimRow
                color={EXT_COLOR}
                visible={options.ext}
                onToggle={() => updateOptions({ ext: !options.ext })}
                toggleLabel="Tampilkan atau sembunyikan titik maksimum dan minimum"
              >
                <span>Titik maksimum / minimum</span>
              </SimRow>
              <SimRow
                color={TRACE_COLOR}
                visible={options.tan}
                onToggle={() => updateOptions({ tan: !options.tan })}
                toggleLabel="Aktifkan atau matikan garis singgung dan nilai y di posisi kursor"
              >
                <span>Garis singgung &amp; nilai y di kursor</span>
              </SimRow>
            </ul>
          </SimSection>

          <SimSection title="Contoh cepat">
            <div className="sim-chips" role="group" aria-label="Contoh cepat">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="sim-chip"
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </SimSection>

          <SimSection title="Panduan">
            <details className="sim-guide">
              <summary>Notasi dan cara pakai</summary>
              <table className="sim-table sim-table--left">
                <thead>
                  <tr>
                    <th scope="col">Yang ingin ditulis</th>
                    <th scope="col">Ketik</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Pangkat</th>
                    <td>
                      <code>x^2</code>, <code>{"x^{-3}"}</code>, <code>2^x</code>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Pecahan</th>
                    <td>
                      <code>{"\\frac{x+1}{x-2}"}</code>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Akar</th>
                    <td>
                      <code>{"\\sqrt{x+1}"}</code>, <code>{"\\sqrt[3]{x}"}</code>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">e dan π</th>
                    <td>
                      <code>{"e^{x}"}</code>, <code>{"e^{-x^2}"}</code>,{" "}
                      <code>{"\\pi"}</code>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Trigonometri (radian)</th>
                    <td>
                      <code>{"\\sin x"}</code>, <code>{"\\sin^2 x"}</code>,{" "}
                      <code>{"\\cos(2x)"}</code>, <code>{"\\sin^{-1} x"}</code>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Logaritma</th>
                    <td>
                      <code>{"\\ln x"}</code>, <code>{"\\log x"}</code> (basis
                      10), <code>{"\\log_{2} x"}</code>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Nilai mutlak</th>
                    <td>
                      <code>{"|x-3|"}</code> atau{" "}
                      <code>{"\\left|x-3\\right|"}</code>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Perkalian</th>
                    <td>
                      <code>2x</code>, <code>(x+1)(x-1)</code>,{" "}
                      <code>{"x\\cdot 2"}</code>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Parameter (slider)</th>
                    <td>
                      <code>ax^2+bx+c</code>, <code>{"a\\sin(kx)"}</code>; huruf
                      a, b, c, k otomatis menjadi slider
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Mouse dan sentuh</th>
                    <td>
                      seret = geser, roda atau cubit = zoom, klik atau ketuk =
                      sematkan titik
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Papan fokus</th>
                    <td>
                      panah = geser (Shift = lebih jauh), <code>+</code> /{" "}
                      <code>−</code> = zoom, <code>0</code> = reset
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="sim-hint">
                Gunakan kurung kurawal untuk pangkat lebih dari satu karakter,
                misalnya <code>{"x^{10}"}</code>. Variabel utama adalah x;
                awalan <code>y =</code> atau <code>f(x) =</code> boleh ditulis.
                Akar ganjil bilangan negatif dihitung, jadi{" "}
                <code>{"x^{1/3}"}</code> terdefinisi untuk x negatif. Turunan
                dan gradien dihitung secara numerik. “Salin tautan” (menu
                pengaturan) menyalin alamat halaman berisi rumus, nilai
                parameter, dan tampilan saat ini.
              </p>
            </details>
          </SimSection>
        </>
      }
      notes={
        <>
          <p style={{ margin: 0 }}>
            <strong style={{ color: INTER_COLOR }}>Titik potong </strong>
            adalah nilai x yang memenuhi{" "}
            <SimMath tex="f_1(x)=f_2(x)" />. Program mencarinya secara numerik
            pada rentang x yang sedang terlihat, jadi geser atau zoom keluar
            untuk menemukan titik di luar layar.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: SLOT_COLORS[0] }}>
              Parameter dan turunan:{" "}
            </strong>
            coba <SimMath tex="y=ax^{2}+bx+c" /> lalu animasikan a, atau centang
            f′ untuk melihat bagaimana tanda turunan menentukan fungsi naik atau
            turun, dan f′ = 0 di titik maksimum/minimum.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: SLOT_COLORS[1] }}>Asimtot dan lubang: </strong>
            titik tidak ditandai di tempat fungsi tidak terdefinisi, misalnya x =
            0 pada <SimMath tex={String.raw`\dfrac{1}{x}`} /> atau x = π/2 pada
            tan x.
          </p>
        </>
      }
    />
  );
}
