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

/* Simulasi irisan kerucut.
   Kerangka, slider, dan CSS memakai kit umum (prefix sim-), sama seperti
   simulasi fungsi kuadrat, turunan, dan integral.

   Satu keluarga kurva dengan fokus di titik asal (0, 0):

       r = ℓ / (1 − e cos θ)

   e = eksentrisitas, ℓ = setengah lebar fokal (semi latus rectum).
   e = 0 lingkaran, 0 < e < 1 elips, e = 1 parabola, e > 1 hiperbola.
   Setiap titik P memenuhi  PF = e · (jarak P ke direktriks).
   Persamaan umum: (1 − e²)x² − 2eℓx + y² = ℓ². */

/* ───────── Tipe & konstanta ───────── */

type Vec = [number, number];
type Sample = [number, number, number]; // x, y, θ (derajat)
type Kind = "circle" | "ellipse" | "parabola" | "hyperbola";
type Anim = "e" | "t" | null;
type Params = { e: number; l: number; t: number };
type ObjectKey =
  | "curve"
  | "ghost"
  | "focus"
  | "directrix"
  | "guide"
  | "point"
  | "tangent";
type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean;
  curveWidth: number;
  pointSize: number;
  show: Record<ObjectKey, boolean>;
};

const EPS = 1e-9;
const E_RANGE = [0, 3] as const;
const L_RANGE = [0.5, 10] as const;
const T_RANGE = [-180, 180] as const;

const initialParams: Params = { e: 0.6, l: 4, t: 60 };
const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: true,
  curveWidth: 3,
  pointSize: 4,
  show: {
    curve: true,
    ghost: true,
    focus: true,
    directrix: true,
    guide: false,
    point: true,
    tangent: true,
  },
};
const initialBox: BoundingBox = [-10, 10, 16, -10];

const KINDS: Record<Kind, { label: string; color: string; e: number }> = {
  circle: { label: "Lingkaran", color: "#00897b", e: 0 },
  ellipse: { label: "Elips", color: "#6557d2", e: 0.6 },
  parabola: { label: "Parabola", color: "#e65100", e: 1 },
  hyperbola: { label: "Hiperbola", color: "#c62828", e: 2 },
};
const KIND_ORDER: Kind[] = ["circle", "ellipse", "parabola", "hyperbola"];

const colors = {
  l: "#2e7d32",
  t: "#1565c0",
  focus: "#232329",
  directrix: "#c28a00",
  tangent: "#087f8c",
  guide: "#8f8f99",
  grid: "#dcdce2",
  axis: "#4a4a55",
};

type Settable = { setAttribute: (attributes: Record<string, unknown>) => unknown };
type AxisElement = Settable & { defaultTicks: Settable };
type DataCurve = Settable & {
  dataX: number[];
  dataY: number[];
  updateDataArray: () => void;
};
type Marker = { point: Settable; label: Settable };
type Scene = {
  grid: Settable;
  axes: AxisElement[];
  main: DataCurve[];
  ghosts: DataCurve[];
  directrices: DataCurve[];
  asymptotes: DataCurve[];
  tangent: DataCurve;
  segments: DataCurve[];
  foci: Marker[];
  center: Marker;
  vertices: Marker[];
  p: Marker;
};

const finite = (value: number) => Number.isFinite(value);
const round = (value: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/* ───────── Matematika ───────── */

function kindOf(e: number): Kind {
  if (e < EPS) return "circle";
  if (Math.abs(e - 1) < EPS) return "parabola";
  return e < 1 ? "ellipse" : "hyperbola";
}

function analyze({ e, l, t }: Params) {
  const kind = kindOf(e);
  const e2 = e * e;
  let a = Number.NaN;
  let b = Number.NaN;
  let c = 0;
  let x0 = Number.NaN;
  if (kind === "circle") {
    a = l;
    b = l;
    x0 = 0;
  } else if (kind === "ellipse") {
    a = l / (1 - e2);
    b = a * Math.sqrt(1 - e2);
    c = e * a;
    x0 = c; // pusat di (+c, 0)
  } else if (kind === "hyperbola") {
    a = l / (e2 - 1);
    b = a * Math.sqrt(e2 - 1);
    c = e * a;
    x0 = -c; // pusat di (−c, 0)
  }
  const pair = kind === "ellipse" || kind === "hyperbola";
  const f2: Vec | null = pair ? [2 * x0, 0] : null;
  const dir1 = e > EPS ? -l / e : null;
  const dir2 = pair ? 2 * x0 + l / e : null;
  const vertices: Vec[] =
    kind === "parabola"
      ? [[-l / 2, 0]]
      : pair
        ? [
            [x0 - a, 0],
            [x0 + a, 0],
          ]
        : [];

  // titik P pada sudut θ (diukur dari fokus)
  const th = (t * Math.PI) / 180;
  const u = 1 - e * Math.cos(th);
  const r = Math.abs(u) > 1e-4 ? l / u : Number.NaN;
  const valid = finite(r) && Math.abs(r) < 1e5;
  const px = valid ? r * Math.cos(th) : Number.NaN;
  const py = valid ? r * Math.sin(th) : Number.NaN;
  const rp = valid ? (-l * e * Math.sin(th)) / (u * u) : Number.NaN;
  const tx = rp * Math.cos(th) - r * Math.sin(th);
  const ty = rp * Math.sin(th) + r * Math.cos(th);
  // garis singgung: A x + B y = C
  const tanA = (1 - e2) * px - e * l;
  const tanB = py;
  const tanC = l * l + e * l * px;
  const pf1 = valid ? Math.abs(r) : Number.NaN;
  const pf2 = valid && f2 ? Math.hypot(px - f2[0], py) : Number.NaN;
  const pd = valid && dir1 !== null ? Math.abs(px - dir1) : Number.NaN;

  return {
    kind,
    a,
    b,
    c,
    x0,
    pair,
    f2,
    dir1,
    dir2,
    vertices,
    valid,
    px,
    py,
    tx,
    ty,
    tanA,
    tanB,
    tanC,
    slope: Math.abs(tanB) > 1e-9 ? -tanA / tanB : null,
    pf1,
    pf2,
    pd,
    ratio: pd > EPS ? pf1 / pd : Number.NaN,
  };
}

type Analysis = ReturnType<typeof analyze>;

/** Titik-titik kurva r = ℓ/(1 − e cos θ), dipotong pada jarak rmax. */
function conicBranch(
  e: number,
  l: number,
  rmax: number,
  which: "a" | "b",
): Sample[] {
  const make = (t0: number, t1: number, n: number) => {
    const out: Sample[] = [];
    for (let i = 0; i <= n; i += 1) {
      const t = t0 + ((t1 - t0) * i) / n;
      const r = l / (1 - e * Math.cos(t));
      let deg = (t * 180) / Math.PI;
      if (deg > 180) deg -= 360;
      out.push([r * Math.cos(t), r * Math.sin(t), deg]);
    }
    return out;
  };
  const clampCos = (v: number) => Math.min(1, Math.max(-1, v));
  if (e < 1 - EPS) return which === "a" ? make(0, 2 * Math.PI, 720) : [];
  const k = l / rmax;
  if (which === "a") {
    const tLo = Math.acos(clampCos((1 - k) / e));
    return make(tLo, 2 * Math.PI - tLo, 520);
  }
  if (e > 1 + EPS) {
    const cB = (1 + k) / e;
    if (cB < 1) {
      const tHi = Math.acos(cB);
      return make(-tHi, tHi, 520);
    }
  }
  return [];
}

/* ───────── Format ───────── */

const fmt = (value: number) => formatText(value);
const fmtPt = (x: number, y: number) => `(${fmt(x)}, ${fmt(y)})`;
const tex = (value: number) => (finite(value) ? texNumber(value) : "?");
const texPt = (x: number, y: number) =>
  String.raw`(${tex(x)},${tex(y)})`;

/** Menyusun suku "koef·simbol" menjadi LaTeX dengan tanda yang rapi. */
function polyTex(terms: [number, string][]) {
  const parts: string[] = [];
  terms.forEach(([coef, symbol]) => {
    if (Math.abs(coef) < 5e-3) return;
    const abs = Math.abs(coef);
    const body =
      symbol !== "" && Math.abs(abs - 1) < 5e-3
        ? symbol
        : `${texNumber(abs)}${symbol}`;
    if (parts.length === 0) parts.push(coef < 0 ? `-${body}` : body);
    else parts.push(`${coef < 0 ? "-" : "+"} ${body}`);
  });
  return parts.length ? parts.join(" ") : "0";
}

function shiftedTex(h: number) {
  if (Math.abs(h) < 5e-3) return "x";
  return h > 0 ? `(x-${texNumber(h)})` : `(x+${texNumber(-h)})`;
}

function standardTex(an: Analysis, l: number) {
  if (an.kind === "circle") return `x^{2}+y^{2}=${tex(l * l)}`;
  if (an.kind === "ellipse")
    return String.raw`\dfrac{${shiftedTex(an.x0)}^{2}}{${tex(an.a * an.a)}}+\dfrac{y^{2}}{${tex(an.b * an.b)}}=1`;
  if (an.kind === "hyperbola")
    return String.raw`\dfrac{${shiftedTex(an.x0)}^{2}}{${tex(an.a * an.a)}}-\dfrac{y^{2}}{${tex(an.b * an.b)}}=1`;
  const p = l / 2;
  return `y^{2}=${tex(4 * p)}(x+${tex(p)})`;
}

export function ConicSectionsSimulation() {
  const [params, setParams] = useStoredSimulationState(
    "conic.params",
    initialParams,
  );
  const [storedView, setStoredView] = useStoredSimulationState(
    "conic.view",
    initialView,
  );
  const view = useMemo<ViewState>(
    () => ({
      ...initialView,
      ...storedView,
      show: { ...initialView.show, ...storedView.show },
    }),
    [storedView],
  );

  // Jaga-jaga bila nilai tersimpan sudah tidak valid.
  const safeParams = useMemo<Params>(() => {
    const merged = { ...initialParams, ...params };
    return {
      e: clamp(Number(merged.e), E_RANGE[0], E_RANGE[1]),
      l: clamp(Number(merged.l), L_RANGE[0], L_RANGE[1]),
      t: clamp(Number(merged.t), T_RANGE[0], T_RANGE[1]),
    };
  }, [params]);

  const paramsRef = useRef(safeParams);
  paramsRef.current = safeParams;
  const viewRef = useRef(view);
  viewRef.current = view;
  const scene = useRef<Scene | null>(null);
  const [anim, setAnim] = useState<Anim>(null);

  /* ───────── Papan JSXGraph ───────── */

  const setup = (board: SimBoard) => {
    // Analisis dihitung sekali per perubahan parameter.
    let cache: { p: Params; v: Analysis } | null = null;
    const A = (): Analysis => {
      const p = paramsRef.current;
      if (!cache || cache.p !== p) cache = { p, v: analyze(p) };
      return cache.v;
    };
    const v = viewRef.current;

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

    /** Jarak yang cukup besar untuk menutupi seluruh area terlihat. */
    const extent = () => {
      const bb = board.getBoundingBox();
      return 4 * Math.max(...bb.map((value: number) => Math.abs(value))) + 30;
    };

    /** Kurva dari daftar titik; null menyembunyikannya. */
    const makeCurve = (
      stroke: string,
      width: number,
      dash: number,
      opacity: number,
      build: () => Vec[] | null,
    ) => {
      const curve = board.create("curve", [[0], [0]], {
        strokeColor: stroke,
        strokeWidth: width,
        strokeOpacity: opacity,
        dash,
        highlight: false,
        fixed: true,
      }) as unknown as DataCurve;
      curve.updateDataArray = () => {
        const points = build();
        if (
          !points ||
          points.length === 0 ||
          points.some((q) => !finite(q[0]) || !finite(q[1]))
        ) {
          curve.dataX = [Number.NaN];
          curve.dataY = [Number.NaN];
          return;
        }
        curve.dataX = points.map((q) => q[0]);
        curve.dataY = points.map((q) => q[1]);
      };
      return curve;
    };
    const toVec = (s: Sample[]): Vec[] => s.map(([x, y]) => [x, y] as Vec);

    // Pembanding: keempat jenis dengan fokus dan ℓ yang sama
    const ghosts: DataCurve[] = [];
    KIND_ORDER.forEach((k) => {
      const branch = (which: "a" | "b") => () =>
        toVec(conicBranch(KINDS[k].e, paramsRef.current.l, extent(), which));
      ghosts.push(makeCurve(KINDS[k].color, 1.5, 0, 0.35, branch("a")));
      if (k === "hyperbola")
        ghosts.push(makeCurve(KINDS[k].color, 1.5, 0, 0.35, branch("b")));
    });

    // Garis bantu: direktriks
    const vertical = (x: number | null): Vec[] | null => {
      if (x === null || !finite(x) || Math.abs(x) > 1e5) return null;
      const s = extent();
      return [
        [x, -s],
        [x, s],
      ];
    };
    const directrices = [
      makeCurve(colors.directrix, 2, 3, 1, () => vertical(A().dir1)),
      makeCurve(colors.directrix, 2, 3, 1, () => vertical(A().dir2)),
    ];

    // Asimtot hiperbola
    const asymptotes = [1, -1].map((sign) =>
      makeCurve(colors.guide, 1.25, 2, 1, () => {
        const an = A();
        if (an.kind !== "hyperbola") return null;
        const n = Math.hypot(an.a, an.b);
        const d: Vec = [an.a / n, (sign * an.b) / n];
        const s = extent();
        return [
          [an.x0 - d[0] * s, -d[1] * s],
          [an.x0 + d[0] * s, d[1] * s],
        ];
      }),
    );

    // Kurva utama (maksimal dua cabang)
    const main = [
      makeCurve(KINDS.ellipse.color, 3, 0, 1, () =>
        toVec(
          conicBranch(paramsRef.current.e, paramsRef.current.l, extent(), "a"),
        ),
      ),
      makeCurve(KINDS.ellipse.color, 3, 0, 1, () =>
        toVec(
          conicBranch(paramsRef.current.e, paramsRef.current.l, extent(), "b"),
        ),
      ),
    ];

    // Garis singgung di P
    const tangent = makeCurve(colors.tangent, 2.25, 0, 1, () => {
      const an = A();
      if (!an.valid) return null;
      const n = Math.hypot(an.tx, an.ty);
      if (n < 1e-9) return null;
      const s = extent();
      const d: Vec = [an.tx / n, an.ty / n];
      return [
        [an.px - d[0] * s, an.py - d[1] * s],
        [an.px + d[0] * s, an.py + d[1] * s],
      ];
    });

    // Ruas PF₁, PF₂, dan jarak P ke direktriks
    const segments = [
      makeCurve(colors.focus, 1.5, 2, 0.7, () => {
        const an = A();
        return an.valid
          ? [
              [an.px, an.py],
              [0, 0],
            ]
          : null;
      }),
      makeCurve(colors.focus, 1.5, 2, 0.7, () => {
        const an = A();
        return an.valid && an.f2
          ? [
              [an.px, an.py],
              [an.f2[0], 0],
            ]
          : null;
      }),
      makeCurve(colors.directrix, 1.75, 2, 1, () => {
        const an = A();
        return an.valid && an.dir1 !== null
          ? [
              [an.px, an.py],
              [an.dir1, an.py],
            ]
          : null;
      }),
    ];

    // Titik + label koordinat
    const marker = (
      x: () => number,
      y: () => number,
      color: string,
      name: string | (() => string),
    ): Marker => {
      const point = board.create("point", [x, y], {
        name: "",
        withLabel: false,
        size: v.pointSize,
        fillColor: color,
        strokeColor: "#ffffff",
        strokeWidth: 1.5,
        fixed: true,
        highlight: false,
        showInfobox: false,
      }) as unknown as Settable;
      const label = board.create(
        "text",
        [
          () => (finite(x()) ? x() + 8 / board.unitX : 0),
          () => (finite(y()) ? y() + 6 / board.unitY : 0),
          () =>
            finite(x()) && finite(y())
              ? `${typeof name === "function" ? name() : name}${fmtPt(x(), y())}`
              : "",
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
      return { point, label };
    };

    const f2x = () => (A().f2 ? A().f2![0] : Number.NaN);
    const vertexAt = (k: number, axis: 0 | 1) => () =>
      A().vertices[k] ? A().vertices[k][axis] : Number.NaN;
    const vertexName = (k: number) => (A().kind === "parabola" ? "V" : `V${k + 1}`);

    scene.current = {
      grid,
      axes: [xAxis, yAxis],
      main,
      ghosts,
      directrices,
      asymptotes,
      tangent,
      segments,
      foci: [
        marker(() => 0, () => 0, colors.focus, "F₁"),
        marker(f2x, () => (finite(f2x()) ? 0 : Number.NaN), colors.focus, "F₂"),
      ],
      center: marker(
        () => (A().pair ? A().x0 : Number.NaN),
        () => (A().pair ? 0 : Number.NaN),
        colors.guide,
        "O",
      ),
      vertices: [0, 1].map((k) =>
        marker(vertexAt(k, 0), vertexAt(k, 1), colors.l, () => vertexName(k)),
      ),
      p: marker(
        () => (A().valid ? A().px : Number.NaN),
        () => (A().valid ? A().py : Number.NaN),
        colors.t,
        "P",
      ),
    };
    applyView();
  };

  const { boardProps, boardRef, zoomIn, zoomOut, resetView } = useJsxBoard({
    boundingBox: initialBox,
    setup,
  });

  const kind = kindOf(safeParams.e);
  const info = KINDS[kind];

  /** Menerapkan toggle, ketebalan garis, warna jenis, dan ukuran titik. */
  function applyView() {
    const s = scene.current;
    if (!s) return;
    const vw = viewRef.current;
    const thin = Math.max(1, vw.curveWidth / 2);
    const kindColor = KINDS[kindOf(paramsRef.current.e)].color;

    s.grid.setAttribute({ visible: vw.grid });
    s.axes.forEach((axis) =>
      axis.defaultTicks.setAttribute({
        visible: vw.axisNumbers,
        drawLabels: vw.axisNumbers,
      }),
    );

    s.main.forEach((c) =>
      c.setAttribute({
        visible: vw.show.curve,
        strokeWidth: vw.curveWidth,
        strokeColor: kindColor,
      }),
    );
    s.ghosts.forEach((c) =>
      c.setAttribute({ visible: vw.show.ghost, strokeWidth: thin }),
    );
    s.directrices.forEach((c) =>
      c.setAttribute({ visible: vw.show.directrix, strokeWidth: thin }),
    );
    s.asymptotes.forEach((c) =>
      c.setAttribute({ visible: vw.show.guide, strokeWidth: thin }),
    );
    s.tangent.setAttribute({
      visible: vw.show.tangent,
      strokeWidth: Math.max(1.5, vw.curveWidth * 0.75),
    });
    s.segments.forEach((c, i) =>
      c.setAttribute({
        // ruas ke direktriks hanya tampil bila direktriks ditampilkan
        visible: vw.show.point && (i < 2 || vw.show.directrix),
        strokeWidth: thin,
      }),
    );

    const apply = (item: Marker, shown: boolean, extra: number) => {
      item.point.setAttribute({ visible: shown, size: vw.pointSize + extra });
      item.label.setAttribute({ visible: shown && vw.pointLabels });
    };
    s.foci.forEach((item) => apply(item, vw.show.focus, 1));
    apply(s.center, vw.show.guide, 0);
    s.vertices.forEach((item) => apply(item, vw.show.guide, 0));
    apply(s.p, vw.show.point, 2);

    boardRef.current?.update();
  }

  useEffect(() => {
    applyView();
  }, [view, kind]);

  useEffect(() => {
    boardRef.current?.update();
  }, [safeParams, boardRef]);

  /* ───────── Ketuk kurva untuk menempatkan titik P ───────── */

  const hostRef = boardProps.ref;
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let down: { x: number; y: number } | null = null;

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      down = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      down = null;
      const board = boardRef.current;
      if (!board || moved >= 5) return; // geser tetap lancar
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const [x1, y1, x2, y2] = board.getBoundingBox();
      const sx = rect.width / (x2 - x1);
      const sy = rect.height / (y1 - y2);
      const ux = x1 + ((event.clientX - rect.left) / rect.width) * (x2 - x1);
      const uy = y1 - ((event.clientY - rect.top) / rect.height) * (y1 - y2);

      const { e, l } = paramsRef.current;
      const rmax =
        4 * Math.max(...[x1, y1, x2, y2].map((value) => Math.abs(value))) + 30;
      const samples = conicBranch(e, l, rmax, "a").concat(
        conicBranch(e, l, rmax, "b"),
      );
      let best: Sample | null = null;
      let bestDist = 30; // piksel
      samples.forEach((s) => {
        const d = Math.hypot((s[0] - ux) * sx, (s[1] - uy) * sy);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      });
      const hit = best as Sample | null;
      if (hit) {
        setAnim(null);
        patch({ t: round(clamp(hit[2], T_RANGE[0], T_RANGE[1]), 1) });
      }
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ───────── Perubahan dari pengguna ───────── */

  const patch = (change: Partial<Params>) => {
    const next: Params = { ...paramsRef.current, ...change };
    paramsRef.current = next;
    setParams(next);
    boardRef.current?.update();
  };

  /** Perubahan manual selalu menghentikan animasi. */
  const edit = (change: Partial<Params>) => {
    setAnim(null);
    patch(change);
  };

  const resetParams = () => {
    setAnim(null);
    patch(initialParams);
  };

  // Animasi: e bolak-balik 0 ↔ 3, atau titik P berkeliling.
  useEffect(() => {
    if (!anim) return;
    let raf = 0;
    let last = performance.now();
    let dir = 1;
    // Nilai float disimpan lokal agar langkah kecil tidak hilang oleh pembulatan.
    let e = paramsRef.current.e;
    let t = paramsRef.current.t;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (anim === "e") {
        e += dir * dt * 0.35;
        if (e >= E_RANGE[1]) {
          e = E_RANGE[1];
          dir = -1;
        } else if (e <= E_RANGE[0]) {
          e = E_RANGE[0];
          dir = 1;
        }
        patch({ e: round(e, 2) });
      } else {
        t += dt * 35;
        if (t > 180) t -= 360;
        patch({ t: round(t, 1) });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anim]);

  const updateView = (change: Partial<ViewState>) => {
    const next = { ...viewRef.current, ...change };
    viewRef.current = next;
    setStoredView(next);
  };

  const toggleShow = (key: ObjectKey) =>
    updateView({
      show: { ...viewRef.current.show, [key]: !viewRef.current.show[key] },
    });

  /* ───────── Nilai turunan ───────── */

  const { e, l, t } = safeParams;
  const an = analyze(safeParams);
  const ineq =
    kind === "circle"
      ? "e=0"
      : kind === "ellipse"
        ? "0<e<1"
        : kind === "parabola"
          ? "e=1"
          : "e>1";

  const generalTex = `${polyTex([
    [1 - e * e, "x^{2}"],
    [-2 * e * l, "x"],
    [1, "y^{2}"],
  ])}=${tex(l * l)}`;
  const standard = standardTex(an, l);
  const tangentTex = an.valid
    ? `${polyTex([
        [an.tanA, "x"],
        [an.tanB, "y"],
      ])}=${tex(an.tanC)}`
    : String.raw`\text{—}`;

  const overlayTex = String.raw`\text{${info.label}}\ (${ineq}):\quad ${standard}`;

  /* ───────── Tampilan ───────── */

  return (
    <SimulationShell
      title="Simulasi irisan kerucut"
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
        <SimSection title="Garis dan titik">
          <SimSlider
            id="conic-curve-width"
            name="tebal kurva"
            label={`Tebal kurva: ${view.curveWidth}`}
            value={view.curveWidth}
            min={1}
            max={8}
            step={1}
            onChange={(curveWidth) => updateView({ curveWidth })}
          />
          <SimSlider
            id="conic-point-size"
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
      }
      graph={
        <div
          {...boardProps}
          role="img"
          aria-label="Grafik irisan kerucut dengan fokus di titik asal. Seret untuk menggeser, cubit atau gulir untuk memperbesar, ketuk kurva untuk memindahkan titik P."
        />
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          <SimMath tex={overlayTex} />
        </p>
      }
      panel={
        <>
          <SimSection title="Jenis irisan kerucut">
            <div
              className="sim-seg sim-seg--kinds"
              role="radiogroup"
              aria-label="Jenis irisan kerucut"
            >
              {KIND_ORDER.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  className="sim-seg__btn"
                  style={{ "--sim-accent": KINDS[k].color } as CSSProperties}
                  onClick={() => edit({ e: KINDS[k].e })}
                >
                  {KINDS[k].label}
                </button>
              ))}
            </div>
          </SimSection>

          <SimSection title="Parameter" sticky>
            <SimSlider
              id="conic-e"
              name="e"
              label={<SimMath tex={`e=${tex(e)}`} />}
              hint="eksentrisitas"
              accent={info.color}
              value={e}
              min={E_RANGE[0]}
              max={E_RANGE[1]}
              step={0.01}
              valueText={`e sama dengan ${fmt(e)}`}
              onChange={(value) => edit({ e: value })}
            />
            <SimSlider
              id="conic-l"
              name="ℓ"
              label={<SimMath tex={String.raw`\ell=${tex(l)}`} />}
              hint="setengah lebar fokal"
              accent={colors.l}
              value={l}
              min={L_RANGE[0]}
              max={L_RANGE[1]}
              step={0.1}
              valueText={`ℓ sama dengan ${fmt(l)}`}
              onChange={(value) => edit({ l: value })}
            />
            <SimSlider
              id="conic-t"
              name="θ"
              label={<SimMath tex={String.raw`\theta=${tex(t)}^{\circ}`} />}
              hint="posisi titik P"
              accent={colors.t}
              value={t}
              min={T_RANGE[0]}
              max={T_RANGE[1]}
              step={0.5}
              valueText={`θ sama dengan ${fmt(t)} derajat`}
              onChange={(value) => edit({ t: value })}
            />
            <div className="sim-btn-row">
              <button
                type="button"
                className="sim-text-btn"
                aria-pressed={anim === "e"}
                onClick={() => setAnim(anim === "e" ? null : "e")}
              >
                {anim === "e" ? "Hentikan e" : "Animasikan e"}
              </button>
              <button
                type="button"
                className="sim-text-btn"
                aria-pressed={anim === "t"}
                onClick={() => setAnim(anim === "t" ? null : "t")}
              >
                {anim === "t" ? "Hentikan P" : "Putar titik P"}
              </button>
            </div>
          </SimSection>

          <SimSection title="Hasil">
            <ul className="sim-rows" aria-live="polite">
              <SimRow
                color={info.color}
                visible={view.show.curve}
                onToggle={() => toggleShow("curve")}
                toggleLabel="Tampilkan atau sembunyikan kurva"
              >
                <span>
                  {info.label} (<SimMath tex={ineq} />)
                </span>
              </SimRow>
              <SimRow>
                <SimMath tex={generalTex} />
              </SimRow>
              <SimRow color={info.color}>
                <SimMath tex={standard} />
              </SimRow>

              {kind === "circle" && (
                <SimRow color={colors.l}>
                  <span>
                    Pusat = fokus <SimMath tex="(0,0)" />,{" "}
                    <SimMath tex={`r=\\ell=${tex(l)}`} />
                  </span>
                </SimRow>
              )}
              {kind === "parabola" && (
                <SimRow color={colors.l}>
                  <SimMath
                    tex={String.raw`V${texPt(-l / 2, 0)},\ p=\dfrac{\ell}{2}=${tex(l / 2)}`}
                  />
                </SimRow>
              )}
              {an.pair && (
                <>
                  <SimRow>
                    <SimMath
                      tex={`a=${tex(an.a)},\\ b=${tex(an.b)},\\ c=${tex(an.c)}`}
                    />
                  </SimRow>
                  <SimRow>
                    <SimMath
                      tex={
                        kind === "ellipse"
                          ? String.raw`c=\sqrt{a^{2}-b^{2}},\ e=\dfrac{c}{a}=${tex(an.c / an.a)}`
                          : String.raw`c=\sqrt{a^{2}+b^{2}},\ e=\dfrac{c}{a}=${tex(an.c / an.a)}`
                      }
                    />
                  </SimRow>
                </>
              )}

              <SimRow
                color={colors.focus}
                visible={view.show.focus}
                onToggle={() => toggleShow("focus")}
                toggleLabel="Tampilkan atau sembunyikan fokus"
              >
                <SimMath
                  tex={
                    an.f2
                      ? String.raw`F_1(0,0),\ F_2${texPt(an.f2[0], 0)}`
                      : String.raw`F(0,0)`
                  }
                />
              </SimRow>
              {kind !== "circle" && (
                <SimRow
                  color={colors.directrix}
                  visible={view.show.directrix}
                  onToggle={() => toggleShow("directrix")}
                  toggleLabel="Tampilkan atau sembunyikan direktriks"
                >
                  <SimMath
                    tex={
                      an.dir2 !== null
                        ? String.raw`x=${tex(an.dir1 ?? Number.NaN)}\ \text{dan}\ x=${tex(an.dir2)}`
                        : `x=${tex(an.dir1 ?? Number.NaN)}`
                    }
                  />
                </SimRow>
              )}
              {an.pair && (
                <SimRow
                  color={colors.guide}
                  visible={view.show.guide}
                  onToggle={() => toggleShow("guide")}
                  toggleLabel="Tampilkan atau sembunyikan pusat, puncak, dan asimtot"
                >
                  <SimMath
                    tex={`O${texPt(an.x0, 0)},\\ V_1${texPt(an.vertices[0][0], 0)},\\ V_2${texPt(an.vertices[1][0], 0)}`}
                  />
                </SimRow>
              )}
              {kind === "hyperbola" && (
                <SimRow color={colors.guide}>
                  <SimMath
                    tex={String.raw`y=\pm ${tex(an.b / an.a)}${shiftedTex(an.x0)}`}
                  />
                </SimRow>
              )}
              <SimRow
                color={colors.guide}
                visible={view.show.ghost}
                onToggle={() => toggleShow("ghost")}
                toggleLabel="Tampilkan atau sembunyikan kurva pembanding"
              >
                <span>Bandingkan keempat jenis</span>
              </SimRow>

              {an.valid ? (
                <>
                  <SimRow
                    color={colors.t}
                    visible={view.show.point}
                    onToggle={() => toggleShow("point")}
                    toggleLabel="Tampilkan atau sembunyikan titik P"
                  >
                    <SimMath tex={`P${texPt(an.px, an.py)}`} />
                  </SimRow>
                  <SimRow>
                    <SimMath
                      tex={
                        an.pd >= 0
                          ? `PF_1=${tex(an.pf1)},\\ d=${tex(an.pd)}`
                          : `PF_1=${tex(an.pf1)}`
                      }
                    />
                  </SimRow>
                  {finite(an.ratio) && (
                    <SimRow color={info.color}>
                      <SimMath
                        tex={String.raw`\dfrac{PF_1}{d}=${tex(an.ratio)}=e`}
                      />
                    </SimRow>
                  )}
                  {kind === "ellipse" && (
                    <SimRow>
                      <SimMath
                        tex={`PF_1+PF_2=${tex(an.pf1 + an.pf2)}=2a`}
                      />
                    </SimRow>
                  )}
                  {kind === "hyperbola" && (
                    <SimRow>
                      <SimMath
                        tex={`|PF_1-PF_2|=${tex(Math.abs(an.pf1 - an.pf2))}=2a`}
                      />
                    </SimRow>
                  )}
                  <SimRow
                    color={colors.tangent}
                    visible={view.show.tangent}
                    onToggle={() => toggleShow("tangent")}
                    toggleLabel="Tampilkan atau sembunyikan garis singgung"
                  >
                    <SimMath tex={tangentTex} />
                  </SimRow>
                  <SimRow>
                    <span>
                      Gradien:{" "}
                      {an.slope === null
                        ? "tegak lurus sumbu x"
                        : fmt(an.slope)}
                    </span>
                  </SimRow>
                </>
              ) : (
                <SimRow color={colors.t}>
                  <span>Titik P terlalu jauh. Ubah θ agar P kembali ke kurva.</span>
                </SimRow>
              )}
            </ul>
          </SimSection>
        </>
      }
      notes={
        <>
          <p style={{ margin: 0 }}>
            <strong style={{ color: info.color }}>Definisi fokus–direktriks: </strong>
            titik <SimMath tex="P" /> pada irisan kerucut memenuhi{" "}
            <SimMath tex={String.raw`PF=e\cdot d`} />, dengan{" "}
            <SimMath tex="d" /> jarak <SimMath tex="P" /> ke direktriks. Pada
            simulasi ini{" "}
            <SimMath tex={String.raw`r=\dfrac{\ell}{1-e\cos\theta}`} />.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.l }}>Pengaruh e: </strong>
            <SimMath tex="e=0" /> lingkaran, <SimMath tex="0<e<1" /> elips,{" "}
            <SimMath tex="e=1" /> parabola, dan <SimMath tex="e>1" /> hiperbola.
            Geser <SimMath tex="e" /> perlahan atau tekan Animasikan e untuk
            melihat satu jenis berubah menjadi jenis berikutnya.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.t }}>Titik P: </strong>
            geser <SimMath tex={String.raw`\theta`} /> atau ketuk kurva untuk
            memindahkan <SimMath tex="P" />. Perhatikan bahwa{" "}
            {kind === "ellipse"
              ? "PF₁ + PF₂ selalu sama dengan 2a."
              : kind === "hyperbola"
                ? "selisih PF₁ dan PF₂ selalu sama dengan 2a."
                : kind === "parabola"
                  ? "PF selalu sama dengan jarak P ke direktriks."
                  : "PF selalu sama dengan jari-jari."}
          </p>
        </>
      }
    />
  );
}

export default ConicSectionsSimulation;
