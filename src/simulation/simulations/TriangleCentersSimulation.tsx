import JXG from "jsxgraph";
import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
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
import { formatText, texNumber } from "../common/utils/simUtils";
import { useJsxBoard, type BoundingBox, type SimBoard } from "../common/hooks/useJsxBoard";
import { useStoredSimulationState } from "../common/hooks/useStoredSimulationState";
import {
  NAN_PT,
  analyze,
  classify,
  dist,
  locate,
  placeText,
  type Geometry,
  type Pt,
  type Tri,
} from "../math/triangleMath";

/* Simulasi titik istimewa segitiga: titik berat (G), titik bagi (I),
   titik sumbu (O), dan titik tinggi (H), beserta garis Euler.
   Kerangka, kontrol, dan CSS memakai kit umum (prefix sim-). */

/* ───────── Tipe ───────── */

type CenterKey = "G" | "I" | "O" | "H";
type Focus = "all" | CenterKey;
type ObjectKey =
  | "tri"
  | "G"
  | "medians"
  | "I"
  | "bisectors"
  | "incircle"
  | "O"
  | "perps"
  | "circumcircle"
  | "H"
  | "altitudes"
  | "euler";
type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean;
  angles: boolean;
  snap: boolean;
  curveWidth: number;
  pointSize: number;
  focus: Focus;
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
type Role = "main" | "thin" | "dot" | "other";
type Item = { key: ObjectKey; role: Role; el: JEl };
type Scene = {
  grid: JEl;
  axes: AxisEl[];
  items: Item[];
  verts: JEl[];
  centers: { key: CenterKey; point: JEl; label: JEl }[];
  vertexLabels: JEl[];
  angleLabels: JEl[];
};

/* ───────── Konstanta ───────── */

const COORDS_BY_USER: number =
  (JXG as unknown as { COORDS_BY_USER?: number }).COORDS_BY_USER ?? 1;

const colors = {
  tri: "#1565c0",
  G: "#e65100",
  I: "#2e7d32",
  O: "#6557d2",
  H: "#c62828",
  euler: "#c28a00",
  muted: "#6c6c78",
  grid: "#dcdce2",
  axis: "#4a4a55",
};
const CENTERS: CenterKey[] = ["G", "I", "O", "H"];
const NAMES = ["A", "B", "C"] as const;
const SIDE_NAMES = ["BC", "CA", "AB"] as const;
const MID_NAMES = ["D", "E", "F"] as const;

const centerName: Record<CenterKey, string> = {
  G: "Titik berat",
  I: "Titik bagi",
  O: "Titik sumbu",
  H: "Titik tinggi",
};

type Verts = Tri;
const initialVerts: Verts = {
  A: { x: -4, y: -3 },
  B: { x: 5, y: -2 },
  C: { x: 1, y: 5 },
};
const initialBox: BoundingBox = [-9, 9, 9, -8];

const SQRT3 = Math.sqrt(3);
const presets: { label: string; verts: Verts; note: string }[] = [
  {
    label: "Lancip",
    verts: initialVerts,
    note: "Pada segitiga lancip, keempat titik berada di dalam segitiga.",
  },
  {
    label: "Siku-siku",
    verts: { A: { x: -4, y: -3 }, B: { x: 5, y: -3 }, C: { x: -4, y: 3 } },
    note: "Titik sumbu O berada di tengah sisi miring, dan titik tinggi H berimpit dengan titik sudut siku-siku.",
  },
  {
    label: "Tumpul",
    verts: { A: { x: -4, y: -2 }, B: { x: 1, y: -2 }, C: { x: 3, y: 2 } },
    note: "Pada segitiga tumpul, titik sumbu O dan titik tinggi H berada di luar segitiga. G dan I tetap di dalam.",
  },
  {
    label: "Sama kaki",
    verts: { A: { x: -4, y: -3 }, B: { x: 4, y: -3 }, C: { x: 0, y: 5 } },
    note: "Keempat titik terletak pada sumbu simetri segitiga.",
  },
  {
    label: "Sama sisi",
    verts: {
      A: { x: -4, y: -3 },
      B: { x: 4, y: -3 },
      C: { x: 0, y: -3 + 4 * SQRT3 },
    },
    note: "Keempat titik berimpit di satu titik: garis berat, garis bagi, garis sumbu, dan garis tinggi saling berhimpit.",
  },
];

const OFF: Record<ObjectKey, boolean> = {
  tri: true,
  G: false,
  medians: false,
  I: false,
  bisectors: false,
  incircle: false,
  O: false,
  perps: false,
  circumcircle: false,
  H: false,
  altitudes: false,
  euler: false,
};

/** Objek yang tampil untuk tiap fokus belajar. */
function focusShow(focus: Focus): Record<ObjectKey, boolean> {
  switch (focus) {
    case "G":
      return { ...OFF, G: true, medians: true };
    case "I":
      return { ...OFF, I: true, bisectors: true, incircle: true };
    case "O":
      return { ...OFF, O: true, perps: true, circumcircle: true };
    case "H":
      return { ...OFF, H: true, altitudes: true };
    default:
      return { ...OFF, G: true, I: true, O: true, H: true, euler: true };
  }
}

const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: true,
  angles: false,
  snap: true,
  curveWidth: 3,
  pointSize: 4,
  focus: "all",
  show: focusShow("all"),
};

const focusText: Record<
  Focus,
  { title: string; definition: string; property: string; steps: string[] }
> = {
  G: {
    title: "Titik berat (G)",
    definition:
      "Perpotongan ketiga garis berat. Garis berat menghubungkan sebuah titik sudut dengan titik tengah sisi di depannya.",
    property:
      "G membagi setiap garis berat dengan perbandingan 2 : 1 dihitung dari titik sudut, dan selalu berada di dalam segitiga.",
    steps: [
      "Tentukan titik tengah tiap sisi (D, E, F).",
      "Tarik garis dari tiap titik sudut ke titik tengah sisi di depannya.",
      "Perpotongan ketiga garis adalah G.",
    ],
  },
  I: {
    title: "Titik bagi (I)",
    definition:
      "Perpotongan ketiga garis bagi sudut, sekaligus pusat lingkaran dalam segitiga.",
    property:
      "I berjarak sama ke ketiga sisi, yaitu sejauh jari-jari lingkaran dalam r, dan selalu berada di dalam segitiga.",
    steps: [
      "Bagi dua sudut A, B, dan C dengan jangka.",
      "Tarik ketiga garis bagi sudut. Perpotongannya adalah I.",
      "Lukis lingkaran berpusat di I yang menyinggung ketiga sisi.",
    ],
  },
  O: {
    title: "Titik sumbu (O)",
    definition:
      "Perpotongan ketiga garis sumbu sisi, yaitu garis yang tegak lurus sisi di titik tengahnya. O adalah pusat lingkaran luar.",
    property:
      "O berjarak sama ke ketiga titik sudut (OA = OB = OC = R). Pada segitiga lancip O di dalam, pada segitiga siku-siku O di tengah sisi miring, pada segitiga tumpul O di luar.",
    steps: [
      "Buat garis sumbu sisi AB, BC, dan CA dengan jangka.",
      "Perpotongan ketiga garis sumbu adalah O.",
      "Lukis lingkaran berpusat di O yang melalui A, B, dan C.",
    ],
  },
  H: {
    title: "Titik tinggi (H)",
    definition:
      "Perpotongan ketiga garis tinggi. Garis tinggi ditarik dari titik sudut dan tegak lurus terhadap sisi di depannya (diperpanjang bila perlu).",
    property:
      "H di dalam segitiga lancip, berimpit dengan titik sudut siku-siku pada segitiga siku-siku, dan di luar segitiga tumpul.",
    steps: [
      "Dari tiap titik sudut, tarik garis tegak lurus ke sisi di depannya.",
      "Pada segitiga tumpul, perpanjang sisi dan garis tinggi sampai berpotongan.",
      "Perpotongan ketiga garis tinggi adalah H.",
    ],
  },
  all: {
    title: "Garis Euler",
    definition:
      "Titik sumbu O, titik berat G, dan titik tinggi H selalu terletak pada satu garis lurus yang disebut garis Euler.",
    property:
      "G terletak di antara O dan H dengan OG : GH = 1 : 2. Pada segitiga sama sisi keempat titik berimpit, sehingga garis Euler tidak terdefinisi.",
    steps: [],
  },
};

/* ───────── Pembantu tampilan ───────── */

const tn = texNumber;
const sumTex = (values: number[]) =>
  values
    .map((v, i) => (i === 0 ? tn(v) : v < 0 ? ` - ${tn(-v)}` : ` + ${tn(v)}`))
    .join("");
const paren = (v: number) => (v < 0 ? `(${tn(v)})` : tn(v));
const ptTex = (name: string, p: Pt) => String.raw`${name}(${tn(p.x)},${tn(p.y)})`;
const ptText = (p: Pt) => `(${formatText(p.x)}, ${formatText(p.y)})`;

const validVerts = (v: Verts | undefined): v is Verts =>
  !!v &&
  [v.A, v.B, v.C].every(
    (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y),
  );
const sameVerts = (p: Verts, q: Verts) =>
  (["A", "B", "C"] as const).every(
    (k) => Math.abs(p[k].x - q[k].x) < 1e-6 && Math.abs(p[k].y - q[k].y) < 1e-6,
  );

function AngleIcon() {
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
      <path d="M4 20h16 M4 20L16 6 M10 20a6 6 0 0 0-2.2-4.6" />
    </svg>
  );
}

export function TriangleCentersSimulation() {
  const [storedVerts, setVerts] = useStoredSimulationState<Verts>(
    "triangle.verts",
    initialVerts,
  );
  const [storedView, setStoredView] = useStoredSimulationState(
    "triangle.view",
    initialView,
  );
  const verts = useMemo(
    () => (validVerts(storedVerts) ? storedVerts : initialVerts),
    [storedVerts],
  );
  const view = useMemo<ViewState>(
    () => ({
      ...initialView,
      ...storedView,
      show: { ...initialView.show, ...storedView.show },
    }),
    [storedView],
  );

  const vertsRef = useRef(verts);
  vertsRef.current = verts;
  const viewRef = useRef(view);
  viewRef.current = view;
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

    /* Titik sudut: satu-satunya objek yang bisa diseret. */
    const start = vertsRef.current;
    const vertex = (p: Pt) =>
      create("point", [p.x, p.y], {
        name: "",
        withLabel: false,
        size: v.pointSize + 2,
        fillColor: "#ffffff",
        strokeColor: colors.tri,
        strokeWidth: 2.5,
        highlightFillColor: "#ffffff",
        highlightStrokeColor: colors.tri,
        snapToGrid: v.snap,
        snapSizeX: 0.5,
        snapSizeY: 0.5,
        showInfobox: false,
        layer: 9,
      });
    const pa = vertex(start.A);
    const pb = vertex(start.B);
    const pc = vertex(start.C);
    const verticesEl = [pa, pb, pc];

    const tri = (): Tri => ({
      A: { x: pa.X(), y: pa.Y() },
      B: { x: pb.X(), y: pb.Y() },
      C: { x: pc.X(), y: pc.Y() },
    });

    // Hasil analisis dipakai ulang selama titik sudut tidak berubah.
    let cacheKey = "";
    let cache: Geometry | null = null;
    const geo = () => {
      const t = tri();
      const key = `${t.A.x},${t.A.y},${t.B.x},${t.B.y},${t.C.x},${t.C.y}`;
      if (key !== cacheKey) {
        cacheKey = key;
        cache = analyze(t);
      }
      return cache;
    };
    const xy = (f: (g: Geometry) => Pt): [() => number, () => number] => [
      () => {
        const g = geo();
        return g ? f(g).x : Number.NaN;
      },
      () => {
        const g = geo();
        return g ? f(g).y : Number.NaN;
      },
    ];
    const px = (n: number) => n / board.unitX;
    const py = (n: number) => n / board.unitY;

    const items: Item[] = [];
    const add = (key: ObjectKey, role: Role, el: JEl) => {
      items.push({ key, role, el });
      return el;
    };
    const hidden = { point1: { visible: false, fixed: true }, point2: { visible: false, fixed: true } };
    const base = { highlight: false, fixed: true };
    const line = (
      key: ObjectKey,
      role: Role,
      color: string,
      f1: (g: Geometry) => Pt,
      f2: (g: Geometry) => Pt,
      extra: Record<string, unknown> = {},
    ) =>
      add(
        key,
        role,
        create("segment", [xy(f1), xy(f2)], {
          strokeColor: color,
          strokeWidth: 2,
          layer: 4,
          ...base,
          ...hidden,
          ...extra,
        }),
      );
    const infinite = (
      key: ObjectKey,
      color: string,
      f1: (g: Geometry) => Pt,
      f2: (g: Geometry) => Pt,
      extra: Record<string, unknown> = {},
    ) =>
      add(
        key,
        "thin",
        create("line", [xy(f1), xy(f2)], {
          straightFirst: true,
          straightLast: true,
          strokeColor: color,
          strokeWidth: 1.5,
          strokeOpacity: 0.55,
          dash: 2,
          layer: 3,
          ...base,
          ...hidden,
          ...extra,
        }),
      );
    const dot = (key: ObjectKey, color: string, f: (g: Geometry) => Pt) =>
      add(
        key,
        "dot",
        create("point", xy(f), {
          name: "",
          withLabel: false,
          size: Math.max(2, v.pointSize - 1),
          fillColor: color,
          strokeColor: "#ffffff",
          strokeWidth: 1,
          showInfobox: false,
          layer: 6,
          ...base,
        }),
      );
    const circle = (key: ObjectKey, color: string, c: (g: Geometry) => Pt, r: (g: Geometry) => number) =>
      add(
        key,
        "thin",
        create(
          "circle",
          [
            xy(c),
            () => {
              const g = geo();
              return g ? r(g) : Number.NaN;
            },
          ],
          { strokeColor: color, strokeWidth: 2, fillOpacity: 0, layer: 3, ...base },
        ),
      );
    /** Tanda siku-siku kecil di titik F: dari arah p1 dan p2 (titik di tiap kaki). */
    const rightMark = (
      key: ObjectKey,
      color: string,
      get: (g: Geometry, i: number) => [Pt, Pt, Pt],
    ) => {
      [0, 1, 2].forEach((i) => {
        const el = create("curve", [[0], [0]], {
          strokeColor: color,
          strokeWidth: 1.3,
          fillOpacity: 0,
          layer: 5,
          ...base,
        }) as CurveLike;
        el.updateDataArray = function (this: CurveLike) {
          const g = geo();
          if (!g) {
            this.dataX = [Number.NaN];
            this.dataY = [Number.NaN];
            return;
          }
          const [f, p1, p2] = get(g, i);
          const unit = (p: Pt) => {
            const len = dist(p, f) || 1;
            return { x: (p.x - f.x) / len, y: (p.y - f.y) / len };
          };
          const u = unit(p1);
          const w = unit(p2);
          const s = px(11);
          this.dataX = [f.x + s * u.x, f.x + s * (u.x + w.x), f.x + s * w.x];
          this.dataY = [f.y + s * u.y, f.y + s * (u.y + w.y), f.y + s * w.y];
        };
        add(key, "thin", el);
      });
    };

    /* Segitiga: isian dan tiga sisi. */
    const fill = create("curve", [[0], [0]], {
      strokeWidth: 0,
      fillColor: colors.tri,
      fillOpacity: 0.07,
      layer: 1,
      ...base,
    }) as CurveLike;
    fill.updateDataArray = function (this: CurveLike) {
      const t = tri();
      this.dataX = [t.A.x, t.B.x, t.C.x, t.A.x];
      this.dataY = [t.A.y, t.B.y, t.C.y, t.A.y];
    };
    add("tri", "other", fill);
    ([
      [pa, pb],
      [pb, pc],
      [pc, pa],
    ] as const).forEach(([p, q]) =>
      add(
        "tri",
        "main",
        create("segment", [p, q], {
          strokeColor: colors.tri,
          strokeWidth: v.curveWidth,
          layer: 5,
          ...base,
        }),
      ),
    );

    /* Garis berat. */
    [0, 1, 2].forEach((i) => {
      line("medians", "thin", colors.G, (g) => g.V[i], (g) => g.mids[i]);
      dot("medians", colors.G, (g) => g.mids[i]);
    });

    /* Garis bagi dan lingkaran dalam. */
    [0, 1, 2].forEach((i) => {
      line("bisectors", "thin", colors.I, (g) => g.V[i], (g) => g.bisectFeet[i]);
      line("incircle", "thin", colors.I, (g) => g.I, (g) => g.touch[i], { dash: 3 });
      dot("incircle", colors.I, (g) => g.touch[i]);
    });
    circle("incircle", colors.I, (g) => g.I, (g) => g.r);
    rightMark("incircle", colors.I, (g, i) => [g.touch[i], g.I, g.V[(i + 1) % 3]]);

    /* Garis sumbu sisi dan lingkaran luar. */
    [0, 1, 2].forEach((i) => {
      infinite(
        "perps",
        colors.O,
        (g) => g.mids[i],
        (g) => {
          const p = g.V[(i + 1) % 3];
          const q = g.V[(i + 2) % 3];
          return { x: g.mids[i].x - (q.y - p.y), y: g.mids[i].y + (q.x - p.x) };
        },
        { strokeOpacity: 0.8 },
      );
      dot("perps", colors.O, (g) => g.mids[i]);
      line("circumcircle", "thin", colors.O, (g) => g.O, (g) => g.V[i], { dash: 3 });
    });
    circle("circumcircle", colors.O, (g) => g.O, (g) => g.R);
    rightMark("perps", colors.O, (g, i) => {
      const p = g.V[(i + 1) % 3];
      const q = g.V[(i + 2) % 3];
      const m = g.mids[i];
      const n = { x: -(q.y - p.y), y: q.x - p.x };
      const toward = (g.V[i].x - m.x) * n.x + (g.V[i].y - m.y) * n.y >= 0 ? 1 : -1;
      return [m, { x: m.x + toward * n.x, y: m.y + toward * n.y }, q];
    });

    /* Garis tinggi: garis penuh (diperpanjang) dan ruas dari titik sudut ke kakinya. */
    [0, 1, 2].forEach((i) => {
      infinite("altitudes", colors.H, (g) => g.V[i], (g) => g.altFeet[i], { strokeOpacity: 0.7 });
      line("altitudes", "thin", colors.H, (g) => g.V[i], (g) => g.altFeet[i]);
      // Perpanjangan sisi sampai kaki garis tinggi (muncul pada segitiga tumpul).
      line(
        "altitudes",
        "thin",
        colors.H,
        (g) => g.altFeet[i],
        (g) => {
          const p = g.V[(i + 1) % 3];
          const q = g.V[(i + 2) % 3];
          const f = g.altFeet[i];
          const t = ((f.x - p.x) * (q.x - p.x) + (f.y - p.y) * (q.y - p.y)) / (dist(p, q) ** 2);
          const c = Math.min(1, Math.max(0, t));
          return { x: p.x + c * (q.x - p.x), y: p.y + c * (q.y - p.y) };
        },
        { dash: 3, strokeOpacity: 0.8 },
      );
      dot("altitudes", colors.H, (g) => g.altFeet[i]);
    });
    rightMark("altitudes", colors.H, (g, i) => {
      const p = g.V[(i + 1) % 3];
      const q = g.V[(i + 2) % 3];
      const f = g.altFeet[i];
      return [f, g.V[i], dist(f, p) >= dist(f, q) ? p : q];
    });

    /* Garis Euler. */
    infinite(
      "euler",
      colors.euler,
      (g) => g.O,
      (g) => (dist(g.O, g.H) < 1e-9 ? NAN_PT : g.H),
      { strokeOpacity: 1, strokeWidth: 2, dash: 0 },
    );

    /* Titik istimewa dan labelnya. */
    const slot = (key: CenterKey) => {
      const g = geo();
      if (!g) return 0;
      let n = 0;
      for (const other of CENTERS.slice(0, CENTERS.indexOf(key))) {
        if (!viewRef.current.show[other]) continue;
        const dx = (g[other].x - g[key].x) * board.unitX;
        const dy = (g[other].y - g[key].y) * board.unitY;
        if (Math.hypot(dx, dy) < 14) n += 1;
      }
      return n;
    };
    const finite = (n: number) => Number.isFinite(n);
    const centers = CENTERS.map((key) => {
      const get = (g: Geometry) => g[key];
      const point = create("point", xy(get), {
        name: "",
        withLabel: false,
        size: v.pointSize + 1,
        fillColor: colors[key],
        strokeColor: "#ffffff",
        strokeWidth: 1.5,
        showInfobox: false,
        layer: 7,
        ...base,
      });
      const label = create(
        "text",
        [
          () => {
            const g = geo();
            return g ? g[key].x + px(8) : 0;
          },
          () => {
            const g = geo();
            return g ? g[key].y + py(6 + slot(key) * 15) : 0;
          },
          () => {
            const g = geo();
            if (!g || !finite(g[key].x)) return "";
            return viewRef.current.pointLabels ? `${key} ${ptText(g[key])}` : key;
          },
        ],
        {
          anchorX: "left",
          anchorY: "bottom",
          fontSize: 12,
          strokeColor: colors[key],
          layer: 8,
          cssStyle:
            "font-weight:600;white-space:nowrap;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;",
          ...base,
        },
      );
      return { key, point, label };
    });

    /* Nama titik sudut (di luar segitiga) dan besar sudut (di dalam). */
    const text = (
      x: () => number,
      y: () => number,
      content: () => string,
      color: string,
      size: number,
      anchor: "left" | "middle",
    ) =>
      create("text", [x, y, content], {
        anchorX: anchor === "left" ? "left" : "middle",
        anchorY: "middle",
        fontSize: size,
        strokeColor: color,
        layer: 8,
        cssStyle:
          "font-weight:600;white-space:nowrap;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;",
        ...base,
      });
    const unit = (from: Pt, to: Pt) => {
      const len = dist(from, to) || 1;
      return { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
    };
    const vertexLabels = [0, 1, 2].map((i) => {
      const out = () => {
        const g = geo();
        if (!g) return { x: 0, y: 0, ok: false };
        const d = unit(g.G, g.V[i]);
        return { x: g.V[i].x + px(18) * d.x, y: g.V[i].y + py(18) * d.y, ok: true };
      };
      return text(
        () => out().x,
        () => out().y,
        () => {
          const g = geo();
          if (!g) return "";
          return viewRef.current.pointLabels ? `${NAMES[i]} ${ptText(g.V[i])}` : NAMES[i];
        },
        colors.tri,
        13,
        "middle",
      );
    });
    const angleLabels = [0, 1, 2].map((i) => {
      const spot = () => {
        const g = geo();
        if (!g) return { x: 0, y: 0 };
        const u = unit(g.V[i], g.V[(i + 1) % 3]);
        const w = unit(g.V[i], g.V[(i + 2) % 3]);
        const sx = u.x + w.x;
        const sy = u.y + w.y;
        const len = Math.hypot(sx, sy) || 1;
        return { x: g.V[i].x + (px(34) * sx) / len, y: g.V[i].y + (py(34) * sy) / len };
      };
      return text(
        () => spot().x,
        () => spot().y,
        () => {
          const g = geo();
          return g ? `${formatText(g.angles[i])}°` : "";
        },
        colors.muted,
        11,
        "middle",
      );
    });

    // Bila titik sudut diseret, simpan ke state React (digabung per frame).
    const push = () => {
      vertsRef.current = tri();
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setVerts(vertsRef.current);
      });
    };
    verticesEl.forEach((el) => el.on("drag", push));

    scene.current = {
      grid,
      axes: [xAxis, yAxis],
      items,
      verts: verticesEl,
      centers,
      vertexLabels,
      angleLabels,
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
      axis.defaultTicks.setAttribute({
        visible: v.axisNumbers,
        drawLabels: v.axisNumbers,
      }),
    );
    s.items.forEach(({ key, role, el }) => {
      const attrs: Record<string, unknown> = { visible: v.show[key] };
      if (role === "main") attrs.strokeWidth = v.curveWidth;
      if (role === "thin") attrs.strokeWidth = key === "euler" ? v.curveWidth : thin;
      if (role === "dot") attrs.size = Math.max(2, v.pointSize - 1);
      el.setAttribute(attrs);
    });
    s.verts.forEach((p) =>
      p.setAttribute({
        visible: v.show.tri,
        size: v.pointSize + 2,
        snapToGrid: v.snap,
      }),
    );
    s.vertexLabels.forEach((t) => t.setAttribute({ visible: v.show.tri }));
    s.angleLabels.forEach((t) => t.setAttribute({ visible: v.show.tri && v.angles }));
    s.centers.forEach(({ key, point, label }) => {
      point.setAttribute({ visible: v.show[key], size: v.pointSize + 1 });
      label.setAttribute({ visible: v.show[key] });
    });
    boardRef.current?.update();
  }

  useEffect(() => {
    applyView();
  }, [view]);

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  /* ───────── Perubahan dari pengguna ───────── */

  const applyVerts = (next: Verts) => {
    vertsRef.current = next;
    setVerts(next);
    const s = scene.current;
    if (s) {
      // Bentuk persis (mis. segitiga sama sisi) tidak berada di grid 0.5:
      // matikan tempel ke grid agar titik tidak bergeser.
      const onGrid = [next.A, next.B, next.C].every((p) =>
        [p.x, p.y].every((n) => Math.abs(n * 2 - Math.round(n * 2)) < 1e-9),
      );
      if (!onGrid && viewRef.current.snap) {
        updateView({ snap: false });
        s.verts.forEach((p) => p.setAttribute({ snapToGrid: false }));
      }
      [next.A, next.B, next.C].forEach((p, i) =>
        s.verts[i].setPosition(COORDS_BY_USER, [p.x, p.y]),
      );
    }
    boardRef.current?.update();
  };

  const randomTriangle = () => {
    const rnd = (lo: number, hi: number) => Math.round(lo + Math.random() * (hi - lo));
    for (let i = 0; i < 60; i += 1) {
      const next: Verts = {
        A: { x: rnd(-7, 7), y: rnd(-6, 6) },
        B: { x: rnd(-7, 7), y: rnd(-6, 6) },
        C: { x: rnd(-7, 7), y: rnd(-6, 6) },
      };
      const g = analyze(next);
      if (g && g.area >= 10 && Math.min(...g.angles) >= 20) {
        applyVerts(next);
        return;
      }
    }
    applyVerts(initialVerts);
  };

  const updateView = (patch: Partial<ViewState>) => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setStoredView(next);
  };
  const toggleShow = (key: ObjectKey) =>
    updateView({ show: { ...viewRef.current.show, [key]: !viewRef.current.show[key] } });
  const selectFocus = (focus: Focus) => updateView({ focus, show: focusShow(focus) });

  /* ───────── Nilai turunan ───────── */

  const g = useMemo(() => analyze(verts), [verts]);
  const kind = g ? classify(g) : null;
  const focus = view.focus;
  const activePreset = presets.find((p) => sameVerts(p.verts, verts));
  const undefinedTex = String.raw`\text{tak terdefinisi}`;

  const together =
    g !== null && dist(g.G, g.O) < 1e-6 && dist(g.G, g.H) < 1e-6 && dist(g.G, g.I) < 1e-6;
  const resultText = (() => {
    if (!g || !kind) {
      return "Ketiga titik sudut segaris, sehingga bukan segitiga. Geser salah satu titik sudut.";
    }
    const places = CENTERS.map((k) => `${k} ${placeText(locate(g[k], verts))}`).join("; ");
    const extra = together
      ? " Keempat titik berimpit di satu titik."
      : kind.bySides === "sama kaki"
        ? " Keempat titik terletak pada satu garis, yaitu sumbu simetri."
        : "";
    return `${kind.label}. ${together ? "" : places + "."}${extra}`;
  })();

  const centerTex = (k: CenterKey) => (g ? ptTex(k, g[k]) : undefinedTex);
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

  /* ───────── Tabel pembuktian sifat ───────── */

  const checkTable = (() => {
    if (!g) return null;
    const f = formatText;
    const head = (cols: string[], caption: string) => (
      <>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
      </>
    );
    if (focus === "G") {
      return (
        <table className="sim-table sim-table--left">
          {head(
            ["Garis", "Titik sudut ke G", "G ke tengah sisi", "Rasio"],
            "D, E, F adalah titik tengah sisi BC, CA, AB.",
          )}
          <tbody>
            {[0, 1, 2].map((i) => {
              const up = dist(g.V[i], g.G);
              const down = dist(g.G, g.mids[i]);
              return (
                <tr key={i}>
                  <th scope="row">{`${NAMES[i]}${MID_NAMES[i]}`}</th>
                  <td>{f(up)}</td>
                  <td>{f(down)}</td>
                  <td>{`${f(up / down)} : 1`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    }
    if (focus === "I") {
      return (
        <table className="sim-table sim-table--left">
          {head(["Sisi", "Jarak I ke sisi"], "Jarak tegak lurus dari I ke tiap sisi.")}
          <tbody>
            {[0, 1, 2].map((i) => (
              <tr key={i}>
                <th scope="row">{SIDE_NAMES[i]}</th>
                <td>{f(dist(g.I, g.touch[i]))}</td>
              </tr>
            ))}
            <tr className="sim-table__limit">
              <th scope="row">r</th>
              <td>{f(g.r)}</td>
            </tr>
          </tbody>
        </table>
      );
    }
    if (focus === "O") {
      return (
        <table className="sim-table sim-table--left">
          {head(["Ruas", "Panjang"], "Jarak O ke tiap titik sudut.")}
          <tbody>
            {[0, 1, 2].map((i) => (
              <tr key={i}>
                <th scope="row">{`O${NAMES[i]}`}</th>
                <td>{f(dist(g.O, g.V[i]))}</td>
              </tr>
            ))}
            <tr className="sim-table__limit">
              <th scope="row">R</th>
              <td>{f(g.R)}</td>
            </tr>
          </tbody>
        </table>
      );
    }
    if (focus === "H") {
      return (
        <table className="sim-table sim-table--left">
          {head(
            ["Garis tinggi", "Panjang", "Letak kaki"],
            "Kaki garis tinggi bisa jatuh di perpanjangan sisi.",
          )}
          <tbody>
            {[0, 1, 2].map((i) => {
              const p = locate(g.altFeet[i], verts);
              return (
                <tr key={i}>
                  <th scope="row">{`Dari ${NAMES[i]}`}</th>
                  <td>{f(g.heights[i])}</td>
                  <td>{p.kind === "outside" ? "di luar sisi" : "pada sisi"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    }
    const og = dist(g.O, g.G);
    const gh = dist(g.G, g.H);
    return together || og < 1e-6 ? (
      <p className="sim-hint">O, G, dan H berimpit, sehingga garis Euler tidak terdefinisi.</p>
    ) : (
      <table className="sim-table sim-table--left">
        {head(["Ruas", "Panjang"], "Perbandingan pada garis Euler.")}
        <tbody>
          <tr>
            <th scope="row">OG</th>
            <td>{f(og)}</td>
          </tr>
          <tr>
            <th scope="row">GH</th>
            <td>{f(gh)}</td>
          </tr>
          <tr className="sim-table__limit">
            <th scope="row">OG : GH</th>
            <td>{`1 : ${f(gh / og)}`}</td>
          </tr>
        </tbody>
      </table>
    );
  })();

  /* ───────── Rumus dengan nilai ───────── */

  const formulas: string[] = (() => {
    if (!g) return [];
    const [A, B, C] = g.V;
    const [a, b, c] = g.sides;
    const cr = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
    switch (focus) {
      case "G":
        return [
          String.raw`G=\left(\dfrac{x_A+x_B+x_C}{3},\ \dfrac{y_A+y_B+y_C}{3}\right)`,
          String.raw`G=\left(\dfrac{${sumTex([A.x, B.x, C.x])}}{3},\ \dfrac{${sumTex([A.y, B.y, C.y])}}{3}\right)`,
          ptTex("G", g.G),
        ];
      case "I":
        return [
          String.raw`I=\dfrac{a\,A+b\,B+c\,C}{a+b+c}`,
          String.raw`a=BC=${tn(a)},\ b=CA=${tn(b)},\ c=AB=${tn(c)}`,
          ptTex("I", g.I),
          String.raw`r=\dfrac{L}{s}=\dfrac{${tn(g.area)}}{${tn(g.perimeter / 2)}}=${tn(g.r)}`,
        ];
      case "O":
        return [
          String.raw`D=2\left[x_A(y_B-y_C)+x_B(y_C-y_A)+x_C(y_A-y_B)\right]=${tn(2 * cr)}`,
          String.raw`x_O=\dfrac{(x_A^2+y_A^2)(y_B-y_C)+(x_B^2+y_B^2)(y_C-y_A)+(x_C^2+y_C^2)(y_A-y_B)}{D}`,
          String.raw`y_O=\dfrac{(x_A^2+y_A^2)(x_C-x_B)+(x_B^2+y_B^2)(x_A-x_C)+(x_C^2+y_C^2)(x_B-x_A)}{D}`,
          ptTex("O", g.O),
          String.raw`R=\dfrac{abc}{4L}=\dfrac{${tn(a)}\cdot ${tn(b)}\cdot ${tn(c)}}{4\cdot ${tn(g.area)}}=${tn(g.R)}`,
        ];
      case "H":
        return [
          String.raw`H=A+B+C-2\,O`,
          String.raw`x_H=${sumTex([A.x, B.x, C.x])}-2\cdot ${paren(g.O.x)}=${tn(g.H.x)}`,
          String.raw`y_H=${sumTex([A.y, B.y, C.y])}-2\cdot ${paren(g.O.y)}=${tn(g.H.y)}`,
          ptTex("H", g.H),
        ];
      default:
        return [
          String.raw`\overrightarrow{OH}=3\,\overrightarrow{OG}\ \Rightarrow\ OG:GH=1:2`,
          String.raw`G=\dfrac{2\,O+H}{3}`,
          ptTex("O", g.O),
          ptTex("G", g.G),
          ptTex("H", g.H),
        ];
    }
  })();

  /* ───────── Tampilan ───────── */

  const info = focusText[focus];
  const overlayTex = !g
    ? String.raw`\text{bukan segitiga}`
    : focus === "all"
      ? String.raw`\triangle ABC`
      : ptTex(focus, g[focus]);

  return (
    <SimulationShell
      title="Simulasi titik istimewa segitiga"
      onReset={() => applyVerts(initialVerts)}
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
            icon={<AngleIcon />}
            label="Sudut"
            pressed={view.angles}
            onClick={() => updateView({ angles: !view.angles })}
          />
        </>
      }
      settings={
        <SimSection title="Garis dan titik">
          <SimSlider
            id="triangle-curve-width"
            name="tebal garis"
            label={`Tebal garis: ${view.curveWidth}`}
            value={view.curveWidth}
            min={1}
            max={8}
            step={1}
            onChange={(curveWidth) => updateView({ curveWidth })}
          />
          <SimSlider
            id="triangle-point-size"
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
                angles: initialView.angles,
                curveWidth: initialView.curveWidth,
                pointSize: initialView.pointSize,
                focus: initialView.focus,
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
          aria-label="Grafik segitiga ABC dengan titik berat, titik bagi, titik sumbu, dan titik tinggi. Seret titik sudut A, B, atau C untuk mengubah segitiga."
        />
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          <SimMath tex={overlayTex} />
          {kind && <span className="sim-overlay__sub">{kind.label}</span>}
        </p>
      }
      panel={
        <>
          <SimSection title="Pilih titik istimewa">
            <div className="sim-seg sim-seg--kinds" role="radiogroup" aria-label="Titik istimewa">
              {(["all", ...CENTERS] as Focus[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  className="sim-seg__btn"
                  aria-checked={focus === k}
                  style={
                    {
                      "--sim-accent": k === "all" ? colors.euler : colors[k],
                      ...(k === "all" ? { gridColumn: "1 / -1" } : {}),
                    } as CSSProperties
                  }
                  onClick={() => selectFocus(k)}
                >
                  {k === "all" ? "Semua titik dan garis Euler" : centerName[k]}
                </button>
              ))}
            </div>
            <p className="sim-hint">Seret titik sudut A, B, atau C di grafik.</p>
          </SimSection>

          <SimSection title="Contoh segitiga">
            <div className="sim-chips" role="group" aria-label="Contoh segitiga">
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="sim-chip"
                  aria-pressed={activePreset === p}
                  onClick={() => applyVerts(p.verts)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {activePreset && <p className="sim-callout">{activePreset.note}</p>}
          </SimSection>

          <SimSection title="Opsi">
            <div className="sim-btn-row">
              <button
                type="button"
                className="sim-text-btn"
                aria-pressed={view.snap}
                onClick={() => updateView({ snap: !view.snap })}
              >
                Tempel ke grid
              </button>
              <button type="button" className="sim-text-btn" onClick={randomTriangle}>
                Segitiga acak
              </button>
            </div>
          </SimSection>

          <SimSection title="Hasil">
            <p className="sim-callout" role="status" style={{ marginTop: 0 }}>
              {resultText}
            </p>
            <ul className="sim-rows" aria-live="polite">
              {row(
                "tri",
                colors.tri,
                <SimMath
                  tex={
                    g
                      ? String.raw`\triangle ABC:\ ${ptTex("A", g.V[0])},\ ${ptTex("B", g.V[1])},\ ${ptTex("C", g.V[2])}`
                      : String.raw`\triangle ABC`
                  }
                />,
                "segitiga",
              )}
              {row("G", colors.G, <SimMath tex={centerTex("G")} />, "titik berat")}
              {row("medians", colors.G, <span>Garis berat AD, BE, CF</span>, "garis berat")}
              {row("I", colors.I, <SimMath tex={centerTex("I")} />, "titik bagi")}
              {row("bisectors", colors.I, <span>Garis bagi sudut</span>, "garis bagi")}
              {row(
                "incircle",
                colors.I,
                <span>
                  Lingkaran dalam{" "}
                  <SimMath tex={g ? `r=${tn(g.r)}` : undefinedTex} />
                </span>,
                "lingkaran dalam",
              )}
              {row("O", colors.O, <SimMath tex={centerTex("O")} />, "titik sumbu")}
              {row("perps", colors.O, <span>Garis sumbu sisi</span>, "garis sumbu")}
              {row(
                "circumcircle",
                colors.O,
                <span>
                  Lingkaran luar{" "}
                  <SimMath tex={g ? `R=${tn(g.R)}` : undefinedTex} />
                </span>,
                "lingkaran luar",
              )}
              {row("H", colors.H, <SimMath tex={centerTex("H")} />, "titik tinggi")}
              {row("altitudes", colors.H, <span>Garis tinggi dari A, B, C</span>, "garis tinggi")}
              {row("euler", colors.euler, <span>Garis Euler (melalui O, G, H)</span>, "garis Euler")}
            </ul>
          </SimSection>

          {g && (
            <SimSection title="Data segitiga">
              <div className="sim-table-wrap">
                <table className="sim-table sim-table--left">
                  <caption>
                    Keliling {formatText(g.perimeter)}, luas {formatText(g.area)}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Titik</th>
                      <th scope="col">Sisi di depan</th>
                      <th scope="col">Sudut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[0, 1, 2].map((i) => (
                      <tr key={i}>
                        <th scope="row">{NAMES[i]}</th>
                        <td>{`${SIDE_NAMES[i]} = ${formatText(g.sides[i])}`}</td>
                        <td>{`${formatText(g.angles[i])}°`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SimSection>
          )}

          {g && (
            <SimSection title="Buktikan sifatnya">
              <div className="sim-table-wrap">{checkTable}</div>
              <p className="sim-hint">
                Seret titik sudut dan lihat: nilai berubah, tetapi sifatnya tetap.
              </p>
            </SimSection>
          )}

          {g && (
            <SimSection title="Rumus dan cara menggambar">
              <details className="sim-guide" open>
                <summary>Rumus dengan nilai saat ini</summary>
                {formulas.map((tex, i) => (
                  <div key={i} className="sim-wrap" style={{ overflowX: "auto" }}>
                    <SimMath tex={tex} />
                  </div>
                ))}
              </details>
              {info.steps.length > 0 && (
                <details className="sim-guide" style={{ marginTop: 6 }}>
                  <summary>Langkah menggambar dengan jangka</summary>
                  <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {info.steps.map((step) => (
                      <li key={step} className="sim-wrap">
                        {step}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </SimSection>
          )}
        </>
      }
      notes={
        <>
          <p style={{ margin: 0 }}>
            <strong style={{ color: focus === "all" ? colors.euler : colors[focus] }}>
              {info.title}:{" "}
            </strong>
            {info.definition}
          </p>
          <p style={{ margin: 0 }}>{info.property}</p>
        </>
      }
    />
  );
}
