/**
 * Perhitungan untuk simulasi Sistem Persamaan dan Pertidaksamaan Linear:
 * normalisasi garis, penyelesaian SPLDV, daerah penyelesaian (pemotongan
 * setengah-bidang) dan nilai optimum program linear. Tanpa dependensi.
 */

export type Op = "<=" | ">=" | "<" | ">" | "=";
export type Pt = { x: number; y: number };
export type Line = { a: number; b: number; c: number }; // ax + by = c
export type Cons = Line & { op: Op };
export type Box = [number, number, number, number]; // [xmin, ymax, xmax, ymin] seperti JSXGraph

export const BIG = 1e5;
const EPS = 1e-9;

export const OP_SYMBOL: Record<Op, string> = {
  "<=": "≤",
  ">=": "≥",
  "<": "<",
  ">": ">",
  "=": "=",
};

export function validLine(l: Line): boolean {
  return Math.hypot(l.a, l.b) > 1e-9;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y > 1e-9) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/**
 * Menyederhanakan ax + by = c (bilangan bulat dibagi FPB) dan memilih tanda
 * sehingga searah dengan `prev`; dengan begitu sisi pertidaksamaan tidak terbalik
 * saat garis digeser.
 */
export function normalizeLine(l: Line, prev?: Line): Line {
  let { a, b, c } = l;
  const isInt = [a, b, c].every((v) => Math.abs(v - Math.round(v)) < 1e-9);
  if (isInt) {
    a = Math.round(a);
    b = Math.round(b);
    c = Math.round(c);
    const g = gcd(gcd(a, b), c);
    if (g > 0 && (a !== 0 || b !== 0)) {
      a /= g;
      b /= g;
      c /= g;
    }
  } else {
    a = Math.round(a * 1000) / 1000;
    b = Math.round(b * 1000) / 1000;
    c = Math.round(c * 1000) / 1000;
  }
  let s = 1;
  if (prev) {
    const dot = a * prev.a + b * prev.b;
    if (Math.abs(dot) > 1e-12) s = dot < 0 ? -1 : 1;
    else s = c * prev.c < 0 ? -1 : 1;
  } else {
    const lead = Math.abs(a) > 1e-12 ? a : b;
    s = lead < 0 ? -1 : 1;
  }
  return { a: a * s + 0, b: b * s + 0, c: c * s + 0 };
}

export function lineFromPoints(p: Pt, q: Pt): Line {
  const a = q.y - p.y;
  const b = p.x - q.x;
  return { a, b, c: a * p.x + b * p.y };
}

/** Dua titik pegangan pada garis; diusahakan titik kisi (bilangan bulat) di dalam tampilan. */
export function handlePoints(l: Line, box: Box): [Pt, Pt] {
  const [xmin, ymax, xmax, ymin] = box;
  const cx = (xmin + xmax) / 2;
  const cy = (ymin + ymax) / 2;
  const cand: Pt[] = [];
  const near = (v: number) => Math.abs(v - Math.round(v)) < 1e-9;
  if (Math.abs(l.b) >= Math.abs(l.a)) {
    for (let x = Math.ceil(xmin); x <= Math.floor(xmax); x += 1) {
      const y = (l.c - l.a * x) / l.b;
      if (near(y) && y >= ymin && y <= ymax) cand.push({ x, y: Math.round(y) + 0 });
    }
  } else {
    for (let y = Math.ceil(ymin); y <= Math.floor(ymax); y += 1) {
      const x = (l.c - l.b * y) / l.a;
      if (near(x) && x >= xmin && x <= xmax) cand.push({ x: Math.round(x) + 0, y });
    }
  }
  const dist = (p: Pt) => Math.hypot(p.x - cx, p.y - cy);
  const span = Math.min(xmax - xmin, ymax - ymin);
  if (cand.length >= 2) {
    cand.sort((p, q) => dist(p) - dist(q));
    const first = cand[0];
    const minGap = span / 6;
    const second =
      cand.find((p) => p !== first && Math.hypot(p.x - first.x, p.y - first.y) >= minGap) ??
      cand.find((p) => p !== first)!;
    return [first, second];
  }
  // tidak ada titik kisi: pakai kaki tegak lurus dari pusat tampilan
  const n2 = l.a * l.a + l.b * l.b;
  const t = (l.c - l.a * cx - l.b * cy) / n2;
  const fx = cx + t * l.a;
  const fy = cy + t * l.b;
  const len = Math.hypot(l.a, l.b);
  const dx = (-l.b / len) * (span / 4);
  const dy = (l.a / len) * (span / 4);
  return [
    { x: fx - dx, y: fy - dy },
    { x: fx + dx, y: fy + dy },
  ];
}

export function sameLine(l1: Line, l2: Line): boolean {
  if (!validLine(l1) || !validLine(l2)) return false;
  const n1 = Math.hypot(l1.a, l1.b);
  const n2 = Math.hypot(l2.a, l2.b);
  return (
    Math.abs(l1.a / n1 - l2.a / n2) < 1e-7 &&
    Math.abs(l1.b / n1 - l2.b / n2) < 1e-7 &&
    Math.abs(l1.c / n1 - l2.c / n2) < 1e-7
  );
}

// ───────────────────────── SPLDV ─────────────────────────
export type Sol =
  | { kind: "unique"; x: number; y: number; D: number; Dx: number; Dy: number }
  | { kind: "parallel" }
  | { kind: "same" };

export function solve2(l1: Line, l2: Line): Sol {
  const D = l1.a * l2.b - l2.a * l1.b;
  const Dx = l1.c * l2.b - l2.c * l1.b;
  const Dy = l1.a * l2.c - l2.a * l1.c;
  if (Math.abs(D) < 1e-9) {
    const same = Math.abs(Dx) < 1e-9 && Math.abs(Dy) < 1e-9;
    return same ? { kind: "same" } : { kind: "parallel" };
  }
  return { kind: "unique", x: Dx / D, y: Dy / D, D, Dx, Dy };
}

// ───────────────────────── Daerah penyelesaian ─────────────────────────
type Half = { A: number; B: number; C: number }; // keep Ax + By <= C

function halves(c: Cons): Half[] {
  const le: Half = { A: c.a, B: c.b, C: c.c };
  const ge: Half = { A: -c.a, B: -c.b, C: -c.c };
  if (c.op === "<=" || c.op === "<") return [le];
  if (c.op === ">=" || c.op === ">") return [ge];
  return [le, ge];
}

function dedupe(poly: Pt[], tol = 1e-7): Pt[] {
  const out: Pt[] = [];
  poly.forEach((p) => {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > tol) out.push(p);
  });
  while (
    out.length > 1 &&
    Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= tol
  ) {
    out.pop();
  }
  return out;
}

export function clipPoly(poly: Pt[], h: Half): Pt[] {
  const n = Math.hypot(h.A, h.B);
  if (n < 1e-12 || poly.length === 0) return poly;
  const dist = (p: Pt) => (h.A * p.x + h.B * p.y - h.C) / n;
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const cur = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const dc = dist(cur);
    const dp = dist(prev);
    const inC = dc <= EPS;
    const inP = dp <= EPS;
    const cross = () => {
      if (Math.abs(dp - dc) < 1e-15) return cur;
      const t = Math.max(0, Math.min(1, dp / (dp - dc)));
      return { x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) };
    };
    if (inC) {
      if (!inP) out.push(cross());
      out.push(cur);
    } else if (inP) {
      out.push(cross());
    }
  }
  return dedupe(out);
}

export function boxPoly(xmin: number, ymax: number, xmax: number, ymin: number): Pt[] {
  return [
    { x: xmin, y: ymin },
    { x: xmax, y: ymin },
    { x: xmax, y: ymax },
    { x: xmin, y: ymax },
  ];
}

export function clipByCons(poly: Pt[], c: Cons): Pt[] {
  let out = poly;
  halves(c).forEach((h) => {
    out = clipPoly(out, h);
  });
  return out;
}

export function clipToBox(poly: Pt[], box: Box): Pt[] {
  const [xmin, ymax, xmax, ymin] = box;
  let out = poly;
  out = clipPoly(out, { A: 1, B: 0, C: xmax });
  out = clipPoly(out, { A: -1, B: 0, C: -xmin });
  out = clipPoly(out, { A: 0, B: 1, C: ymax });
  out = clipPoly(out, { A: 0, B: -1, C: -ymin });
  return out;
}

export type Region = {
  poly: Pt[]; // termasuk titik pada kotak besar bila tak terbatas
  vertices: Pt[]; // titik sudut sejati
  empty: boolean;
  unbounded: boolean;
};

const onBox = (p: Pt) => Math.abs(p.x) >= BIG * 0.99 || Math.abs(p.y) >= BIG * 0.99;

export function feasibleRegion(cons: Cons[]): Region {
  let poly = boxPoly(-BIG, BIG, BIG, -BIG);
  cons.forEach((c) => {
    if (validLine(c)) poly = clipByCons(poly, c);
  });
  if (poly.length === 0) return { poly, vertices: [], empty: true, unbounded: false };
  const r8 = (v: number) => Math.round(v * 1e7) / 1e7 + 0;
  const vertices = dedupe(poly.filter((p) => !onBox(p))).map((p) => ({ x: r8(p.x), y: r8(p.y) }));
  const unbounded = poly.some(onBox);
  return { poly, vertices, empty: false, unbounded };
}

// ───────────────────────── Optimum ─────────────────────────
export type Goal = "max" | "min";
export type Opt =
  | { status: "optimal"; z: number; points: Pt[] }
  | { status: "unbounded" }
  | { status: "empty" }
  | { status: "constant" };

export function optimize(region: Region, p: number, q: number, goal: Goal): Opt {
  if (region.empty) return { status: "empty" };
  if (Math.abs(p) < 1e-12 && Math.abs(q) < 1e-12) return { status: "constant" };
  const z = (pt: Pt) => p * pt.x + q * pt.y;
  const pick = (vals: number[]) => (goal === "max" ? Math.max(...vals) : Math.min(...vals));
  const boxVerts = region.poly.filter(onBox);
  const trueZ = region.vertices.map(z);
  if (trueZ.length === 0) return { status: "unbounded" };
  const bestTrue = pick(trueZ);
  const tol = 1e-6 * (1 + Math.abs(bestTrue));
  if (boxVerts.length > 0) {
    const bestBox = pick(boxVerts.map(z));
    const better = goal === "max" ? bestBox > bestTrue + tol : bestBox < bestTrue - tol;
    if (better) return { status: "unbounded" };
  }
  const points = region.vertices.filter((v) => Math.abs(z(v) - bestTrue) <= tol);
  return { status: "optimal", z: bestTrue, points };
}

// ───────────────────────── Format ─────────────────────────
export function fmtN(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) < Math.pow(10, -digits) / 2) return "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    useGrouping: false,
  })
    .format(v)
    .replace("-", "−");
}

export function ptText(p: Pt): string {
  return `(${fmtN(p.x)}, ${fmtN(p.y)})`;
}

export function formatEq(c: Cons): string {
  const terms: string[] = [];
  const add = (coef: number, v: string) => {
    if (Math.abs(coef) < 1e-9) return;
    const mag = Math.abs(coef);
    const body = `${Math.abs(mag - 1) < 1e-9 ? "" : fmtN(mag)}${v}`;
    if (terms.length === 0) terms.push(coef < 0 ? `−${body}` : body);
    else terms.push(coef < 0 ? `− ${body}` : `+ ${body}`);
  };
  add(c.a, "x");
  add(c.b, "y");
  const left = terms.length ? terms.join(" ") : "0";
  return `${left} ${OP_SYMBOL[c.op]} ${fmtN(c.c)}`;
}
