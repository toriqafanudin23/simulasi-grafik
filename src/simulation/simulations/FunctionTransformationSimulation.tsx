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
import { clamp, formatText, snap, texNumber } from "../common/utils/simUtils";
import { useJsxBoard, type BoundingBox, type SimBoard } from "../common/hooks/useJsxBoard";
import { useStoredSimulationState } from "../common/hooks/useStoredSimulationState";

/* Simulasi transformasi fungsi.
   Kerangka, slider, dan CSS memakai kit umum (prefix sim-).

   Grafik hasil:  g(x) = a · f(b(x − h)) + k
   - h : geser mendatar (kanan jika positif)
   - k : geser tegak (atas jika positif)
   - a : regang tegak, a < 0 mencerminkan terhadap garis y = k
   - b : regang mendatar (lebar menjadi 1/|b| kali), b < 0 mencerminkan
         terhadap garis x = h

   Titik (x, y) pada f dipetakan ke (h + x/b, a·y + k) pada g.
   Fungsi awal f(x) bisa diketik sendiri (mis. x^2 − 3, sin(x), 1/x). */

/* ───────── Tipe ───────── */

type Vec = [number, number];
type Fn = (x: number) => number;
type Params = { h: number; k: number; a: number; b: number; x0: number };
type ObjectKey = "original" | "key" | "guide" | "probe";
type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean;
  curveWidth: number;
  pointSize: number;
  show: Record<ObjectKey, boolean>;
};

type Settable = { setAttribute: (attributes: Record<string, unknown>) => unknown };
type AxisElement = Settable & { defaultTicks: Settable };
type DataCurve = Settable & {
  dataX: number[];
  dataY: number[];
  updateDataArray: () => void;
};
/** Titik uji P yang bisa diseret sepanjang grafik f. */
type DragPoint = Settable & {
  X: () => number;
  Y: () => number;
  setPosition: (method: number, coords: number[]) => unknown;
  showElement: () => unknown;
  hideElement: () => unknown;
  on: (event: string, handler: () => void) => unknown;
};
type Scene = {
  grid: Settable;
  axes: AxisElement[];
  fCurve: Settable;
  gCurve: Settable;
  /** Garis bantu x = h, y = k, dan panah P → P′. */
  thin: Settable[];
  dots: { el: Settable; extra: number }[];
  handle: DragPoint;
};

/* ───────── Konstanta ───────── */

/** JXG.COORDS_BY_USER */
const COORDS_BY_USER = 1;
const SAMPLES = 900;
const X0_LIM = 8;

const initialBox: BoundingBox = [-12, 9, 12, -9];
const DEFAULT_EXPRESSION = "x^2";
const initialParams: Params = { h: 2, k: 1, a: 2, b: 1, x0: 1 };
const IDENTITY: Params = { h: 0, k: 0, a: 1, b: 1, x0: 0 };
const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: false,
  curveWidth: 3,
  pointSize: 4,
  show: { original: true, key: true, guide: true, probe: true },
};

const colors = {
  f: "#1565c0",
  g: "#c62828",
  shift: "#2e7d32",
  stretch: "#6557d2",
  probe: "#c28a00",
  guide: "#8f8f99",
  grid: "#dcdce2",
  axis: "#4a4a55",
};

const KEY_LETTERS = ["A", "B", "C", "D", "E"];
const KEY_CANDIDATES = [-2, -1, 0, 1, 2, 3, 0.5, 4, -3, -0.5, 8];

const sliderConfig = [
  { key: "h", tex: "h", min: -8, max: 8, step: 0.5, hint: "geser mendatar", accent: colors.shift },
  { key: "k", tex: "k", min: -8, max: 8, step: 0.5, hint: "geser tegak", accent: colors.shift },
  { key: "a", tex: "a", min: -4, max: 4, step: 0.25, hint: "regang tegak", accent: colors.stretch },
  { key: "b", tex: "b", min: -4, max: 4, step: 0.25, hint: "regang mendatar", accent: colors.stretch },
] as const;

const PRESETS: { label: string; expr: string }[] = [
  { label: "x", expr: "x" },
  { label: "x²", expr: "x^2" },
  { label: "x³", expr: "x^3" },
  { label: "|x|", expr: "abs(x)" },
  { label: "√x", expr: "sqrt(x)" },
  { label: "1/x", expr: "1/x" },
  { label: "sin x", expr: "sin(x)" },
  { label: "eˣ", expr: "e^x" },
  { label: "ln x", expr: "ln(x)" },
];

const finite = (value: number) => Number.isFinite(value);
const fmt = formatText;
const fmtPt = ([x, y]: Vec) => `(${fmt(x)}, ${fmt(y)})`;
const ptTex = ([x, y]: Vec) => String.raw`(${texNumber(x)},${texNumber(y)})`;

/** Parameter dari penyimpanan: angka terhingga, a dan b tidak nol. */
function cleanParams(raw: Partial<Params> | undefined): Params {
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const nonZero = (v: unknown, fallback: number) => {
    const n = num(v, fallback);
    return Math.abs(n) < 1e-9 ? fallback : n;
  };
  return {
    h: num(raw?.h, initialParams.h),
    k: num(raw?.k, initialParams.k),
    a: nonZero(raw?.a, initialParams.a),
    b: nonZero(raw?.b, initialParams.b),
    x0: num(raw?.x0, initialParams.x0),
  };
}

/* ───────── Pengurai rumus (tanpa eval) ───────── */

type Node =
  | { t: "num"; v: number }
  | { t: "x" }
  | { t: "const"; name: "e" | "pi" }
  | { t: "neg"; a: Node }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "^"; l: Node; r: Node }
  | { t: "call"; name: string; a: Node };

const FUNCS: Record<string, Fn> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sqrt: (u) => (u >= 0 ? Math.sqrt(u) : Number.NaN),
  abs: Math.abs,
  ln: (u) => (u > 0 ? Math.log(u) : Number.NaN),
  log: (u) => (u > 0 ? Math.log10(u) : Number.NaN),
  exp: Math.exp,
};
const NAMES = [...Object.keys(FUNCS), "pi"];

type Tok = { k: "num"; v: number } | { k: "id"; v: string } | { k: "op"; v: string };

function tokenize(src: string): Tok[] | null {
  const s = src
    .toLowerCase()
    .replace(/[−–—]/g, "-")
    .replace(/[×·∙]/g, "*")
    .replace(/÷/g, "/")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/ˣ/g, "^x")
    .replace(/π/g, "pi")
    .replace(/√/g, "sqrt")
    .replace(/,/g, ".")
    .replace(/\s+/g, "");
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j += 1;
      const text = s.slice(i, j);
      if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return null;
      out.push({ k: "num", v: Number(text) });
      i = j;
    } else if (/[a-z]/.test(c)) {
      const name = NAMES.find((n) => s.startsWith(n, i));
      if (name) {
        out.push({ k: "id", v: name });
        i += name.length;
      } else if (c === "x" || c === "e") {
        out.push({ k: "id", v: c });
        i += 1;
      } else {
        return null;
      }
    } else if ("+-*/^()".includes(c)) {
      out.push({ k: "op", v: c });
      i += 1;
    } else {
      return null;
    }
  }
  return out;
}

class ParseError extends Error {}

const SYNTAX_HINT = "Contoh: x^2 − 3, sin(x), 1/x, sqrt(x), abs(x), e^x, ln(x).";

function parseExpression(src: string): { node: Node } | { error: string } {
  const tokens = tokenize(src);
  if (!tokens || tokens.length === 0) {
    return { error: `Tulis fungsi dalam x. ${SYNTAX_HINT}` };
  }
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => {
    const tk = peek();
    return tk !== undefined && tk.k === "op" && tk.v === v;
  };
  // perkalian tersirat: 2x, x(x + 1), sin(x)cos(x); angka tidak ikut (x2 ditolak)
  const startsImplicit = () => {
    const tk = peek();
    return tk !== undefined && (tk.k === "id" || (tk.k === "op" && tk.v === "("));
  };

  const expr = (): Node => {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const op = isOp("+") ? "+" : "-";
      pos += 1;
      left = { t: "bin", op, l: left, r: term() };
    }
    return left;
  };
  const term = (): Node => {
    let left = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) {
        const op = isOp("*") ? "*" : "/";
        pos += 1;
        left = { t: "bin", op, l: left, r: unary() };
      } else if (startsImplicit()) {
        left = { t: "bin", op: "*", l: left, r: unary() };
      } else {
        return left;
      }
    }
  };
  const unary = (): Node => {
    if (isOp("-")) {
      pos += 1;
      return { t: "neg", a: unary() };
    }
    if (isOp("+")) {
      pos += 1;
      return unary();
    }
    return power();
  };
  const power = (): Node => {
    const base = atom();
    if (isOp("^")) {
      pos += 1;
      return { t: "bin", op: "^", l: base, r: unary() };
    }
    return base;
  };
  const atom = (): Node => {
    const tk = peek();
    if (!tk) throw new ParseError("Ekspresi belum lengkap.");
    if (tk.k === "num") {
      pos += 1;
      return { t: "num", v: tk.v };
    }
    if (tk.k === "op" && tk.v === "(") {
      pos += 1;
      const inner = expr();
      if (!isOp(")")) throw new ParseError("Tanda kurung belum ditutup.");
      pos += 1;
      return inner;
    }
    if (tk.k === "id") {
      pos += 1;
      if (tk.v === "x") return { t: "x" };
      if (tk.v === "e" || tk.v === "pi") {
        return { t: "const", name: tk.v === "e" ? "e" : "pi" };
      }
      // sin(x) atau sin x^2 (tanpa kurung: argumennya satu pangkat)
      const arg = isOp("(") ? atom() : power();
      return { t: "call", name: tk.v, a: arg };
    }
    throw new ParseError("Ada tanda yang tidak dikenali.");
  };

  try {
    const node = expr();
    if (pos < tokens.length) {
      throw new ParseError("Ada bagian yang tidak dikenali.");
    }
    return { node };
  } catch (error) {
    return {
      error:
        error instanceof ParseError
          ? `${error.message} ${SYNTAX_HINT}`
          : "Ekspresi tidak dapat dibaca.",
    };
  }
}

/** Pangkat; akar ganjil bilangan negatif tetap terdefinisi (mis. x^(1/3)). */
function pow(base: number, exponent: number) {
  if (base < 0 && Number.isFinite(exponent) && !Number.isInteger(exponent)) {
    const inverse = 1 / exponent;
    if (Number.isInteger(inverse) && Math.abs(inverse % 2) === 1) {
      return -Math.pow(-base, exponent);
    }
  }
  return Math.pow(base, exponent);
}

function compileNode(node: Node): Fn {
  switch (node.t) {
    case "num": {
      const v = node.v;
      return () => v;
    }
    case "x":
      return (x) => x;
    case "const": {
      const v = node.name === "e" ? Math.E : Math.PI;
      return () => v;
    }
    case "neg": {
      const inner = compileNode(node.a);
      return (x) => -inner(x);
    }
    case "call": {
      const inner = compileNode(node.a);
      const f = FUNCS[node.name];
      return (x) => f(inner(x));
    }
    case "bin": {
      const l = compileNode(node.l);
      const r = compileNode(node.r);
      switch (node.op) {
        case "+":
          return (x) => l(x) + r(x);
        case "-":
          return (x) => l(x) - r(x);
        case "*":
          return (x) => l(x) * r(x);
        case "/":
          return (x) => l(x) / r(x);
        default:
          return (x) => pow(l(x), r(x));
      }
    }
  }
}

const DEFAULT_NODE = (parseExpression(DEFAULT_EXPRESSION) as { node: Node }).node;

/* ───────── Rumus TeX ───────── */

/** Potongan TeX beserta tingkat ikatannya:
    1 jumlah · 2 perkalian · 3 minus depan · 4 pangkat/pecahan · 5 atom. */
type Piece = { s: string; p: number };

const wrap = (piece: Piece, min: number) =>
  piece.p >= min ? piece.s : String.raw`\left(${piece.s}\right)`;

/** Angka untuk TeX dengan sampai `digits` desimal. */
function num(value: number, digits = 2) {
  if (!Number.isFinite(value)) return String.raw`\text{—}`;
  if (Math.abs(value) < Math.pow(10, -digits) / 2) return "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    useGrouping: false,
  })
    .format(value)
    ;
}

/** Bagian kanan boleh dirapatkan dengan koefisien angka (2x, 2\sin, 2(x−1)). */
const joinsTight = (text: string) =>
  /^([A-Za-z(]|\\(sin|cos|tan|ln|log|sqrt|pi|left[(|]))/.test(text);

function renderNode(node: Node, arg: Piece): Piece {
  switch (node.t) {
    case "num":
      return { s: num(node.v, 3), p: 5 };
    case "x":
      return arg;
    case "const":
      return { s: node.name === "e" ? "e" : String.raw`\pi`, p: 5 };
    case "neg":
      return { s: `-${wrap(renderNode(node.a, arg), 4)}`, p: 3 };
    case "call": {
      const inner = renderNode(node.a, arg);
      if (node.name === "abs") {
        return { s: String.raw`\left|${inner.s}\right|`, p: 5 };
      }
      if (node.name === "sqrt") return { s: String.raw`\sqrt{${inner.s}}`, p: 5 };
      if (node.name === "exp") return { s: `e^{${inner.s}}`, p: 4 };
      return { s: `\\${node.name}\\left(${inner.s}\\right)`, p: 5 };
    }
    case "bin": {
      const l = renderNode(node.l, arg);
      const r = renderNode(node.r, arg);
      switch (node.op) {
        case "+":
          if (node.r.t === "neg") {
            const inner = renderNode(node.r.a, arg);
            return { s: `${l.s}-${wrap(inner, 2)}`, p: 1 };
          }
          return { s: `${l.s}+${r.s}`, p: 1 };
        case "-":
          return {
            s: `${l.s}-${node.r.t === "neg" ? String.raw`\left(${r.s}\right)` : wrap(r, 2)}`,
            p: 1,
          };
        case "*": {
          const left = wrap(l, 2);
          const right =
            node.r.t === "neg" ? String.raw`\left(${r.s}\right)` : wrap(r, 2);
          const joined =
            node.l.t === "num" && joinsTight(right)
              ? `${left}${right}`
              : String.raw`${left}\cdot ${right}`;
          return { s: joined, p: 2 };
        }
        case "/":
          return { s: String.raw`\dfrac{${l.s}}{${r.s}}`, p: 4 };
        default:
          return { s: `${wrap(l, 5)}^{${r.s}}`, p: 4 };
      }
    }
  }
}

/** Argumen b(x − h) sebagai TeX. */
function argPiece(h: number, b: number): Piece {
  const inner = h === 0 ? "x" : `x${h > 0 ? "-" : "+"}${num(Math.abs(h))}`;
  if (b === 1) return { s: inner, p: h === 0 ? 5 : 1 };
  if (b === -1) {
    return h === 0
      ? { s: "-x", p: 3 }
      : { s: String.raw`-\left(${inner}\right)`, p: 3 };
  }
  const coef = num(b);
  return h === 0
    ? { s: `${coef}x`, p: 2 }
    : { s: String.raw`${coef}\left(${inner}\right)`, p: 2 };
}

const plusConst = (text: string, c: number) =>
  c === 0 ? text : `${text}${c > 0 ? "+" : "-"}${num(Math.abs(c))}`;

/** Ruas kanan g(x) = a · f(b(x − h)) + k. */
function transformedTex(root: Node, p: Params) {
  const body = renderNode(root, argPiece(p.h, p.b));
  let main: string;
  if (p.a === 1) {
    main = body.s;
  } else if (p.a === -1) {
    main = `-${wrap(body, 4)}`;
  } else {
    const inner = wrap(body, 4);
    main = joinsTight(inner)
      ? `${num(p.a)}${inner}`
      : String.raw`${num(p.a)}\cdot ${inner}`;
  }
  return plusConst(main, p.k);
}

const originalTex = (root: Node) => renderNode(root, { s: "x", p: 5 }).s;

/** Aturan titik (x, y) → (h + x/b, a·y + k) dengan angka saat ini. */
function pointRuleTex({ h, k, a, b }: Params) {
  const xPart =
    b === 1 ? "x" : b === -1 ? "-x" : String.raw`\dfrac{x}{${num(b)}}`;
  const yPart = a === 1 ? "y" : a === -1 ? "-y" : `${num(a)}y`;
  return String.raw`(x,y)\to\left(${plusConst(xPart, h)},${plusConst(yPart, k)}\right)`;
}

function describeEffects({ h, k, a, b }: Params) {
  const magA = Math.abs(a);
  let vertical =
    magA === 1
      ? "tidak diregang"
      : magA > 1
        ? `diregang ×${fmt(magA)}`
        : `dimampatkan ×${fmt(magA)}`;
  if (a < 0) {
    vertical += `, dicerminkan terhadap ${k === 0 ? "sumbu x" : `garis y = ${fmt(k)}`}`;
  }

  const magB = Math.abs(b);
  let horizontal =
    magB === 1
      ? "tidak diregang"
      : magB > 1
        ? `dimampatkan ×${fmt(1 / magB)}`
        : `diregang ×${fmt(1 / magB)}`;
  if (b < 0) {
    horizontal += `, dicerminkan terhadap ${h === 0 ? "sumbu y" : `garis x = ${fmt(h)}`}`;
  }

  return [
    {
      title: "Geser mendatar (h)",
      text: h === 0 ? "tidak bergeser" : `${fmt(Math.abs(h))} satuan ke ${h > 0 ? "kanan" : "kiri"}`,
      tone: colors.shift,
    },
    {
      title: "Geser tegak (k)",
      text: k === 0 ? "tidak bergeser" : `${fmt(Math.abs(k))} satuan ke ${k > 0 ? "atas" : "bawah"}`,
      tone: colors.shift,
    },
    { title: "Regang tegak (a)", text: vertical, tone: colors.stretch },
    { title: "Regang mendatar (b)", text: horizontal, tone: colors.stretch },
  ];
}

/* ───────── Matematika ───────── */

/** Titik (x, y) pada f menjadi (h + x/b, a·y + k) pada g. */
const mapPoint = (p: Params, [x, y]: Vec): Vec => [p.h + x / p.b, p.a * y + p.k];

/** Absis titik kunci: lima titik pertama yang terdefinisi pada f. */
function computeKeys(fn: Fn) {
  const picked: number[] = [];
  for (const u of KEY_CANDIDATES) {
    const y = fn(u);
    if (Number.isFinite(y) && Math.abs(y) <= 30) {
      picked.push(u);
      if (picked.length === KEY_LETTERS.length) break;
    }
  }
  return picked.sort((m, n) => m - n);
}

function probeOf(fn: Fn, p: Params) {
  const y = fn(p.x0);
  if (!Number.isFinite(y)) return null;
  const base: Vec = [p.x0, y];
  return { base, image: mapPoint(p, base) };
}

/** Titik-titik kurva y = a·f(b(x − h)) + k. NaN memutus garis
    (asimtot tegak atau di luar daerah asal). */
function sampleCurve(fn: Fn, p: Params, xMin: number, xMax: number, ySpan: number) {
  const nodes: number[] = [];
  for (let i = 0; i <= SAMPLES; i += 1) {
    nodes.push(xMin + (i / SAMPLES) * (xMax - xMin));
  }
  // x = h adalah tempat argumen bernilai 0 (mis. asimtot 1/x)
  if (p.h > xMin && p.h < xMax) {
    nodes.push(p.h);
    nodes.sort((m, n) => m - n);
  }

  const limit = Math.max(1000, ySpan * 20);
  const xs: number[] = [];
  const ys: number[] = [];
  let prev: number | null = null;
  const cut = () => {
    if (xs.length > 0 && !Number.isNaN(xs[xs.length - 1])) {
      xs.push(Number.NaN);
      ys.push(Number.NaN);
    }
    prev = null;
  };

  for (const x of nodes) {
    const y = p.a * fn(p.b * (x - p.h)) + p.k;
    if (!Number.isFinite(y) || Math.abs(y) > limit) {
      cut();
      continue;
    }
    // lompatan besar dengan tanda berganti = asimtot tegak
    if (prev !== null && Math.abs(y - prev) > 2 * ySpan && y * prev < 0) {
      cut();
    }
    xs.push(x);
    ys.push(y);
    prev = y;
  }

  if (xs.length === 0) return { xs: [Number.NaN], ys: [Number.NaN] };
  return { xs, ys };
}

/* ───────── Komponen ───────── */

export function FunctionTransformationSimulation() {
  const [storedParams, setParams] = useStoredSimulationState<Params>(
    "functiontransformation.params",
    initialParams,
  );
  const [storedView, setStoredView] = useStoredSimulationState(
    "functiontransformation.view",
    initialView,
  );
  const [expression, setExpression] = useStoredSimulationState<string>(
    "functiontransformation.expression",
    DEFAULT_EXPRESSION,
  );
  const [exprText, setExprText] = useState(expression);
  const [exprError, setExprError] = useState<string | null>(null);

  // gabungkan dengan nilai bawaan agar pengaturan lama tetap valid
  const params = useMemo(() => cleanParams(storedParams), [storedParams]);
  const view = useMemo<ViewState>(
    () => ({
      ...initialView,
      ...storedView,
      show: { ...initialView.show, ...storedView.show },
    }),
    [storedView],
  );
  const parsed = useMemo(() => parseExpression(expression), [expression]);
  const node = useMemo(
    () => ("node" in parsed ? parsed.node : DEFAULT_NODE),
    [parsed],
  );
  const fn = useMemo(() => compileNode(node), [node]);
  const keys = useMemo(() => computeKeys(fn), [fn]);

  // data yang dibaca papan JSXGraph (selalu lewat ref agar tidak basi)
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const viewRef = useRef(view);
  viewRef.current = view;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const scene = useRef<Scene | null>(null);

  /** Titik uji diseret: tetap berada pada grafik f, absis dibulatkan 0.1. */
  const moveProbe = (rawX: number) => {
    const handle = scene.current?.handle;
    if (!handle) return;
    const nx = clamp(snap(rawX, 0.1), -X0_LIM, X0_LIM);
    const y = fnRef.current(nx);
    handle.setPosition(COORDS_BY_USER, [nx, Number.isFinite(y) ? y : handle.Y()]);
    const next: Params = { ...paramsRef.current, x0: nx };
    paramsRef.current = next;
    setParams(next);
    boardRef.current?.update();
  };

  /* ───────── Papan JSXGraph ───────── */

  const setup = (board: SimBoard) => {
    const v = viewRef.current;
    const show = (key: ObjectKey) => viewRef.current.show[key];
    const unit = () => {
      const raw = board as unknown as { unitX: number; unitY: number };
      return { ux: raw.unitX || 40, uy: raw.unitY || 40 };
    };
    const visibleRange = () => {
      const [x1, y1, x2, y2] = board.getBoundingBox() as number[];
      const margin = (x2 - x1) * 0.1;
      return { xMin: x1 - margin, xMax: x2 + margin, ySpan: Math.abs(y1 - y2) };
    };
    const extent = () => {
      const bb = board.getBoundingBox() as number[];
      return 4 * Math.max(...bb.map((value) => Math.abs(value))) + 30;
    };

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

    /** Kurva dari deret titik; null menyembunyikannya. */
    const makeCurve = (
      stroke: string,
      width: number,
      dash: number,
      build: () => { xs: number[]; ys: number[] } | null,
    ) => {
      const curve = board.create("curve", [[0], [0]], {
        strokeColor: stroke,
        strokeWidth: width,
        dash,
        highlight: false,
        fixed: true,
      }) as unknown as DataCurve;
      curve.updateDataArray = function updateDataArray() {
        const data = build();
        if (!data || data.xs.length === 0) {
          curve.dataX = [Number.NaN];
          curve.dataY = [Number.NaN];
          return;
        }
        curve.dataX = data.xs;
        curve.dataY = data.ys;
      };
      return curve;
    };
    const polyline = (points: Vec[] | null) =>
      !points || points.some((q) => !finite(q[0]) || !finite(q[1]))
        ? null
        : { xs: points.map((q) => q[0]), ys: points.map((q) => q[1]) };

    const thin: Settable[] = [];

    /* Garis bantu x = h dan y = k (tidak digambar bila berimpit dengan sumbu) */
    thin.push(
      makeCurve(colors.guide, 1.5, 2, () => {
        const { h } = paramsRef.current;
        if (!show("guide") || h === 0) return null;
        const s = extent();
        return polyline([
          [h, -s],
          [h, s],
        ]);
      }),
      makeCurve(colors.guide, 1.5, 2, () => {
        const { k } = paramsRef.current;
        if (!show("guide") || k === 0) return null;
        const s = extent();
        return polyline([
          [-s, k],
          [s, k],
        ]);
      }),
    );

    /* f(x) dan g(x) */
    const fCurve = makeCurve(colors.f, v.curveWidth, 0, () => {
      if (!show("original")) return null;
      const { xMin, xMax, ySpan } = visibleRange();
      return sampleCurve(fnRef.current, IDENTITY, xMin, xMax, ySpan);
    });
    const gCurve = makeCurve(colors.g, v.curveWidth, 0, () => {
      const { xMin, xMax, ySpan } = visibleRange();
      return sampleCurve(fnRef.current, paramsRef.current, xMin, xMax, ySpan);
    });

    /* Titik dan label (posisi NaN = tidak digambar) */
    const dots: { el: Settable; extra: number }[] = [];
    const dot = (x: () => number, y: () => number, fill: string, extra: number) => {
      const el = board.create("point", [x, y], {
        name: "",
        withLabel: false,
        size: v.pointSize + extra,
        fillColor: fill,
        strokeColor: "#ffffff",
        strokeWidth: 1.5,
        fixed: true,
        highlight: false,
        showInfobox: false,
      }) as unknown as Settable;
      dots.push({ el, extra });
      return el;
    };
    const label = (
      x: () => number,
      y: () => number,
      text: () => string,
      tone: string,
      offset: [number, number] = [8, 8],
    ) =>
      board.create(
        "text",
        [
          () => (finite(x()) ? x() + offset[0] / unit().ux : 0),
          () => (finite(y()) ? y() + offset[1] / unit().uy : 0),
          () => (finite(x()) && finite(y()) ? text() : ""),
        ],
        {
          anchorX: "left",
          anchorY: "bottom",
          fontSize: 12,
          strokeColor: tone,
          highlight: false,
          fixed: true,
          cssStyle:
            "font-weight:600;white-space:nowrap;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;",
        },
      );
    const withCoords = (name: string, x: number, y: number) =>
      `${name}${viewRef.current.pointLabels ? `(${fmt(x)}, ${fmt(y)})` : ""}`;

    // titik kunci: asal (A, B, ...) pada f dan bayangannya (A′, B′, ...) pada g
    const keyBase = (i: number): Vec => {
      const u = keysRef.current[i];
      if (!show("key") || u === undefined) return [Number.NaN, Number.NaN];
      return [u, fnRef.current(u)];
    };
    const keyImage = (i: number): Vec => {
      const base = keyBase(i);
      return Number.isNaN(base[0]) ? base : mapPoint(paramsRef.current, base);
    };
    KEY_LETTERS.forEach((name, i) => {
      dot(() => keyBase(i)[0], () => keyBase(i)[1], colors.f, 0);
      dot(() => keyImage(i)[0], () => keyImage(i)[1], colors.g, 0);
      label(
        () => keyBase(i)[0],
        () => keyBase(i)[1],
        () => withCoords(name, keyBase(i)[0], keyBase(i)[1]),
        colors.f,
        [6, 6],
      );
      label(
        () => keyImage(i)[0],
        () => keyImage(i)[1],
        () => withCoords(`${name}′`, keyImage(i)[0], keyImage(i)[1]),
        colors.g,
        [6, -18],
      );
    });

    /* Titik uji: P pada f (bisa diseret), P′ pada g, dan panahnya */
    const probe = () => (show("probe") ? probeOf(fnRef.current, paramsRef.current) : null);

    thin.push(
      makeCurve(colors.probe, 1.75, 0, () => {
        const pr = probe();
        if (!pr) return null;
        const [from, to] = [pr.base, pr.image];
        const { ux, uy } = unit();
        const dx = (to[0] - from[0]) * ux;
        const dy = (to[1] - from[1]) * uy;
        // terlalu pendek (dalam piksel): tanpa panah
        if (Math.hypot(dx, dy) < 14) return null;
        const phi = Math.atan2(dy, dx);
        const barb = (sign: 1 | -1): Vec => {
          const angle = phi + Math.PI + sign * 0.45;
          return [to[0] + (9 * Math.cos(angle)) / ux, to[1] + (9 * Math.sin(angle)) / uy];
        };
        return polyline([from, to, barb(1), to, barb(-1)]);
      }),
    );

    dot(
      () => probe()?.image[0] ?? Number.NaN,
      () => probe()?.image[1] ?? Number.NaN,
      colors.g,
      1,
    );
    label(
      () => probe()?.image[0] ?? Number.NaN,
      () => probe()?.image[1] ?? Number.NaN,
      () => withCoords("P′", probe()?.image[0] ?? 0, probe()?.image[1] ?? 0),
      colors.g,
      [8, -20],
    );
    label(
      () => probe()?.base[0] ?? Number.NaN,
      () => probe()?.base[1] ?? Number.NaN,
      () => withCoords("P", probe()?.base[0] ?? 0, probe()?.base[1] ?? 0),
      colors.f,
      [8, 8],
    );

    // titik uji P: bisa diseret (dibuat paling akhir agar berada di atas)
    const start = paramsRef.current;
    const y0 = fnRef.current(start.x0);
    const handle = board.create("point", [start.x0, Number.isFinite(y0) ? y0 : 0], {
      name: "",
      withLabel: false,
      size: v.pointSize + 3,
      face: "o",
      fillColor: colors.f,
      strokeColor: "#ffffff",
      strokeWidth: 2,
      fixed: false,
      highlight: false,
      snapToGrid: false,
      showInfobox: false,
    }) as unknown as DragPoint;
    handle.on("drag", () => moveProbe(handle.X()));
    dots.push({ el: handle, extra: 3 });

    scene.current = {
      grid,
      axes: [xAxis, yAxis],
      fCurve,
      gCurve,
      thin,
      dots,
      handle,
    };
    applyView();
  };

  const { boardProps, boardRef, zoomIn, zoomOut, resetView } = useJsxBoard({
    boundingBox: initialBox,
    setup,
    zoomRange: [0.15, 12],
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
    s.gCurve.setAttribute({ strokeWidth: v.curveWidth });
    s.fCurve.setAttribute({ strokeWidth: Math.max(1.5, v.curveWidth - 0.5) });
    s.thin.forEach((el) => el.setAttribute({ strokeWidth: thinWidth }));
    s.dots.forEach(({ el, extra }) => el.setAttribute({ size: v.pointSize + extra }));

    boardRef.current?.update();
  }

  useEffect(() => {
    applyView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Parameter, fungsi, atau pilihan berubah: samakan titik uji yang bisa
  // diseret dengan nilai penggeser (tetap di grafik f) lalu gambar ulang.
  useEffect(() => {
    const handle = scene.current?.handle;
    if (handle) {
      const y = fn(params.x0);
      if (view.show.probe && Number.isFinite(y)) {
        if (Math.abs(handle.X() - params.x0) > 1e-9 || Math.abs(handle.Y() - y) > 1e-9) {
          handle.setPosition(COORDS_BY_USER, [params.x0, y]);
        }
        handle.showElement();
      } else {
        handle.hideElement();
      }
    }
    boardRef.current?.update();
  }, [params, view.show.probe, fn, keys, boardRef]);

  /* ───────── Perubahan dari pengguna ───────── */

  const commitParams = (next: Params) => {
    paramsRef.current = next;
    setParams(next);
    boardRef.current?.update();
  };

  /** a dan b tidak boleh 0: nilai 0 dilewati ke sisi seberangnya. */
  const updateParam = (key: keyof Params, value: number) => {
    let next = value;
    if ((key === "a" || key === "b") && Math.abs(next) < 1e-9) {
      next = paramsRef.current[key] > 0 ? -0.25 : 0.25;
    }
    commitParams({ ...paramsRef.current, [key]: next });
  };

  const clearTransform = () =>
    commitParams({ ...paramsRef.current, h: 0, k: 0, a: 1, b: 1 });

  const changeExpression = (text: string) => {
    setExprText(text);
    const result = parseExpression(text);
    if ("error" in result) {
      setExprError(result.error);
      return;
    }
    setExprError(null);
    setExpression(text.trim());
  };

  const resetAll = () => {
    commitParams(initialParams);
    setExpression(DEFAULT_EXPRESSION);
    setExprText(DEFAULT_EXPRESSION);
    setExprError(null);
  };

  const updateView = (patch: Partial<ViewState>) => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setStoredView(next);
  };

  const toggleShow = (key: ObjectKey) =>
    updateView({ show: { ...viewRef.current.show, [key]: !viewRef.current.show[key] } });

  /* ───────── Nilai turunan ───────── */

  const fTex = originalTex(node);
  const gTex = transformedTex(node, params);
  const probeNow = probeOf(fn, params);
  const effects = describeEffects(params);
  const compact = (text: string) => text.replace(/\s+/g, "");
  const { h, k, a, b } = params;

  /* ───────── Tampilan ───────── */

  return (
    <SimulationShell
      title="Simulasi transformasi fungsi"
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
            name="tebal kurva"
            label={`Tebal kurva: ${view.curveWidth}`}
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
          aria-label="Grafik fungsi awal f(x) berwarna biru dan hasil transformasi g(x) berwarna merah. Seret latar untuk menggeser, cubit atau gulir untuk memperbesar, seret titik P untuk memindahkan titik uji sepanjang grafik f."
        />
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          <SimMath tex={`g(x)=${gTex}`} />
        </p>
      }
      panel={
        <>
          <SimSection title="Parameter" sticky>
            {sliderConfig.map(({ key, tex, min, max, step, hint, accent }) => (
              <SimSlider
                key={key}
                id={`transformation-${key}`}
                name={key}
                label={<SimMath tex={`${tex}=${texNumber(params[key])}`} />}
                hint={hint}
                accent={accent}
                value={params[key]}
                min={min}
                max={max}
                step={step}
                valueText={`${key} sama dengan ${params[key]}`}
                onChange={(value) => updateParam(key, value)}
              />
            ))}
          </SimSection>

          <SimSection title="Cermin">
            <div className="sim-seg">
              <button
                type="button"
                className="sim-seg__btn"
                aria-pressed={a < 0}
                onClick={() => updateParam("a", -a)}
              >
                Cermin tegak (a → −a)
              </button>
              <button
                type="button"
                className="sim-seg__btn"
                aria-pressed={b < 0}
                onClick={() => updateParam("b", -b)}
              >
                Cermin mendatar (b → −b)
              </button>
              <button type="button" className="sim-seg__btn" onClick={clearTransform}>
                Tanpa ubahan
              </button>
            </div>
          </SimSection>

          <SimSection title="Titik uji P (seret di grafik)">
            <SimSlider
              id="transformation-x0"
              name="x₀"
              label={<SimMath tex={`x_{0}=${texNumber(params.x0)}`} />}
              hint="absis titik uji P"
              accent={colors.probe}
              value={clamp(params.x0, -X0_LIM, X0_LIM)}
              min={-X0_LIM}
              max={X0_LIM}
              step={0.1}
              valueText={`x nol sama dengan ${params.x0}`}
              onChange={(value) => updateParam("x0", value)}
            />
          </SimSection>

          <SimSection title="Fungsi awal f(x)">
            <div className="sim-slot" style={{ "--sim-accent": colors.f } as CSSProperties}>
              <SimMath tex="f(x)=" />
              <input
                id="transformation-expression"
                className="sim-input"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                aria-label="Rumus fungsi awal f(x)"
                aria-invalid={!!exprError}
                value={exprText}
                onChange={(event) => changeExpression(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
            <p className={`sim-status${exprError ? " is-error" : ""}`} role="status">
              {exprError ??
                "Boleh memakai + − * / ^, sin cos tan, sqrt abs ln log exp, e, dan pi."}
            </p>
            <div className="sim-chips" role="group" aria-label="Contoh fungsi awal">
              {PRESETS.map((item) => (
                <button
                  key={item.expr}
                  type="button"
                  className="sim-chip"
                  aria-pressed={compact(expression) === item.expr}
                  onClick={() => changeExpression(item.expr)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </SimSection>

          <SimSection title="Hasil">
            <ul className="sim-rows" aria-live="polite">
              <SimRow
                color={colors.f}
                visible={view.show.original}
                onToggle={() => toggleShow("original")}
                toggleLabel="Tampilkan atau sembunyikan grafik f(x)"
              >
                <SimMath tex={`f(x)=${fTex}`} />
              </SimRow>
              <SimRow color={colors.g}>
                <SimMath tex={`g(x)=${gTex}`} />
              </SimRow>
              <SimRow
                color={colors.guide}
                visible={view.show.guide}
                onToggle={() => toggleShow("guide")}
                toggleLabel="Tampilkan atau sembunyikan garis x = h dan y = k"
              >
                <SimMath tex={`x=h=${texNumber(h)},\\ y=k=${texNumber(k)}`} />
              </SimRow>
              <SimRow>
                <SimMath tex={pointRuleTex(params)} />
              </SimRow>
              <SimRow
                color={colors.probe}
                visible={view.show.probe}
                onToggle={() => toggleShow("probe")}
                toggleLabel="Tampilkan atau sembunyikan titik uji P"
              >
                {probeNow ? (
                  <SimMath tex={String.raw`P${ptTex(probeNow.base)}\to P'${ptTex(probeNow.image)}`} />
                ) : (
                  <span>f belum terdefinisi di x₀</span>
                )}
              </SimRow>
              <SimRow
                color={colors.f}
                visible={view.show.key}
                onToggle={() => toggleShow("key")}
                toggleLabel="Tampilkan atau sembunyikan titik kunci"
              >
                <span>Titik kunci A → A′, B → B′, …</span>
              </SimRow>
              {keys.map((u, i) => {
                const base: Vec = [u, fn(u)];
                return (
                  <SimRow key={u}>
                    <SimMath
                      tex={String.raw`${KEY_LETTERS[i]}${ptTex(base)}\to ${KEY_LETTERS[i]}'${ptTex(mapPoint(params, base))}`}
                    />
                  </SimRow>
                );
              })}
              {effects.map((item) => (
                <SimRow key={item.title} color={item.tone}>
                  <span className="sim-wrap">
                    <strong style={{ color: item.tone }}>{item.title}</strong>
                    {": "}
                    {item.text}
                  </span>
                </SimRow>
              ))}
            </ul>
          </SimSection>
        </>
      }
      notes={
        <>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.shift }}>Geser </strong>
            <SimMath tex="h" />
            {" dan "}
            <SimMath tex="k" />
            {": grafik f digeser "}
            {h === 0 ? "tidak mendatar" : `${fmt(Math.abs(h))} satuan ke ${h > 0 ? "kanan" : "kiri"}`}
            {" dan "}
            {k === 0 ? "tidak tegak" : `${fmt(Math.abs(k))} satuan ke ${k > 0 ? "atas" : "bawah"}`}
            {". Dalam rumus, x diganti "}
            <SimMath tex="x-h" />
            {" dan seluruh hasil ditambah "}
            <SimMath tex="k" />
            .
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.stretch }}>Regang tegak </strong>
            <SimMath tex="a" />
            {": tinggi grafik dikalikan "}
            <SimMath tex={`|a|=${texNumber(Math.abs(a))}`} />
            {a < 0 ? ", lalu dicerminkan terhadap garis y = k karena a negatif." : "."}
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.stretch }}>Regang mendatar </strong>
            <SimMath tex="b" />
            {": lebar grafik dikalikan "}
            <SimMath tex={`\\dfrac{1}{|b|}=${texNumber(1 / Math.abs(b))}`} />
            {b < 0 ? ", lalu dicerminkan terhadap garis x = h karena b negatif." : "."}
          </p>
          <p style={{ margin: 0 }}>
            <strong>Titik yang bersesuaian: </strong>
            <SimMath tex={pointRuleTex(params)} />
            {probeNow ? ` — misalnya P ${fmtPt(probeNow.base)} menjadi P′ ${fmtPt(probeNow.image)}.` : "."}
          </p>
        </>
      }
    />
  );
}

export default FunctionTransformationSimulation;
