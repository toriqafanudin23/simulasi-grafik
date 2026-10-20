/**
 * Parser notasi LaTeX sederhana untuk fungsi satu variabel x,
 * kompilasi ke fungsi JavaScript, dan pencari akar numerik.
 * Tanpa dependensi eksternal.
 */

// ───────────────────────── AST ─────────────────────────
export type Node =
  | { k: "num"; v: number; s?: string }
  | { k: "var" }
  | { k: "par"; name: string }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Node; b: Node }
  | { k: "pow"; a: Node; b: Node }
  | { k: "fn"; name: string; a: Node; base?: Node }
  | { k: "root"; a: Node; n?: Node }
  | { k: "abs"; a: Node };

type Tok =
  { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

class ParseError extends Error {}

/** Parameter yang boleh dipakai selain x (dapat digeser dengan slider). */
export const PARAM_NAMES = ["a", "b", "c", "k"] as const;
const PARAM_SET = new Set<string>(PARAM_NAMES);
export type Params = Record<string, number>;

// ───────────────────────── Tokenizer ─────────────────────────
const WORDS = [
  "arcsin",
  "arccos",
  "arctan",
  "sinh",
  "cosh",
  "tanh",
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "ln",
  "log",
  "exp",
  "sqrt",
  "abs",
  "pi",
].sort((p, q) => q.length - p.length);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    // angka (titik atau titik desimal)
    const num = /^(\d+([.,]\d+)?|[.,]\d+)/.exec(src.slice(i));
    if (num) {
      toks.push({ t: "num", v: Number(num[0].replace(",", ".")) });
      i += num[0].length;
      continue;
    }
    // perintah LaTeX
    if (ch === "\\") {
      const cmd = /^\\([a-zA-Z]+)/.exec(src.slice(i));
      if (cmd) {
        i += cmd[0].length;
        const name = cmd[1];
        if (name === "left" || name === "right") {
          while (i < n && /\s/.test(src[i])) i += 1;
          const d = src[i];
          i += 1;
          if (d === "(" || d === ")" || d === "[" || d === "]") {
            toks.push({ t: "op", v: d });
          } else if (d === "|") {
            toks.push({ t: "op", v: name === "left" ? "|<" : "|>" });
          } else if (d === ".") {
            /* pembatas tak terlihat: abaikan */
          } else {
            throw new ParseError(`Pembatas setelah \\${name} tidak dikenali.`);
          }
        } else if (name === "cdot" || name === "times" || name === "ast") {
          toks.push({ t: "op", v: "*" });
        } else if (name === "div") {
          toks.push({ t: "op", v: "/" });
        } else {
          toks.push({ t: "id", v: name });
        }
        continue;
      }
      // \, \; \: \! \<spasi> → spasi tipis, abaikan
      if (i + 1 < n && /[,;:! ]/.test(src[i + 1])) {
        i += 2;
        continue;
      }
      if (src[i + 1] === "{" || src[i + 1] === "}") {
        toks.push({ t: "op", v: src[i + 1] === "{" ? "(" : ")" });
        i += 2;
        continue;
      }
      throw new ParseError("Tanda \\ tidak dikenali.");
    }
    // kata tanpa garis miring (sin, cos, ln, ...) atau huruf tunggal
    if (/[a-zA-Z]/.test(ch)) {
      const word = WORDS.find((w) => src.startsWith(w, i));
      if (word) {
        toks.push({ t: "id", v: word });
        i += word.length;
      } else {
        toks.push({ t: "id", v: ch });
        i += 1;
      }
      continue;
    }
    if (ch === "−") {
      toks.push({ t: "op", v: "-" });
      i += 1;
      continue;
    }
    if (ch === "×" || ch === "·") {
      toks.push({ t: "op", v: "*" });
      i += 1;
      continue;
    }
    if (ch === "÷") {
      toks.push({ t: "op", v: "/" });
      i += 1;
      continue;
    }
    if (ch === "π") {
      toks.push({ t: "id", v: "pi" });
      i += 1;
      continue;
    }
    if ("+-*/^_()[]{}|".includes(ch)) {
      toks.push({ t: "op", v: ch });
      i += 1;
      continue;
    }
    throw new ParseError(`Karakter "${ch}" tidak dikenali.`);
  }
  return toks;
}

// ───────────────────────── Parser ─────────────────────────
const FUNCTIONS = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "arcsin",
  "arccos",
  "arctan",
  "sinh",
  "cosh",
  "tanh",
  "ln",
  "log",
  "exp",
  "abs",
]);
const TRIG = new Set(["sin", "cos", "tan"]);

class Parser {
  private i = 0;
  private plainAbs = 0;
  readonly used = new Set<string>();
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  parseAll(): Node {
    if (this.toks.length === 0) throw new ParseError("Ekspresi kosong.");
    const node = this.parseExpr();
    if (this.i < this.toks.length) {
      throw new ParseError(
        `Bagian "${this.describe(this.toks[this.i])}" tidak terduga.`,
      );
    }
    return node;
  }

  private describe(t: Tok | undefined): string {
    if (!t) return "akhir ekspresi";
    if (t.t === "num") return String(t.v);
    if (t.t === "id") return t.v.length > 1 ? `\\${t.v}` : t.v;
    if (t.v === "|<") return "\\left|";
    if (t.v === "|>") return "\\right|";
    return t.v;
  }

  private peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }

  private isOp(v: string, o = 0): boolean {
    const t = this.peek(o);
    return !!t && t.t === "op" && t.v === v;
  }

  private expect(v: string): void {
    if (!this.isOp(v)) {
      throw new ParseError(
        `Diharapkan "${v === "|>" ? "\\right|" : v}" tetapi menemukan "${this.describe(this.peek())}".`,
      );
    }
    this.i += 1;
  }

  private startsAtom(t: Tok | undefined): boolean {
    if (!t) return false;
    if (t.t === "num" || t.t === "id") return true;
    if (t.v === "(" || t.v === "{" || t.v === "|<") return true;
    if (t.v === "|" && this.plainAbs === 0) return true;
    return false;
  }

  private parseExpr(): Node {
    let left = this.parseTerm();
    for (;;) {
      if (this.isOp("+") || this.isOp("-")) {
        const op = (this.peek() as { v: "+" | "-" }).v;
        this.i += 1;
        left = { k: "bin", op, a: left, b: this.parseTerm() };
      } else return left;
    }
  }

  private parseTerm(): Node {
    let left = this.parseUnary();
    for (;;) {
      if (this.isOp("*") || this.isOp("/")) {
        const op = (this.peek() as { v: "*" | "/" }).v;
        this.i += 1;
        left = { k: "bin", op, a: left, b: this.parseUnary() };
      } else if (this.startsAtom(this.peek())) {
        // perkalian implisit: 2x, 2(x+1), x\sin x, (x+1)(x-1)
        left = { k: "bin", op: "*", a: left, b: this.parsePower() };
      } else return left;
    }
  }

  private parseUnary(): Node {
    if (this.isOp("-")) {
      this.i += 1;
      return { k: "neg", a: this.parseUnary() };
    }
    if (this.isOp("+")) {
      this.i += 1;
      return this.parseUnary();
    }
    return this.parsePower();
  }

  private parsePower(): Node {
    const base = this.parseAtom();
    if (this.isOp("^")) {
      this.i += 1;
      return { k: "pow", a: base, b: this.parseExponent() };
    }
    return base;
  }

  private parseExponent(): Node {
    if (this.isOp("{")) {
      this.i += 1;
      const e = this.parseExpr();
      this.expect("}");
      return e;
    }
    if (this.isOp("-")) {
      this.i += 1;
      return { k: "neg", a: this.parseExponent() };
    }
    if (this.isOp("+")) {
      this.i += 1;
      return this.parseExponent();
    }
    const base = this.parseAtom();
    if (this.isOp("^")) {
      this.i += 1;
      return { k: "pow", a: base, b: this.parseExponent() };
    }
    return base;
  }

  /** Argumen berkurung kurawal/biasa, atau satu atom. */
  private parseArg(): Node {
    if (this.isOp("{")) {
      this.i += 1;
      const e = this.parseExpr();
      this.expect("}");
      return e;
    }
    if (this.isOp("(")) {
      this.i += 1;
      const e = this.parseExpr();
      this.expect(")");
      return e;
    }
    return this.parseAtom();
  }

  /** Argumen fungsi tanpa kurung: \sin x, \sin 2x, \ln x^2 */
  private parseBareArg(): Node {
    if (this.isOp("-")) {
      this.i += 1;
      return { k: "neg", a: this.parseBareArg() };
    }
    if (this.isOp("+")) {
      this.i += 1;
      return this.parseBareArg();
    }
    let node = this.parsePower();
    for (;;) {
      const t = this.peek();
      const simple =
        !!t &&
        (t.t === "num" ||
          (t.t === "id" &&
            (t.v === "x" || t.v === "pi" || PARAM_SET.has(t.v))));
      if (!simple) return node;
      node = { k: "bin", op: "*", a: node, b: this.parsePower() };
    }
  }

  private parseFunction(name: string): Node {
    let base: Node | undefined;
    let power: Node | undefined;
    if (this.isOp("_")) {
      this.i += 1;
      base = this.parseArg();
    }
    if (this.isOp("^")) {
      this.i += 1;
      power = this.parseExponent();
    }
    let arg: Node;
    if (this.isOp("(")) {
      this.i += 1;
      arg = this.parseExpr();
      this.expect(")");
    } else if (this.isOp("{")) {
      this.i += 1;
      arg = this.parseExpr();
      this.expect("}");
    } else if (this.isOp("|<") || this.isOp("|")) {
      arg = this.parseAtom();
    } else {
      if (!this.peek()) {
        throw new ParseError(`Fungsi \\${name} belum diberi argumen.`);
      }
      arg = this.parseBareArg();
    }
    let fnName = name;
    // \sin^{-1} x berarti invers (arcsin)
    if (
      power &&
      TRIG.has(name) &&
      power.k === "neg" &&
      power.a.k === "num" &&
      power.a.v === 1
    ) {
      fnName = `arc${name}`;
      power = undefined;
    }
    const call: Node = { k: "fn", name: fnName, a: arg, base };
    return power ? { k: "pow", a: call, b: power } : call;
  }

  private parseAtom(): Node {
    const t = this.peek();
    if (!t) throw new ParseError("Ekspresi belum lengkap.");
    this.i += 1;
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "op") {
      if (t.v === "(") {
        const e = this.parseExpr();
        this.expect(")");
        return e;
      }
      if (t.v === "{") {
        const e = this.parseExpr();
        this.expect("}");
        return e;
      }
      if (t.v === "|<") {
        const e = this.parseExpr();
        this.expect("|>");
        return { k: "abs", a: e };
      }
      if (t.v === "|") {
        this.plainAbs += 1;
        const e = this.parseExpr();
        this.plainAbs -= 1;
        this.expect("|");
        return { k: "abs", a: e };
      }
      throw new ParseError(
        `Tanda "${this.describe(t)}" muncul di tempat yang tidak tepat.`,
      );
    }
    const name = t.v;
    if (name === "x") return { k: "var" };
    if (PARAM_SET.has(name)) {
      this.used.add(name);
      return { k: "par", name };
    }
    if (name === "e") return { k: "num", v: Math.E, s: "e" };
    if (name === "pi") return { k: "num", v: Math.PI, s: "π" };
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const a = this.parseArg();
      const b = this.parseArg();
      return { k: "bin", op: "/", a, b };
    }
    if (name === "sqrt") {
      let index: Node | undefined;
      if (this.isOp("[")) {
        this.i += 1;
        index = this.parseExpr();
        this.expect("]");
      }
      return { k: "root", a: this.parseArg(), n: index };
    }
    if (FUNCTIONS.has(name)) return this.parseFunction(name);
    if (name.length === 1) {
      throw new ParseError(
        `Huruf "${name}" tidak dikenal. Variabel utama x; parameter yang boleh: ${PARAM_NAMES.join(", ")}.`,
      );
    }
    throw new ParseError(`Perintah "\\${name}" belum didukung.`);
  }
}

// ───────────────────────── Evaluasi ─────────────────────────
/** Pangkat real: akar ganjil dari bilangan negatif dihitung (mis. x^{1/3}). */
export function rpow(a: number, b: number): number {
  if (a >= 0 || Number.isInteger(b)) return Math.pow(a, b);
  for (let q = 3; q <= 15; q += 2) {
    const p = Math.round(b * q);
    if (Math.abs(b * q - p) < 1e-9) {
      const r = Math.pow(-a, b);
      return Math.abs(p) % 2 === 1 ? -r : r;
    }
  }
  return Number.NaN;
}

const UNARY: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  cot: (v) => 1 / Math.tan(v),
  sec: (v) => 1 / Math.cos(v),
  csc: (v) => 1 / Math.sin(v),
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  abs: Math.abs,
};

export function compile(n: Node, P: Params = {}): (x: number) => number {
  switch (n.k) {
    case "par": {
      const name = n.name;
      // dibaca saat dipanggil, sehingga slider cukup mengubah P tanpa parse ulang
      return () => P[name] ?? 1;
    }
    case "num": {
      const v = n.v;
      return () => v;
    }
    case "var":
      return (x) => x;
    case "neg": {
      const a = compile(n.a, P);
      return (x) => -a(x);
    }
    case "abs": {
      const a = compile(n.a, P);
      return (x) => Math.abs(a(x));
    }
    case "bin": {
      const a = compile(n.a, P);
      const b = compile(n.b, P);
      switch (n.op) {
        case "+":
          return (x) => a(x) + b(x);
        case "-":
          return (x) => a(x) - b(x);
        case "*":
          return (x) => a(x) * b(x);
        default:
          return (x) => a(x) / b(x);
      }
    }
    case "pow": {
      const a = compile(n.a, P);
      const b = compile(n.b, P);
      return (x) => rpow(a(x), b(x));
    }
    case "root": {
      const a = compile(n.a, P);
      if (!n.n) return (x) => Math.sqrt(a(x));
      const idx = compile(n.n, P);
      return (x) => rpow(a(x), 1 / idx(x));
    }
    case "fn": {
      const a = compile(n.a, P);
      if (n.name === "log" && n.base) {
        const b = compile(n.base, P);
        return (x) => Math.log(a(x)) / Math.log(b(x));
      }
      const f = UNARY[n.name];
      return (x) => f(a(x));
    }
  }
}

// ───────────────────────── Tampilan terbaca ─────────────────────────
function numText(n: Extract<Node, { k: "num" }>): string {
  if (n.s) return n.s;
  return String(Math.round(n.v * 1e6) / 1e6).replace(".", ",");
}

const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, neg: 2.5, pow: 3 } as const;

function show(n: Node, parent = 0): string {
  let text: string;
  let prec = 10;
  switch (n.k) {
    case "num":
      text = numText(n);
      break;
    case "var":
      text = "x";
      break;
    case "par":
      text = n.name;
      break;
    case "neg":
      text = `−${show(n.a, PREC.neg)}`;
      prec = PREC.neg;
      break;
    case "abs":
      text = `|${show(n.a)}|`;
      break;
    case "bin": {
      const p = PREC[n.op];
      const sym = n.op === "*" ? "·" : n.op === "-" ? "−" : n.op;
      const right = show(n.b, n.op === "-" || n.op === "/" ? p + 0.1 : p);
      text = `${show(n.a, p)} ${sym} ${right}`;
      prec = p;
      break;
    }
    case "pow": {
      const e = show(n.b, PREC.pow + 1);
      text = `${show(n.a, PREC.pow + 0.1)}^${e}`;
      prec = PREC.pow;
      break;
    }
    case "root":
      text = n.n ? `${show(n.n, 10)}√(${show(n.a)})` : `√(${show(n.a)})`;
      break;
    case "fn":
      text =
        n.name === "log" && n.base
          ? `log_${show(n.base, 10)}(${show(n.a)})`
          : `${n.name}(${show(n.a)})`;
      break;
  }
  return prec < parent ? `(${text})` : text;
}

// ───────────────────────── API publik ─────────────────────────
export type ParseResult =
  | { ok: true; fn: (x: number) => number; text: string; params: string[] }
  | { ok: false; error: string };

/** Mengembalikan null bila masukan kosong. */
export function parseLatex(source: string, P: Params = {}): ParseResult | null {
  let src = source.trim();
  if (!src) return null;
  const eq = src.split("=");
  if (eq.length > 2)
    return { ok: false, error: "Hanya boleh ada satu tanda =." };
  if (eq.length === 2) {
    const left = eq[0].replace(/\s/g, "");
    if (!/^(y|f|f\(x\))$/i.test(left)) {
      return {
        ok: false,
        error: "Tulis sisi kanan saja, atau awali dengan y = atau f(x) =.",
      };
    }
    src = eq[1].trim();
    if (!src) return { ok: false, error: "Sisi kanan tanda = masih kosong." };
  }
  try {
    const parser = new Parser(tokenize(src));
    const ast = parser.parseAll();
    const raw = compile(ast, P);
    return {
      ok: true,
      fn: (x) => {
        const v = raw(x);
        return Number.isFinite(v) ? v : Number.NaN;
      },
      text: show(ast),
      params: PARAM_NAMES.filter((name) => parser.used.has(name)),
    };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: error.message };
    return { ok: false, error: "Ekspresi tidak dapat dibaca." };
  }
}

// ───────────────────────── Pencari akar ─────────────────────────
export type RootResult = { roots: number[]; coincident: boolean };

/**
 * Mencari semua x di [lo, hi] dengan g(x) = 0:
 * perubahan tanda (bisection) dan akar kembar/menyinggung (minimum |g|).
 * Pole seperti 1/x atau tan x ditolak karena g tidak mendekati 0.
 */
export function findRoots(
  g: (x: number) => number,
  lo: number,
  hi: number,
  samples = 3000,
): RootResult {
  const dx = (hi - lo) / samples;
  const xs: number[] = [];
  const vs: number[] = [];
  let zeros = 0;
  for (let i = 0; i <= samples; i += 1) {
    const x = lo + i * dx;
    const v = g(x);
    xs.push(x);
    vs.push(v);
    if (Math.abs(v) < 1e-12) zeros += 1;
  }
  if (zeros > samples * 0.5) return { roots: [], coincident: true };

  const roots: number[] = [];
  const push = (r: number) => {
    if (!roots.some((q) => Math.abs(q - r) < 1e-6 * (1 + Math.abs(r))))
      roots.push(r);
  };

  for (let i = 0; i < samples; i += 1) {
    const a = vs[i];
    const b = vs[i + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(a) < 1e-12) {
      push(xs[i]);
      continue;
    }
    if (a * b < 0) {
      let l = xs[i];
      let r = xs[i + 1];
      let fl = a;
      for (let k = 0; k < 70; k += 1) {
        const m = (l + r) / 2;
        const fm = g(m);
        if (!Number.isFinite(fm)) break;
        if (fl * fm <= 0) r = m;
        else {
          l = m;
          fl = fm;
        }
      }
      const m = (l + r) / 2;
      const gm = g(m);
      if (Number.isFinite(gm) && Math.abs(gm) < 1e-6) push(m);
    }
  }
  if (Math.abs(vs[samples]) < 1e-12) push(xs[samples]);

  // akar kembar / menyinggung: minimum lokal |g| tanpa perubahan tanda
  for (let i = 1; i < samples; i += 1) {
    const a = vs[i - 1];
    const b = vs[i];
    const c = vs[i + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c))
      continue;
    if (a * c <= 0 || b * a <= 0) continue;
    if (!(Math.abs(b) <= Math.abs(a) && Math.abs(b) <= Math.abs(c))) continue;
    let l = xs[i - 1];
    let r = xs[i + 1];
    for (let k = 0; k < 80; k += 1) {
      const m1 = l + (r - l) / 3;
      const m2 = r - (r - l) / 3;
      if (Math.abs(g(m1)) < Math.abs(g(m2))) r = m2;
      else l = m1;
    }
    const m = (l + r) / 2;
    const gm = g(m);
    if (Number.isFinite(gm) && Math.abs(gm) < 1e-9) push(m);
  }

  roots.sort((p, q) => p - q);
  return { roots, coincident: false };
}

// ───────────────────────── Turunan & ekstrem ─────────────────────────
/** Turunan numerik (selisih pusat 5 titik). NaN bila tidak terdefinisi. */
export function derivative(f: (x: number) => number, x: number): number {
  const h = 1e-3 * (1 + Math.abs(x));
  const d =
    (-f(x + 2 * h) + 8 * f(x + h) - 8 * f(x - h) + f(x - 2 * h)) / (12 * h);
  return Number.isFinite(d) ? d : Number.NaN;
}

export type Extremum = { x: number; y: number; kind: "max" | "min" };

/**
 * Mencari maksimum/minimum lokal pada [lo, hi].
 * ySpan (tinggi jendela) dipakai membuang "puncak palsu" di dekat asimtot tegak.
 */
export function findExtrema(
  f: (x: number) => number,
  lo: number,
  hi: number,
  ySpan = Number.POSITIVE_INFINITY,
  samples = 1500,
): Extremum[] {
  const dx = (hi - lo) / samples;
  const xs: number[] = [];
  const vs: number[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const x = lo + i * dx;
    xs.push(x);
    vs.push(f(x));
  }
  const out: Extremum[] = [];
  const jump = 0.35 * ySpan;
  for (let i = 1; i < samples; i += 1) {
    const a = vs[i - 1];
    const b = vs[i];
    const c = vs[i + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c))
      continue;
    if (Math.abs(b - a) > jump || Math.abs(c - b) > jump) continue;
    const tol = 1e-12 * (1 + Math.abs(b));
    let kind: "max" | "min" | null = null;
    if (b <= a && b < c && (a - b > tol || c - b > tol)) kind = "min";
    else if (b >= a && b > c && (b - a > tol || b - c > tol)) kind = "max";
    if (!kind) continue;
    const sign = kind === "max" ? -1 : 1; // minimalkan sign * f
    let l = xs[i - 1];
    let r = xs[i + 1];
    for (let k = 0; k < 70; k += 1) {
      const m1 = l + (r - l) / 3;
      const m2 = r - (r - l) / 3;
      const f1 = sign * f(m1);
      const f2 = sign * f(m2);
      if (!Number.isFinite(f1) || !Number.isFinite(f2)) break;
      if (f1 < f2) r = m2;
      else l = m1;
    }
    const m = (l + r) / 2;
    const y = f(m);
    if (!Number.isFinite(y)) continue;
    // titik hasil penghalusan tidak boleh lebih buruk dari sampel awal
    if (sign * y > sign * b + 1e-9 * (1 + Math.abs(b))) continue;
    if (out.some((q) => Math.abs(q.x - m) < 4 * dx)) continue;
    out.push({ x: m, y, kind });
  }
  return out;
}
