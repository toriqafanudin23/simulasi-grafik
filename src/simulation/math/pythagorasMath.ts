/* Perhitungan geometri simulasi Teorema Pythagoras.
   Titik sudut C berada di (0, 0), B di (a, 0), dan A di (b cos γ, b sin γ).
   Sisi a = BC, b = CA, c = AB. Pada γ = 90° segitiga siku-siku di C. */

export type Pt = { x: number; y: number };
export type Params = { a: number; b: number; gamma: number };
export type Square = [Pt, Pt, Pt, Pt];
export type Box = { minX: number; maxX: number; minY: number; maxY: number };

export const RIGHT = 90;

/** Kedudukan titik sudut. Pada 90° dipakai nilai persis, bukan cos(90°) ≈ 6e-17. */
export function layout({ a, b, gamma }: Params): { C: Pt; B: Pt; A: Pt } {
  const A =
    gamma === RIGHT
      ? { x: 0, y: b }
      : {
          x: b * Math.cos((gamma * Math.PI) / 180),
          y: b * Math.sin((gamma * Math.PI) / 180),
        };
  return { C: { x: 0, y: 0 }, B: { x: a, y: 0 }, A };
}

export function sideLengths(p: Params) {
  const { a, b, gamma } = p;
  const c =
    gamma === RIGHT
      ? Math.hypot(a, b)
      : Math.sqrt(a * a + b * b - 2 * a * b * Math.cos((gamma * Math.PI) / 180));
  return { a, b, c };
}

/** Persegi pada sisi PQ, dibangun ke arah menjauhi titik R: P, Q, Q+n, P+n. */
export function squareOn(P: Pt, Q: Pt, R: Pt): Square {
  const dx = Q.x - P.x;
  const dy = Q.y - P.y;
  let nx = -dy;
  let ny = dx;
  if (nx * (R.x - P.x) + ny * (R.y - P.y) > 0) {
    nx = -nx;
    ny = -ny;
  }
  return [P, Q, { x: Q.x + nx, y: Q.y + ny }, { x: P.x + nx, y: P.y + ny }];
}

/** Persegi pada sisi a (BC), b (CA), dan c (AB). */
export function squaresOf(p: Params) {
  const { A, B, C } = layout(p);
  return { sa: squareOn(B, C, A), sb: squareOn(C, A, B), sc: squareOn(A, B, C) };
}

export const centerOf = (sq: Square): Pt => ({
  x: (sq[0].x + sq[1].x + sq[2].x + sq[3].x) / 4,
  y: (sq[0].y + sq[1].y + sq[2].y + sq[3].y) / 4,
});

function boxOf(points: Pt[]): Box {
  const xs = points.map((q) => q.x);
  const ys = points.map((q) => q.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/** Kotak yang memuat segitiga dan ketiga persegi. */
export function bounds(p: Params): Box {
  const { sa, sb, sc } = squaresOf(p);
  return boxOf([...sa, ...sb, ...sc]);
}

export function isTriple({ a, b, gamma }: Params) {
  if (gamma !== RIGHT || !Number.isInteger(a) || !Number.isInteger(b)) return false;
  const c = Math.hypot(a, b);
  return Math.abs(c - Math.round(c)) < 1e-9;
}

/* ───────── Bukti dengan penataan ulang ─────────
   Persegi besar bersisi s = a + b berisi empat segitiga siku-siku yang sama.
   Susunan awal (t = 0) menyisakan persegi miring c², susunan akhir (t = 1)
   menyisakan persegi a² dan b². Tiap segitiga hanya bergeser (tanpa putaran),
   sehingga cukup interpolasi titik sudut siku-sikunya. */

const rot = (v: Pt, quarter: number): Pt => {
  switch (quarter % 4) {
    case 1:
      return { x: -v.y, y: v.x };
    case 2:
      return { x: -v.x, y: -v.y };
    case 3:
      return { x: v.y, y: -v.x };
    default:
      return v;
  }
};

export function proofTriangles(a: number, b: number, t: number): Pt[][] {
  const s = a + b;
  const start: Pt[] = [
    { x: 0, y: 0 },
    { x: s, y: 0 },
    { x: s, y: s },
    { x: 0, y: s },
  ];
  const end: Pt[] = [
    { x: b, y: 0 },
    { x: b, y: b },
    { x: s, y: b },
    { x: 0, y: s },
  ];
  return start.map((r0, k) => {
    const r = { x: r0.x + (end[k].x - r0.x) * t, y: r0.y + (end[k].y - r0.y) * t };
    const u = rot({ x: a, y: 0 }, k);
    const w = rot({ x: 0, y: b }, k);
    return [r, { x: r.x + u.x, y: r.y + u.y }, { x: r.x + w.x, y: r.y + w.y }];
  });
}

/** Sisa persegi besar pada awal (c²) dan akhir (a² dan b²). */
export function proofRegions(a: number, b: number) {
  const s = a + b;
  return {
    big: [
      { x: 0, y: 0 },
      { x: s, y: 0 },
      { x: s, y: s },
      { x: 0, y: s },
    ] as Pt[],
    c: [
      { x: a, y: 0 },
      { x: s, y: a },
      { x: b, y: s },
      { x: 0, y: b },
    ] as Pt[],
    sb: [
      { x: 0, y: 0 },
      { x: b, y: 0 },
      { x: b, y: b },
      { x: 0, y: b },
    ] as Pt[],
    sa: [
      { x: b, y: b },
      { x: s, y: b },
      { x: s, y: s },
      { x: b, y: s },
    ] as Pt[],
  };
}

export function proofBounds(a: number, b: number): Box {
  return { minX: 0, maxX: a + b, minY: 0, maxY: a + b };
}
