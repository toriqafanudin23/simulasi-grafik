/* Perhitungan geometri titik istimewa segitiga.
   Indeks 0, 1, 2 selalu merujuk ke titik sudut A, B, C dan ke sisi di
   depannya (a = BC, b = CA, c = AB). */

export type Pt = { x: number; y: number };
export type Tri = { A: Pt; B: Pt; C: Pt };
export type Trio<T> = [T, T, T];

export const NAN_PT: Pt = { x: Number.NaN, y: Number.NaN };

export const dist = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);
const lerp = (p: Pt, q: Pt, t: number): Pt => ({
  x: p.x + (q.x - p.x) * t,
  y: p.y + (q.y - p.y) * t,
});
const cross3 = (p: Pt, q: Pt, r: Pt) =>
  (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

/** Kaki garis tegak lurus dari P ke garis yang melalui Q dan R. */
export function foot(p: Pt, q: Pt, r: Pt): Pt {
  const dx = r.x - q.x;
  const dy = r.y - q.y;
  const t = ((p.x - q.x) * dx + (p.y - q.y) * dy) / (dx * dx + dy * dy);
  return { x: q.x + t * dx, y: q.y + t * dy };
}

export type Geometry = {
  V: Trio<Pt>;
  /** Panjang sisi a = BC, b = CA, c = AB. */
  sides: Trio<number>;
  /** Sudut A, B, C dalam derajat. */
  angles: Trio<number>;
  area: number;
  perimeter: number;
  G: Pt;
  I: Pt;
  O: Pt;
  H: Pt;
  /** Jari-jari lingkaran dalam dan lingkaran luar. */
  r: number;
  R: number;
  /** Titik tengah sisi BC, CA, AB. */
  mids: Trio<Pt>;
  /** Kaki garis bagi dari A, B, C pada sisi di depannya. */
  bisectFeet: Trio<Pt>;
  /** Kaki garis tinggi dari A, B, C pada sisi di depannya. */
  altFeet: Trio<Pt>;
  /** Titik singgung lingkaran dalam pada sisi BC, CA, AB. */
  touch: Trio<Pt>;
  /** Panjang garis tinggi dari A, B, C. */
  heights: Trio<number>;
};

/** Mengembalikan null bila ketiga titik segaris (bukan segitiga). */
export function analyze({ A, B, C }: Tri): Geometry | null {
  const V: Trio<Pt> = [A, B, C];
  if (V.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;

  const a = dist(B, C);
  const b = dist(C, A);
  const c = dist(A, B);
  const cr = cross3(A, B, C);
  const area = Math.abs(cr) / 2;
  if (area < 1e-9) return null;

  const perimeter = a + b + c;
  const ang = (opp: number, s1: number, s2: number) =>
    (Math.acos(Math.min(1, Math.max(-1, (s1 * s1 + s2 * s2 - opp * opp) / (2 * s1 * s2)))) *
      180) /
    Math.PI;
  const angles: Trio<number> = [ang(a, b, c), ang(b, c, a), ang(c, a, b)];

  const G = { x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 };
  const I = {
    x: (a * A.x + b * B.x + c * C.x) / perimeter,
    y: (a * A.y + b * B.y + c * C.y) / perimeter,
  };

  // Pusat lingkaran luar (perpotongan garis sumbu), D = 2 * cross.
  const d = 2 * cr;
  const sA = A.x * A.x + A.y * A.y;
  const sB = B.x * B.x + B.y * B.y;
  const sC = C.x * C.x + C.y * C.y;
  const O = {
    x: (sA * (B.y - C.y) + sB * (C.y - A.y) + sC * (A.y - B.y)) / d,
    y: (sA * (C.x - B.x) + sB * (A.x - C.x) + sC * (B.x - A.x)) / d,
  };
  // Titik tinggi: H = A + B + C - 2O
  const H = { x: A.x + B.x + C.x - 2 * O.x, y: A.y + B.y + C.y - 2 * O.y };

  const mids: Trio<Pt> = [lerp(B, C, 0.5), lerp(C, A, 0.5), lerp(A, B, 0.5)];
  const bisectFeet: Trio<Pt> = [
    lerp(B, C, c / (b + c)),
    lerp(C, A, a / (c + a)),
    lerp(A, B, b / (a + b)),
  ];
  const altFeet: Trio<Pt> = [foot(A, B, C), foot(B, C, A), foot(C, A, B)];
  const touch: Trio<Pt> = [foot(I, B, C), foot(I, C, A), foot(I, A, B)];

  return {
    V,
    sides: [a, b, c],
    angles,
    area,
    perimeter,
    G,
    I,
    O,
    H,
    r: (2 * area) / perimeter,
    R: (a * b * c) / (4 * area),
    mids,
    bisectFeet,
    altFeet,
    touch,
    heights: [(2 * area) / a, (2 * area) / b, (2 * area) / c],
  };
}

/* ───────── Letak titik terhadap segitiga ───────── */

export type Place =
  | { kind: "inside" }
  | { kind: "outside" }
  | { kind: "edge"; side: number }
  | { kind: "vertex"; index: number };

export function locate(p: Pt, { A, B, C }: Tri): Place {
  const total = cross3(A, B, C);
  const lam = [cross3(p, B, C) / total, cross3(A, p, C) / total, cross3(A, B, p) / total];
  const tol = 1e-6;
  if (lam.some((l) => l < -tol)) return { kind: "outside" };
  const zeros = lam.map((l, i) => (Math.abs(l) <= tol ? i : -1)).filter((i) => i >= 0);
  if (zeros.length >= 2) return { kind: "vertex", index: [0, 1, 2].find((i) => !zeros.includes(i)) ?? 0 };
  if (zeros.length === 1) return { kind: "edge", side: zeros[0] };
  return { kind: "inside" };
}

const NAMES = ["A", "B", "C"] as const;
const SIDES = ["BC", "CA", "AB"] as const;

export function placeText(place: Place): string {
  switch (place.kind) {
    case "inside":
      return "di dalam segitiga";
    case "outside":
      return "di luar segitiga";
    case "edge":
      return `pada sisi ${SIDES[place.side]}`;
    case "vertex":
      return `berimpit dengan titik sudut ${NAMES[place.index]}`;
  }
}

/* ───────── Jenis segitiga ───────── */

export type Kind = {
  bySides: "sama sisi" | "sama kaki" | "sembarang";
  byAngle: "lancip" | "siku-siku" | "tumpul";
  /** Indeks titik sudut siku-siku atau tumpul (bila ada). */
  special: number | null;
  label: string;
};

export function classify(g: Geometry): Kind {
  const [a, b, c] = g.sides;
  const eq = (p: number, q: number) => Math.abs(p - q) < 0.005;
  const bySides = eq(a, b) && eq(b, c) ? "sama sisi" : eq(a, b) || eq(b, c) || eq(a, c) ? "sama kaki" : "sembarang";
  const big = g.angles.indexOf(Math.max(...g.angles));
  const m = g.angles[big];
  const byAngle = Math.abs(m - 90) < 0.05 ? "siku-siku" : m > 90 ? "tumpul" : "lancip";
  const special = byAngle === "lancip" ? null : big;
  const label =
    bySides === "sama sisi"
      ? "Segitiga sama sisi"
      : `Segitiga ${byAngle}${bySides === "sama kaki" ? " sama kaki" : ""}`;
  return { bySides, byAngle, special, label };
}
