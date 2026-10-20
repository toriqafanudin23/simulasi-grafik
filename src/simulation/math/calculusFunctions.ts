export type FnKey = "quad" | "downQuad" | "cubic" | "sine";

export type FnDef = {
  short: string;
  label: string;
  dLabel: string;
  f: (x: number) => number;
  df: (x: number) => number;
  F: (x: number) => number; // antiturunan
};

export const FUNCS: Record<FnKey, FnDef> = {
  quad: {
    short: "¼x²",
    label: "f(x) = ¼x²",
    dLabel: "f′(x) = ½x",
    f: (x) => (x * x) / 4,
    df: (x) => x / 2,
    F: (x) => (x * x * x) / 12,
  },
  // Parabola terbuka ke bawah, memotong sumbu x di x = ±4.
  downQuad: {
    short: "−¼x² + 4",
    label: "f(x) = −¼x² + 4",
    dLabel: "f′(x) = −½x",
    f: (x) => 4 - (x * x) / 4,
    df: (x) => -x / 2,
    F: (x) => 4 * x - (x * x * x) / 12,
  },
  cubic: {
    short: "¼x³ − x",
    label: "f(x) = ¼x³ − x",
    dLabel: "f′(x) = ¾x² − 1",
    f: (x) => (x * x * x) / 4 - x,
    df: (x) => (3 * x * x) / 4 - 1,
    F: (x) => x ** 4 / 16 - (x * x) / 2,
  },
  sine: {
    short: "2 sin x",
    label: "f(x) = 2 sin x",
    dLabel: "f′(x) = 2 cos x",
    f: (x) => 2 * Math.sin(x),
    df: (x) => 2 * Math.cos(x),
    F: (x) => -2 * Math.cos(x),
  },
};

export const FN_KEYS: FnKey[] = ["quad", "downQuad", "cubic", "sine"];

export const calcColors = {
  tangent: "#087f8c",
  secant: "#d16b36",
  area: "#527a41",
  curve: "#183e54",
  point: "#927000",
};
