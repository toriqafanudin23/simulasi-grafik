import JXG from "jsxgraph";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
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
import {
  RIGHT,
  bounds,
  centerOf,
  isTriple,
  layout,
  proofBounds,
  proofRegions,
  proofTriangles,
  sideLengths,
  squaresOf,
  type Box,
  type Params,
  type Pt,
  type Square,
} from "../math/pythagorasMath";

/* Simulasi Teorema Pythagoras.
   Mode 1 "Tiga persegi": seret titik A dan B, luas persegi pada tiap sisi
   dihitung langsung. Sudut C dapat diubah untuk menguji kebalikannya.
   Mode 2 "Bukti penataan ulang": empat segitiga yang sama dipindahkan di dalam
   persegi bersisi a + b. Kerangka, kontrol, dan CSS memakai kit umum (sim-). */

/* ───────── Tipe ───────── */

type Mode = "squares" | "proof";
type ObjectKey = "tri" | "sqA" | "sqB" | "sqC";
type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean;
  units: boolean;
  snap: boolean;
  curveWidth: number;
  pointSize: number;
  mode: Mode;
  show: Record<ObjectKey, boolean>;
};
type JEl = {
  X(): number;
  Y(): number;
  setPosition(method: number, coords: number[]): unknown;
  setAttribute(attrs: Record<string, unknown>): unknown;
  on(event: string, handler: () => void): unknown;
};
type AxisEl = JEl & { defaultTicks: { setAttribute: (a: Record<string, unknown>) => unknown } };
type CurveLike = JEl & { updateDataArray: () => void; dataX: number[]; dataY: number[] };
type Role = "main" | "thin" | "handle" | "other";
type Item = { vis: (v: ViewState) => boolean; role: Role; el: JEl };
type Scene = { grid: JEl; axes: AxisEl[]; items: Item[]; pointA: JEl; pointB: JEl };

/* ───────── Konstanta ───────── */

const COORDS_BY_USER: number =
  (JXG as unknown as { COORDS_BY_USER?: number }).COORDS_BY_USER ?? 1;

const colors = {
  a: "#6557d2",
  b: "#e65100",
  c: "#2e7d32",
  tri: "#1565c0",
  muted: "#6c6c78",
  grid: "#dcdce2",
  axis: "#4a4a55",
};
const MIN_SIDE = 1;
const MAX_SIDE = 12;

const initialParams: Params = { a: 3, b: 4, gamma: RIGHT };
const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: true,
  units: true,
  snap: true,
  curveWidth: 3,
  pointSize: 4,
  mode: "squares",
  show: { tri: true, sqA: true, sqB: true, sqC: true },
};

type Preset = { label: string; params: Params; note: string };
const presets: Preset[] = [
  {
    label: "3, 4, 5",
    params: { a: 3, b: 4, gamma: RIGHT },
    note: "Tripel Pythagoras terkecil: 9 + 16 = 25. Hitung petak satuannya satu per satu.",
  },
  {
    label: "6, 8, 10",
    params: { a: 6, b: 8, gamma: RIGHT },
    note: "Kelipatan 2 dari (3, 4, 5) juga tripel Pythagoras: 36 + 64 = 100.",
  },
  {
    label: "5, 12, 13",
    params: { a: 5, b: 12, gamma: RIGHT },
    note: "Tripel Pythagoras lain: 25 + 144 = 169.",
  },
  {
    label: "1, 1",
    params: { a: 1, b: 1, gamma: RIGHT },
    note: "Sisi miringnya √2, bukan bilangan bulat. Luas persegi pada sisi miring tetap 2.",
  },
  {
    label: "2, 3",
    params: { a: 2, b: 3, gamma: RIGHT },
    note: "Sisi miring √13 ≈ 3.61. Teorema tetap berlaku walau c bukan bilangan bulat.",
  },
  {
    label: "Sudut lancip",
    params: { a: 4, b: 5, gamma: 70 },
    note: "Sudut C kurang dari 90°, sehingga a² + b² lebih besar dari c².",
  },
  {
    label: "Sudut tumpul",
    params: { a: 4, b: 5, gamma: 110 },
    note: "Sudut C lebih dari 90°, sehingga a² + b² lebih kecil dari c².",
  },
];

/* ───────── Pembantu ───────── */

const tn = texNumber;
const f = formatText;

const sanitize = (p: Params | undefined): Params => {
  if (!p || ![p.a, p.b, p.gamma].every(Number.isFinite)) return initialParams;
  return {
    a: clamp(p.a, MIN_SIDE, MAX_SIDE),
    b: clamp(p.b, MIN_SIDE, MAX_SIDE),
    gamma: clamp(Math.round(p.gamma), 20, 160),
  };
};
const sameParams = (p: Params, q: Params) =>
  p.a === q.a && p.b === q.b && p.gamma === q.gamma;

const MARGIN = 1.4;
const fitBox = (box: Box): BoundingBox => [
  box.minX - MARGIN,
  box.maxY + MARGIN,
  box.maxX + MARGIN,
  box.minY - MARGIN,
];
const boxFor = (p: Params, mode: Mode) =>
  fitBox(mode === "proof" ? proofBounds(p.a, p.b) : bounds(p));

export function PythagorasSimulation() {
  const [storedParams, setParams] = useStoredSimulationState<Params>(
    "pythagoras.params",
    initialParams,
  );
  const [storedView, setStoredView] = useStoredSimulationState(
    "pythagoras.view",
    initialView,
  );
  const params = useMemo(() => sanitize(storedParams), [storedParams]);
  const view = useMemo<ViewState>(
    () => ({
      ...initialView,
      ...storedView,
      show: { ...initialView.show, ...storedView.show },
    }),
    [storedView],
  );
  const [progress, setProgressState] = useState(0);
  const [playing, setPlaying] = useState(false);

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const viewRef = useRef(view);
  viewRef.current = view;
  const tRef = useRef(0);
  const scene = useRef<Scene | null>(null);
  const frame = useRef(0);

  /* ───────── Papan JSXGraph ───────── */

  const setup = (board: SimBoard) => {
    const v = viewRef.current;
    const create = (type: string, parents: unknown[], attrs: Record<string, unknown>) =>
      (
        board.create as unknown as (
          t: string,
          p: unknown[],
          a: Record<string, unknown>,
        ) => unknown
      ).call(board, type, parents, attrs) as JEl;
    const px = (n: number) => n / board.unitX;
    const py = (n: number) => n / board.unitY;
    const base = { highlight: false, fixed: true };

    const grid = create("grid", [], {
      strokeColor: colors.grid,
      strokeOpacity: 1,
      strokeWidth: 1,
      highlight: false,
    });
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
    const xAxis = create(
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
    ) as AxisEl;
    const yAxis = create(
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
    ) as AxisEl;

    /* Data persegi dipakai ulang selama parameter tidak berubah. */
    let cacheKey = "";
    let cache: ReturnType<typeof squaresOf> | null = null;
    const SQ = () => {
      const p = paramsRef.current;
      const key = `${p.a},${p.b},${p.gamma}`;
      if (key !== cacheKey) {
        cacheKey = key;
        cache = squaresOf(p);
      }
      return cache as ReturnType<typeof squaresOf>;
    };
    const P = () => paramsRef.current;
    const lay = () => layout(P());

    const items: Item[] = [];
    const add = (vis: Item["vis"], role: Role, el: JEl) => {
      items.push({ vis, role, el });
      return el;
    };
    const inSquares =
      (key?: ObjectKey) =>
      (s: ViewState) =>
        s.mode === "squares" && (key ? s.show[key] : true);
    const inProof = (s: ViewState) => s.mode === "proof";
    const labelsIn = (key: ObjectKey) => (s: ViewState) =>
      s.mode === "squares" && s.show[key] && s.pointLabels;

    /** Poligon tertutup berisi; `get` mengembalikan null bila tidak digambar. */
    const poly = (
      vis: Item["vis"],
      role: Role,
      color: string,
      fillOpacity: number,
      layer: number,
      get: () => Pt[] | null,
      extra: Record<string, unknown> = {},
    ) => {
      const el = create("curve", [[0], [0]], {
        strokeColor: color,
        strokeWidth: 2,
        fillColor: color,
        fillOpacity,
        layer,
        ...base,
        ...extra,
      }) as CurveLike;
      el.updateDataArray = function (this: CurveLike) {
        const pts = get();
        if (!pts || pts.length === 0) {
          this.dataX = [Number.NaN];
          this.dataY = [Number.NaN];
          return;
        }
        this.dataX = [...pts.map((q) => q.x), pts[0].x];
        this.dataY = [...pts.map((q) => q.y), pts[0].y];
      };
      return add(vis, role, el);
    };

    /** Garis petak satuan di dalam persegi (jarak 1 satuan dari sisi P→Q dan P→S). */
    const unitLines = (vis: Item["vis"], color: string, get: () => Square) => {
      const el = create("curve", [[0], [0]], {
        strokeColor: color,
        strokeWidth: 1,
        strokeOpacity: 0.55,
        fillOpacity: 0,
        layer: 3,
        ...base,
      }) as CurveLike;
      el.updateDataArray = function (this: CurveLike) {
        const [p0, p1, , p3] = get();
        const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        const xs: number[] = [];
        const ys: number[] = [];
        if (L > 14) {
          this.dataX = [Number.NaN];
          this.dataY = [Number.NaN];
          return;
        }
        const u = { x: (p1.x - p0.x) / L, y: (p1.y - p0.y) / L };
        const w = { x: (p3.x - p0.x) / L, y: (p3.y - p0.y) / L };
        for (let i = 1; i < L - 1e-9; i += 1) {
          xs.push(
            p0.x + u.x * i, p0.x + u.x * i + w.x * L, Number.NaN,
            p0.x + w.x * i, p0.x + w.x * i + u.x * L, Number.NaN,
          );
          ys.push(
            p0.y + u.y * i, p0.y + u.y * i + w.y * L, Number.NaN,
            p0.y + w.y * i, p0.y + w.y * i + u.y * L, Number.NaN,
          );
        }
        this.dataX = xs.length ? xs : [Number.NaN];
        this.dataY = ys.length ? ys : [Number.NaN];
      };
      return add(vis, "other", el);
    };

    const text = (
      vis: Item["vis"],
      x: () => number,
      y: () => number,
      content: () => string,
      color: string,
      size: number,
    ) =>
      add(
        vis,
        "other",
        create("text", [x, y, content], {
          anchorX: "middle",
          anchorY: "middle",
          fontSize: size,
          strokeColor: color,
          layer: 8,
          cssStyle:
            "font-weight:600;white-space:nowrap;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;",
          ...base,
        }),
      );
    const unit = (from: Pt, to: Pt): Pt => {
      const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      return { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
    };
    const centroid = () => {
      const { A, B, C } = lay();
      return { x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 };
    };

    /* ───── Mode 1: tiga persegi ───── */

    const squareSpecs = [
      { key: "sqA" as const, name: "a", color: colors.a, pick: () => SQ().sa },
      { key: "sqB" as const, name: "b", color: colors.b, pick: () => SQ().sb },
      { key: "sqC" as const, name: "c", color: colors.c, pick: () => SQ().sc },
    ];
    squareSpecs.forEach(({ key, name, color, pick }) => {
      poly(inSquares(key), "thin", color, 0.2, 1, () => [...pick()]);
      unitLines((s) => inSquares(key)(s) && s.units, color, pick);
      text(
        inSquares(key),
        () => centerOf(pick()).x,
        () => centerOf(pick()).y,
        () => {
          const L = sideLengths(P());
          const side = L[name as "a" | "b" | "c"];
          return `${name}² = ${f(side * side)}`;
        },
        color,
        14,
      );
    });

    // Segitiga: isian, tiga sisi, dan tanda siku-siku
    poly(inSquares("tri"), "other", colors.tri, 0.14, 2, () => {
      const { A, B, C } = lay();
      return [A, B, C];
    }, { strokeWidth: 0 });
    const edge = (from: () => Pt, to: () => Pt) =>
      add(
        inSquares("tri"),
        "main",
        create(
          "segment",
          [
            [() => from().x, () => from().y],
            [() => to().x, () => to().y],
          ],
          {
            strokeColor: colors.tri,
            strokeWidth: v.curveWidth,
            layer: 5,
            point1: { visible: false, fixed: true },
            point2: { visible: false, fixed: true },
            ...base,
          },
        ),
      );
    edge(() => lay().C, () => lay().B);
    edge(() => lay().C, () => lay().A);
    edge(() => lay().A, () => lay().B);

    const mark = create("curve", [[0], [0]], {
      strokeColor: colors.tri,
      strokeWidth: 1.4,
      fillOpacity: 0,
      layer: 5,
      ...base,
    }) as CurveLike;
    mark.updateDataArray = function (this: CurveLike) {
      if (P().gamma !== RIGHT) {
        this.dataX = [Number.NaN];
        this.dataY = [Number.NaN];
        return;
      }
      const s = px(13);
      this.dataX = [s, s, 0];
      this.dataY = [0, py(13), py(13)];
    };
    add(inSquares("tri"), "other", mark);

    // Titik C (tetap), B dan A (bisa diseret)
    const handleStyle = (color: string) => ({
      name: "",
      withLabel: false,
      size: v.pointSize + 2,
      fillColor: "#ffffff",
      strokeColor: color,
      strokeWidth: 2.5,
      highlightFillColor: "#ffffff",
      highlightStrokeColor: color,
      showInfobox: false,
      layer: 9,
    });
    add(
      inSquares("tri"),
      "other",
      create("point", [0, 0], {
        ...handleStyle(colors.tri),
        size: v.pointSize,
        fillColor: colors.tri,
        strokeColor: "#ffffff",
        ...base,
      }),
    );
    const start = layout(paramsRef.current);
    const pointB = create("point", [start.B.x, start.B.y], handleStyle(colors.tri));
    const pointA = create("point", [start.A.x, start.A.y], handleStyle(colors.tri));
    add(inSquares("tri"), "handle", pointB);
    add(inSquares("tri"), "handle", pointA);

    // Nama titik sudut, huruf sisi, dan besar sudut C
    (["A", "B", "C"] as const).forEach((name) =>
      text(
        inSquares("tri"),
        () => {
          const q = lay()[name];
          const d = unit(centroid(), q);
          return q.x + px(16) * d.x;
        },
        () => {
          const q = lay()[name];
          const d = unit(centroid(), q);
          return q.y + py(16) * d.y;
        },
        () => name,
        colors.tri,
        13,
      ),
    );
    const sideSpecs: { name: string; color: string; ends: () => [Pt, Pt] }[] = [
      { name: "a", color: colors.a, ends: () => [lay().B, lay().C] },
      { name: "b", color: colors.b, ends: () => [lay().C, lay().A] },
      { name: "c", color: colors.c, ends: () => [lay().A, lay().B] },
    ];
    sideSpecs.forEach(({ name, color, ends }) => {
      const spot = () => {
        const [p, q] = ends();
        const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        const d = unit(m, centroid());
        return { x: m.x + px(12) * d.x, y: m.y + py(12) * d.y };
      };
      text(labelsIn("tri"), () => spot().x, () => spot().y, () => name, color, 13);
    });
    // Besar sudut C, diletakkan di dalam sudut (searah garis bagi).
    const angleSpot = () => {
      const { A, B, C } = lay();
      const u = unit(C, B);
      const w = unit(C, A);
      const d = unit({ x: 0, y: 0 }, { x: u.x + w.x, y: u.y + w.y });
      return { x: px(34) * d.x, y: py(34) * d.y };
    };
    text(
      labelsIn("tri"),
      () => angleSpot().x,
      () => angleSpot().y,
      () => `${P().gamma}°`,
      colors.muted,
      12,
    );

    /* ───── Mode 2: bukti penataan ulang ───── */

    const regions = () => proofRegions(P().a, P().b);
    poly(inProof, "thin", colors.axis, 0.05, 1, () => regions().big);
    poly(inProof, "thin", colors.c, 0.35, 2, () => (tRef.current < 0.001 ? regions().c : null));
    poly(inProof, "thin", colors.b, 0.35, 2, () => (tRef.current > 0.999 ? regions().sb : null));
    poly(inProof, "thin", colors.a, 0.35, 2, () => (tRef.current > 0.999 ? regions().sa : null));
    [0, 1, 2, 3].forEach((k) =>
      poly(
        inProof,
        "thin",
        colors.tri,
        k % 2 === 0 ? 0.55 : 0.4,
        4,
        () => proofTriangles(P().a, P().b, tRef.current)[k],
        { strokeWidth: 2 },
      ),
    );
    const regionText = (
      at: () => Pt,
      content: () => string,
      color: string,
    ) => text(inProof, () => at().x, () => at().y, content, color, 14);
    regionText(
      () => ({ x: (P().a + P().b) / 2, y: (P().a + P().b) / 2 }),
      () => (tRef.current < 0.001 ? `c² = ${f(P().a ** 2 + P().b ** 2)}` : ""),
      colors.c,
    );
    regionText(
      () => ({ x: P().b / 2, y: P().b / 2 }),
      () => (tRef.current > 0.999 ? `b² = ${f(P().b ** 2)}` : ""),
      colors.b,
    );
    regionText(
      () => ({ x: P().b + P().a / 2, y: P().b + P().a / 2 }),
      () => (tRef.current > 0.999 ? `a² = ${f(P().a ** 2)}` : ""),
      colors.a,
    );
    text(
      (s) => inProof(s) && s.pointLabels,
      () => (P().a + P().b) / 2,
      () => P().a + P().b + py(14),
      () => `(a + b)² = ${f((P().a + P().b) ** 2)}`,
      colors.axis,
      13,
    );
    // Huruf a dan b pada kaki tiap segitiga
    [0, 1, 2, 3].forEach((k) => {
      const tri = () => proofTriangles(P().a, P().b, tRef.current)[k];
      const legSpot = (i: 1 | 2) => () => {
        const r = tri()[0];
        const q = tri()[i];
        const g = {
          x: (tri()[0].x + tri()[1].x + tri()[2].x) / 3,
          y: (tri()[0].y + tri()[1].y + tri()[2].y) / 3,
        };
        const m = { x: (r.x + q.x) / 2, y: (r.y + q.y) / 2 };
        const d = unit(m, g);
        return { x: m.x + px(10) * d.x, y: m.y + py(10) * d.y };
      };
      text((s) => inProof(s) && s.pointLabels, () => legSpot(1)().x, () => legSpot(1)().y, () => "a", colors.a, 12);
      text((s) => inProof(s) && s.pointLabels, () => legSpot(2)().x, () => legSpot(2)().y, () => "b", colors.b, 12);
    });

    /* ───── Seret titik sudut ───── */

    const push = (next: Params) => {
      paramsRef.current = next;
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setParams(paramsRef.current);
      });
    };
    pointB.on("drag", () => {
      let a = clamp(pointB.X(), MIN_SIDE, MAX_SIDE);
      if (viewRef.current.snap) a = Math.round(a * 2) / 2;
      pointB.setPosition(COORDS_BY_USER, [a, 0]);
      push({ ...paramsRef.current, a });
    });
    pointA.on("drag", () => {
      const x = pointA.X();
      const y = pointA.Y();
      let b = clamp(Math.hypot(x, y), MIN_SIDE, MAX_SIDE);
      if (viewRef.current.snap) b = Math.round(b * 2) / 2;
      let gamma = clamp(Math.round((Math.atan2(y, x) * 180) / Math.PI), 20, 160);
      if (Math.abs(gamma - RIGHT) < 3) gamma = RIGHT;
      const next = { ...paramsRef.current, b, gamma };
      const q = layout(next).A;
      pointA.setPosition(COORDS_BY_USER, [q.x, q.y]);
      push(next);
    });

    scene.current = { grid, axes: [xAxis, yAxis], items, pointA, pointB };
    applyView();
  };

  const { boardProps, boardRef, zoomIn, zoomOut } = useJsxBoard({
    boundingBox: boxFor(params, view.mode),
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
      axis.defaultTicks.setAttribute({
        visible: v.axisNumbers,
        drawLabels: v.axisNumbers,
      }),
    );
    s.items.forEach(({ vis, role, el }) => {
      const attrs: Record<string, unknown> = { visible: vis(v) };
      if (role === "main") attrs.strokeWidth = v.curveWidth;
      if (role === "thin") attrs.strokeWidth = thin;
      if (role === "handle") attrs.size = v.pointSize + 2;
      el.setAttribute(attrs);
    });
    boardRef.current?.update();
  }

  /** Muat semua persegi (atau persegi besar) ke dalam tampilan. */
  const fit = (p: Params = paramsRef.current, mode: Mode = viewRef.current.mode) =>
    boardRef.current?.setBoundingBox(boxFor(p, mode), true);

  useEffect(() => {
    applyView();
  }, [view]);

  // Ganti mode: sesuaikan tampilan dan hentikan animasi.
  useEffect(() => {
    fit(paramsRef.current, view.mode);
    if (view.mode !== "proof") setPlaying(false);
  }, [view.mode]);

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  /* ───────── Perubahan dari pengguna ───────── */

  const setProgress = (value: number) => {
    tRef.current = value;
    setProgressState(value);
    boardRef.current?.update();
  };

  // Putar otomatis bolak-balik dengan jeda di kedua ujung.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let dir = tRef.current >= 1 ? -1 : 1;
    let holdUntil = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (now >= holdUntil) {
        const next = clamp(tRef.current + (dir * dt) / 4, 0, 1);
        setProgress(next);
        if (next >= 1 || next <= 0) {
          dir = next >= 1 ? -1 : 1;
          holdUntil = now + 900;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const applyParams = (next: Params, refit = false) => {
    paramsRef.current = next;
    setParams(next);
    const s = scene.current;
    if (s) {
      const l = layout(next);
      s.pointB.setPosition(COORDS_BY_USER, [l.B.x, l.B.y]);
      s.pointA.setPosition(COORDS_BY_USER, [l.A.x, l.A.y]);
    }
    if (refit) fit(next);
    boardRef.current?.update();
  };
  const updateParam = (key: keyof Params, value: number) =>
    applyParams(sanitize({ ...paramsRef.current, [key]: value }));
  const resetAll = () => {
    setPlaying(false);
    setProgress(0);
    applyParams(initialParams, true);
  };

  const updateView = (patch: Partial<ViewState>) => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setStoredView(next);
  };
  const toggleShow = (key: ObjectKey) =>
    updateView({ show: { ...viewRef.current.show, [key]: !viewRef.current.show[key] } });

  /* ───────── Nilai turunan ───────── */

  const proof = view.mode === "proof";
  const eff: Params = proof ? { ...params, gamma: RIGHT } : params;
  const { a, b, c } = sideLengths(eff);
  const a2 = a * a;
  const b2 = b * b;
  const c2 = c * c;
  const s2 = (a + b) ** 2;
  const gamma = eff.gamma;
  const relation = gamma === RIGHT ? "=" : gamma < RIGHT ? ">" : "<";
  const angleKind = gamma === RIGHT ? "siku-siku" : gamma < RIGHT ? "lancip" : "tumpul";
  const triple = isTriple(eff);
  const activePreset = presets.find((p) => sameParams(p.params, params));

  const numbersTex = proof
    ? `${tn(s2)}=${tn(c2)}+${tn(2 * a * b)}`
    : `${tn(a2)}+${tn(b2)}${relation}${tn(c2)}`;

  const resultText = proof
    ? `Luas sisa = (a + b)² − 4 · ½ab = ${f(s2)} − ${f(2 * a * b)} = ${f(s2 - 2 * a * b)}, sama dengan a² + b² dan juga c².`
    : gamma === RIGHT
      ? triple
        ? `Segitiga siku-siku: ${f(a2)} + ${f(b2)} = ${f(c2)}. Tripel Pythagoras (${f(a)}, ${f(b)}, ${f(c)}) semuanya bilangan bulat.`
        : `Segitiga siku-siku: ${f(a2)} + ${f(b2)} = ${f(c2)}, sehingga c = √${f(c2)} ≈ ${f(c)}.`
      : `Sudut C = ${gamma}° (${angleKind}): a² + b² = ${f(a2 + b2)} ${relation} ${f(c2)} = c². Kesamaan Pythagoras hanya berlaku pada sudut siku-siku.`;

  const row = (key: ObjectKey, color: string, content: ReactNode, label: string) => (
    <SimRow
      key={key}
      color={color}
      visible={view.show[key]}
      onToggle={() => toggleShow(key)}
      toggleLabel={`Tampilkan atau sembunyikan ${label}`}
    >
      {content}
    </SimRow>
  );

  const formulas: string[] = proof
    ? [
        String.raw`(a+b)^{2}=c^{2}+4\cdot\tfrac{1}{2}ab`,
        String.raw`a^{2}+2ab+b^{2}=c^{2}+2ab`,
        String.raw`a^{2}+b^{2}=c^{2}`,
        String.raw`(${tn(a)}+${tn(b)})^{2}=${tn(s2)},\quad c^{2}+2ab=${tn(c2)}+${tn(2 * a * b)}=${tn(c2 + 2 * a * b)}`,
      ]
    : gamma === RIGHT
      ? [
          String.raw`c^{2}=a^{2}+b^{2}`,
          String.raw`c=\sqrt{a^{2}+b^{2}}=\sqrt{${tn(a2)}+${tn(b2)}}=\sqrt{${tn(a2 + b2)}}=${tn(c)}`,
        ]
      : [
          String.raw`c^{2}=a^{2}+b^{2}-2ab\cos\gamma`,
          String.raw`c^{2}=${tn(a2)}+${tn(b2)}-2\cdot ${tn(a)}\cdot ${tn(b)}\cdot\cos ${gamma}^{\circ}=${tn(c2)}`,
          String.raw`\gamma<90^{\circ}\Rightarrow c^{2}<a^{2}+b^{2},\qquad \gamma>90^{\circ}\Rightarrow c^{2}>a^{2}+b^{2}`,
        ];

  /* ───────── Tampilan ───────── */

  return (
    <SimulationShell
      title="Simulasi Teorema Pythagoras"
      onReset={resetAll}
      onZoomIn={zoomIn}
      onZoomOut={zoomOut}
      onHome={() => fit()}
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
            label="Label sisi"
            pressed={view.pointLabels}
            onClick={() => updateView({ pointLabels: !view.pointLabels })}
          />
        </>
      }
      settings={
        <SimSection title="Garis dan titik">
          <SimSlider
            id="pythagoras-curve-width"
            name="tebal garis"
            label={`Tebal garis: ${view.curveWidth}`}
            value={view.curveWidth}
            min={1}
            max={8}
            step={1}
            onChange={(curveWidth) => updateView({ curveWidth })}
          />
          <SimSlider
            id="pythagoras-point-size"
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
                units: initialView.units,
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
          aria-label={
            proof
              ? "Bukti Teorema Pythagoras: empat segitiga siku-siku dipindahkan di dalam persegi bersisi a ditambah b."
              : "Segitiga dengan persegi pada ketiga sisinya. Seret titik A atau B untuk mengubah ukuran."
          }
        />
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          <SimMath tex={numbersTex} />
          {!proof && gamma !== RIGHT && (
            <span className="sim-overlay__sub">sudut {angleKind}</span>
          )}
        </p>
      }
      panel={
        <>
          <SimSection title="Pilih tampilan">
            <div className="sim-seg sim-seg--kinds" role="radiogroup" aria-label="Tampilan">
              {(
                [
                  ["squares", "Tiga persegi", colors.tri],
                  ["proof", "Bukti penataan ulang", colors.c],
                ] as const
              ).map(([mode, label, accent]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  className="sim-seg__btn"
                  aria-checked={view.mode === mode}
                  style={{ "--sim-accent": accent } as CSSProperties}
                  onClick={() => updateView({ mode })}
                >
                  {label}
                </button>
              ))}
            </div>
            {!proof && <p className="sim-hint">Seret titik A atau B di grafik.</p>}
          </SimSection>

          <SimSection title="Parameter" sticky>
            <SimSlider
              id="pythagoras-a"
              name="a"
              label={<SimMath tex={`a=${tn(params.a)}`} />}
              hint="sisi mendatar"
              accent={colors.a}
              value={params.a}
              min={MIN_SIDE}
              max={MAX_SIDE}
              step={0.5}
              valueText={`a sama dengan ${params.a}`}
              onChange={(value) => updateParam("a", value)}
            />
            <SimSlider
              id="pythagoras-b"
              name="b"
              label={<SimMath tex={`b=${tn(params.b)}`} />}
              hint="sisi tegak"
              accent={colors.b}
              value={params.b}
              min={MIN_SIDE}
              max={MAX_SIDE}
              step={0.5}
              valueText={`b sama dengan ${params.b}`}
              onChange={(value) => updateParam("b", value)}
            />
            {!proof && (
              <SimSlider
                id="pythagoras-gamma"
                name="sudut C"
                label={<SimMath tex={String.raw`\gamma=${params.gamma}^{\circ}`} />}
                hint="sudut di titik C"
                accent={colors.tri}
                value={params.gamma}
                min={20}
                max={160}
                step={1}
                valueText={`sudut C sama dengan ${params.gamma} derajat`}
                onChange={(value) => updateParam("gamma", value)}
              />
            )}
            {proof && (
              <>
                <SimSlider
                  id="pythagoras-progress"
                  name="penataan ulang"
                  label={`Susun ulang: ${Math.round(progress * 100)}%`}
                  hint="awal ke akhir"
                  accent={colors.c}
                  value={progress}
                  min={0}
                  max={1}
                  step={0.01}
                  valueText={`${Math.round(progress * 100)} persen`}
                  onChange={(value) => {
                    setPlaying(false);
                    setProgress(value);
                  }}
                />
                <div className="sim-btn-row" style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="sim-text-btn"
                    aria-pressed={playing}
                    onClick={() => setPlaying(!playing)}
                  >
                    {playing ? "Jeda" : "Putar otomatis"}
                  </button>
                  <button
                    type="button"
                    className="sim-text-btn"
                    onClick={() => {
                      setPlaying(false);
                      setProgress(0);
                    }}
                  >
                    Susunan awal
                  </button>
                  <button
                    type="button"
                    className="sim-text-btn"
                    onClick={() => {
                      setPlaying(false);
                      setProgress(1);
                    }}
                  >
                    Susunan akhir
                  </button>
                </div>
              </>
            )}
            {!proof && params.gamma !== RIGHT && (
              <button
                type="button"
                className="sim-text-btn"
                style={{ marginTop: 6 }}
                onClick={() => updateParam("gamma", RIGHT)}
              >
                Jadikan sudut siku-siku (90°)
              </button>
            )}
          </SimSection>

          <SimSection title="Contoh">
            <div className="sim-chips" role="group" aria-label="Contoh ukuran">
              {presets
                .filter((p) => !proof || p.params.gamma === RIGHT)
                .map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className="sim-chip"
                    aria-pressed={activePreset === p}
                    onClick={() => {
                      applyParams(p.params, true);
                      if (proof) setProgress(0);
                    }}
                  >
                    {p.label}
                  </button>
                ))}
            </div>
            {activePreset && !proof && <p className="sim-callout">{activePreset.note}</p>}
          </SimSection>

          {!proof && (
            <SimSection title="Opsi">
              <div className="sim-btn-row">
                <button
                  type="button"
                  className="sim-text-btn"
                  aria-pressed={view.units}
                  onClick={() => updateView({ units: !view.units })}
                >
                  Petak satuan
                </button>
                <button
                  type="button"
                  className="sim-text-btn"
                  aria-pressed={view.snap}
                  onClick={() => updateView({ snap: !view.snap })}
                >
                  Tempel ke 0.5
                </button>
              </div>
            </SimSection>
          )}

          <SimSection title="Hasil">
            <p className="sim-callout" role="status" style={{ marginTop: 0 }}>
              {resultText}
            </p>
            <ul className="sim-rows" aria-live="polite">
              {proof ? (
                <>
                  <SimRow color={colors.axis}>
                    <SimMath tex={`(a+b)^{2}=${tn(s2)}`} />
                  </SimRow>
                  <SimRow color={colors.tri}>
                    <SimMath tex={String.raw`4\cdot\tfrac{1}{2}ab=${tn(2 * a * b)}`} />
                  </SimRow>
                  <SimRow color={colors.c}>
                    <SimMath tex={`\\text{sisa}=${tn(s2 - 2 * a * b)}=a^{2}+b^{2}=c^{2}`} />
                  </SimRow>
                </>
              ) : (
                <>
                  {row(
                    "tri",
                    colors.tri,
                    <SimMath tex={String.raw`\triangle ABC,\ \gamma=${gamma}^{\circ}`} />,
                    "segitiga",
                  )}
                  {row("sqA", colors.a, <SimMath tex={`a^{2}=${tn(a2)}`} />, "persegi pada sisi a")}
                  {row("sqB", colors.b, <SimMath tex={`b^{2}=${tn(b2)}`} />, "persegi pada sisi b")}
                  {row("sqC", colors.c, <SimMath tex={`c^{2}=${tn(c2)}`} />, "persegi pada sisi c")}
                </>
              )}
            </ul>
          </SimSection>

          <SimSection title="Periksa hasilnya">
            <div className="sim-table-wrap">
              <table className="sim-table sim-table--left">
                {proof ? (
                  <>
                    <caption>Luas dua susunan dibandingkan.</caption>
                    <thead>
                      <tr>
                        <th scope="col">Bagian</th>
                        <th scope="col">Luas</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <th scope="row">Persegi besar</th>
                        <td>{f(s2)}</td>
                      </tr>
                      <tr>
                        <th scope="row">4 segitiga</th>
                        <td>{f(2 * a * b)}</td>
                      </tr>
                      <tr>
                        <th scope="row">Sisa (susunan awal): c²</th>
                        <td>{f(c2)}</td>
                      </tr>
                      <tr className="sim-table__limit">
                        <th scope="row">Sisa (susunan akhir): a² + b²</th>
                        <td>{f(a2 + b2)}</td>
                      </tr>
                    </tbody>
                  </>
                ) : (
                  <>
                    <caption>Luas persegi pada tiap sisi.</caption>
                    <thead>
                      <tr>
                        <th scope="col">Sisi</th>
                        <th scope="col">Panjang</th>
                        <th scope="col">Luas</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <th scope="row">a</th>
                        <td>{f(a)}</td>
                        <td>{f(a2)}</td>
                      </tr>
                      <tr>
                        <th scope="row">b</th>
                        <td>{f(b)}</td>
                        <td>{f(b2)}</td>
                      </tr>
                      <tr>
                        <th scope="row">c</th>
                        <td>{f(c)}</td>
                        <td>{f(c2)}</td>
                      </tr>
                      <tr className="sim-table__limit">
                        <th scope="row">a² + b²</th>
                        <td />
                        <td>{f(a2 + b2)}</td>
                      </tr>
                    </tbody>
                  </>
                )}
              </table>
            </div>
            <p className="sim-hint">
              {proof
                ? "Geser penggeser susun ulang dan perhatikan: luas sisa tidak berubah."
                : "Ubah sudut C: a² + b² hanya sama dengan c² pada 90°."}
            </p>
          </SimSection>

          <SimSection title="Rumus dan bukti">
            <details className="sim-guide" open>
              <summary>{proof ? "Bukti aljabar" : "Rumus dengan nilai saat ini"}</summary>
              {formulas.map((tex, i) => (
                <div key={i} className="sim-wrap" style={{ overflowX: "auto" }}>
                  <SimMath tex={tex} />
                </div>
              ))}
            </details>
            <details className="sim-guide" style={{ marginTop: 6 }}>
              <summary>{proof ? "Cara membaca gambar" : "Kebalikan teorema Pythagoras"}</summary>
              {proof ? (
                <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  <li className="sim-wrap">
                    Persegi besar bersisi a + b berisi empat segitiga yang sama.
                  </li>
                  <li className="sim-wrap">
                    Susunan awal menyisakan persegi miring bersisi c.
                  </li>
                  <li className="sim-wrap">
                    Segitiga hanya digeser, lalu sisanya menjadi persegi a² dan b².
                  </li>
                  <li className="sim-wrap">Luas sisa sama, maka c² = a² + b².</li>
                </ol>
              ) : (
                <p className="sim-wrap">
                  Jika a² + b² = c², segitiganya siku-siku. Jika a² + b² &gt; c², sudut
                  terbesar lancip. Jika a² + b² &lt; c², sudut terbesar tumpul.
                </p>
              )}
            </details>
          </SimSection>
        </>
      }
      notes={
        proof ? (
          <>
            <p style={{ margin: 0 }}>
              <strong style={{ color: colors.c }}>Bukti penataan ulang: </strong>
              empat segitiga siku-siku yang sama dipindahkan di dalam persegi bersisi{" "}
              <SimMath tex="a+b" />. Sisa yang tidak tertutup berupa persegi{" "}
              <SimMath tex="c^{2}" /> pada susunan awal dan dua persegi{" "}
              <SimMath tex="a^{2}" /> dan <SimMath tex="b^{2}" /> pada susunan akhir.
            </p>
            <p style={{ margin: 0 }}>
              Luas persegi besar dan luas empat segitiga tidak berubah, jadi luas sisanya
              juga tidak berubah. Karena itu <SimMath tex="c^{2}=a^{2}+b^{2}" />.
            </p>
          </>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              <strong style={{ color: colors.tri }}>Teorema Pythagoras: </strong>
              pada segitiga siku-siku, luas persegi pada sisi miring sama dengan jumlah
              luas persegi pada kedua sisi tegak, yaitu{" "}
              <SimMath tex="a^{2}+b^{2}=c^{2}" />.
            </p>
            <p style={{ margin: 0 }}>
              <strong style={{ color: colors.c }}>Uji kebalikannya: </strong>
              ubah sudut C. Pada sudut lancip <SimMath tex="a^{2}+b^{2}>c^{2}" />, pada sudut
              tumpul <SimMath tex="a^{2}+b^{2}<c^{2}" />.
            </p>
          </>
        )
      }
    />
  );
}
