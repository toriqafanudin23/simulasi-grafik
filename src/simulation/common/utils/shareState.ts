/* Tautan bagikan: keadaan simulasi (parameter, tampilan, dst.) disimpan di
   URL sebagai ?s=<token>. Token = JSON {v, d:{nama: nilai}} dalam base64url.

   Alur:
   - Setiap useStoredSimulationState mendaftarkan nilainya di `registry`.
   - Tombol "Bagikan" memanggil buildShareUrl() untuk membuat tautan.
   - Saat halaman dibuka dengan ?s=..., hook membaca nilai awal dari sini
     (prioritas di atas sessionStorage), lalu parameter dihapus dari URL. */

export const SHARE_PARAM = "s";
const VERSION = 1;
/** Batas panjang token supaya tautan tetap aman dikirim lewat WhatsApp dsb. */
export const MAX_TOKEN_LENGTH = 6000;

type Snapshot = Record<string, unknown>;

/* ───────── Pendaftaran nilai yang sedang aktif ───────── */

const registry = new Map<string, () => unknown>();

export function registerShareable(name: string, read: () => unknown) {
  registry.set(name, read);
  return () => {
    if (registry.get(name) === read) registry.delete(name);
    if (registry.size === 0) cache = null;
  };
}

/* ───────── Base64url yang aman untuk Unicode ───────── */

function toBase64Url(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string) {
  const padded = token.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ───────── Membuat dan membaca token ───────── */

export function encodeSnapshot(data: Snapshot) {
  return toBase64Url(JSON.stringify({ v: VERSION, d: data }));
}

export function decodeSnapshot(token: string): Snapshot | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(token));
    if (!parsed || typeof parsed !== "object") return null;
    const { v, d } = parsed as { v?: unknown; d?: unknown };
    if (v !== VERSION || !d || typeof d !== "object" || Array.isArray(d)) return null;
    return d as Snapshot;
  } catch {
    return null;
  }
}

/** Salin nilai semua hook yang sedang aktif. */
export function collectSnapshot(): Snapshot {
  const out: Snapshot = {};
  for (const [name, read] of registry) {
    try {
      const value = read();
      if (value !== undefined) out[name] = value;
    } catch {
      /* lewati */
    }
  }
  return out;
}

/** Tautan ke simulasi ini dengan keadaan saat ini. null bila terlalu panjang. */
export function buildShareUrl(): string | null {
  const token = encodeSnapshot(collectSnapshot());
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set(SHARE_PARAM, token);
  return url.toString();
}

/* ───────── Membaca keadaan dari URL saat simulasi dibuka ───────── */

let cache: { path: string; data: Snapshot } | null = null;

/** Nilai bersama untuk `name` di halaman ini, atau undefined. */
export function readSharedValue(name: string): unknown {
  if (typeof window === "undefined") return undefined;
  const path = window.location.pathname;
  const token = new URLSearchParams(window.location.search).get(SHARE_PARAM);
  if (token) {
    if (!cache || cache.path !== path || cache.data.__token !== token) {
      const data = decodeSnapshot(token);
      cache = data ? { path, data: { ...data, __token: token } } : null;
    }
  } else if (cache && cache.path !== path) {
    cache = null;
  }
  return cache?.data[name];
}

/** Hapus ?s= dari alamat setelah dibaca (nilainya tersimpan di sessionStorage). */
export function stripShareParam() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(SHARE_PARAM)) return;
    url.searchParams.delete(SHARE_PARAM);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  } catch {
    /* diabaikan */
  }
}

/* ───────── Validasi: nilai dari URL tidak boleh merusak simulasi ───────── */

/** true jika `value` berbentuk sama dengan `fallback` (tipe, kunci, elemen). */
export function sameShape(value: unknown, fallback: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  // Nilai awal null/undefined: bentuk sebenarnya tidak diketahui, terima nilai sederhana.
  if (fallback === null || fallback === undefined) {
    return value === null || ["string", "number", "boolean"].includes(typeof value);
  }
  if (typeof fallback === "number") return typeof value === "number" && Number.isFinite(value);
  if (typeof fallback !== "object") return typeof value === typeof fallback;
  if (Array.isArray(fallback)) {
    if (!Array.isArray(value)) return false;
    if (value.length > 200) return false;
    if (fallback.length === 0) return true;
    // Tuple (mis. [x, y]): cocokkan per posisi. Daftar biasa: semua elemen sebentuk elemen pertama.
    if (value.length === fallback.length && value.every((item, i) => sameShape(item, fallback[i], depth + 1))) return true;
    return value.every((item) => sameShape(item, fallback[0], depth + 1));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return Object.keys(fallback as object).every(
    (key) => key in obj && sameShape(obj[key], (fallback as Record<string, unknown>)[key], depth + 1),
  );
}
