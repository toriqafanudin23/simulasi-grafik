/* Fungsi bantu umum untuk semua simulasi. */

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Bulatkan ke kelipatan `step` tanpa sisa desimal floating point. */
export function snap(value: number, step: number) {
  return Number((Math.round(value / step) * step).toFixed(6));
}

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  useGrouping: false,
});

/** Angka dengan titik desimal. Nilai ≈ 0 ditulis "0". */
export function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.005) return "0";
  return numberFormat.format(value);
}

/** Sama seperti formatNumber, tetapi memakai tanda minus sebenarnya (−). */
export function formatText(value: number) {
  return formatNumber(value).replace("-", "−");
}

/** Angka untuk KaTeX. Tanpa pemisah ribuan. */
export function texNumber(value: number) {
  return formatNumber(value);
}
