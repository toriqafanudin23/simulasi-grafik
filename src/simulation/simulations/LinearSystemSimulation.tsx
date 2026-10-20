import JXG from "jsxgraph";
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
import { clamp, snap as snapTo } from "../common/utils/simUtils";
import { useJsxBoard, type SimBoard } from "../common/hooks/useJsxBoard";
import { useStoredSimulationState } from "../common/hooks/useStoredSimulationState";
import {
  OP_SYMBOL,
  boxPoly,
  clipByCons,
  clipToBox,
  feasibleRegion,
  fmtN,
  optimize,
  ptText,
  solve2,
  validLine,
  type Box,
  type Cons,
  type Goal,
  type Op,
  type Opt,
  type Pt,
  type Region,
  type Sol,
} from "../math/linearMath";
import "./LinearSystemSimulation.css";

/* Simulasi sistem linear untuk SMP, tiga mode:
   1. SPLDV            : maks. 3 persamaan, titik potong + garis putus-putus ke sumbu.
   2. Pertidaksamaan   : garis putus-putus untuk < dan >, garis penuh untuk ≤ dan ≥,
                         daerah hasil muncul setelah tombol ditekan.
   3. Program linear   : kendala, fungsi tujuan Z, garis selidik yang bisa digeser.
   Tidak ada titik potong / titik sudut / daerah di grafik sebelum tombol "Tampilkan"
   ditekan. Tombol − / + memakai langkah yang dipilih (0.2 / 0.5 / 1). */

/* ───────── Tipe ───────── */

type Mode = "spldv" | "ptlsv" | "lp";
type Reveal = { region: boolean; points: boolean };
type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean;
  curveWidth: number;
  pointSize: number;
};
type Preset = { label: string; cons: Cons[]; p?: number; q?: number; goal?: Goal };

type JEl = {
  X(): number;
  Y(): number;
  setPosition(method: number, coords: number[]): unknown;
  setAttribute(attrs: Record<string, unknown>): unknown;
  on(event: string, handler: () => void): unknown;
};
type AxisEl = JEl & { defaultTicks: { setAttribute: (a: Record<string, unknown>) => unknown } };
type CurveLike = { updateDataArray: () => void; dataX: number[]; dataY: number[] };
type AccentStyle = CSSProperties & { "--sim-accent"?: string };
type Creator = (type: string, parents: unknown[], attrs: Record<string, unknown>) => JEl;

type MeetPoint = { x: number; y: number; from: string[] };
type Analysis = {
  pairs: { i: number; j: number; sol: Sol }[];
  points: MeetPoint[];
  region: Region | null;
  opt: Opt | null;
};

/* ───────── Konstanta ───────── */

const MAX_BY_MODE: Record<Mode, number> = { spldv: 3, ptlsv: 4, lp: 4 };
const MAX_COEF = 999;
const STEPS = [0.2, 0.5, 1];

const colors = {
  lines: ["#1565c0", "#e65100", "#6557d2", "#2e7d32"],
  region: "#0b84c6",
  inter: "#c62828",
  opt: "#c28a00",
  optDark: "#7a5a00",
  vertex: "#232329",
  grid: "#dcdce2",
  axis: "#4a4a55",
};

const HOME: Record<Mode, Box> = {
  spldv: [-8, 8, 8, -8],
  ptlsv: [-8, 8, 8, -8],
  lp: [-2, 12, 12, -2],
};

const COORDS_BY_USER: number =
  (JXG as unknown as { COORDS_BY_USER?: number }).COORDS_BY_USER ?? 1;

const MODES: { id: Mode; label: string }[] = [
  { id: "spldv", label: "SPLDV" },
  { id: "ptlsv", label: "Pertidaksamaan" },
  { id: "lp", label: "Program linear" },
];

const OPS: Op[] = ["<=", ">=", "<", ">"];
const OP_TEX: Record<Op, string> = {
  "<=": String.raw`\le`,
  ">=": String.raw`\ge`,
  "<": "<",
  ">": ">",
  "=": "=",
};

const C = (a: number, b: number, c: number, op: Op): Cons => ({ a, b, c, op });

const DEFAULTS: Record<Mode, Cons[]> = {
  spldv: [C(1, 1, 5, "="), C(1, -1, 1, "=")],
  ptlsv: [C(1, 1, 6, "<="), C(1, -1, 2, "<")],
  lp: [C(2, 1, 8, "<="), C(1, 2, 10, "<=")],
};
const NEW_ROW: Record<Mode, Cons> = {
  spldv: C(2, 1, 6, "="),
  ptlsv: C(1, 2, 8, "<="),
  lp: C(1, 0, 4, "<="),
};

const PRESETS: Record<Mode, Preset[]> = {
  spldv: [
    { label: "Satu titik potong", cons: [C(1, 1, 5, "="), C(1, -1, 1, "=")] },
    { label: "Tiga garis, satu titik", cons: [C(1, 1, 5, "="), C(1, -1, 1, "="), C(2, 1, 8, "=")] },
    { label: "Sejajar", cons: [C(1, 1, 4, "="), C(1, 1, 1, "=")] },
    { label: "Berimpit", cons: [C(1, 1, 4, "="), C(2, 2, 8, "=")] },
  ],
  ptlsv: [
    { label: "Garis putus-putus", cons: [C(1, 1, 6, "<"), C(1, -1, 2, ">")] },
    { label: "Garis penuh", cons: [C(1, 1, 6, "<="), C(1, -1, 2, ">=")] },
    { label: "Tiga pertidaksamaan", cons: [C(1, 0, 5, "<="), C(0, 1, 4, "<="), C(1, 1, 3, ">=")] },
  ],
  lp: [
    { label: "Pabrik roti", cons: [C(2, 1, 8, "<="), C(1, 2, 10, "<=")], p: 3, q: 4, goal: "max" },
    { label: "Maksimum dasar", cons: [C(1, 1, 4, "<="), C(1, 3, 6, "<=")], p: 2, q: 3, goal: "max" },
    {
      label: "Tiga kendala",
      cons: [C(1, 0, 4, "<="), C(0, 1, 3, "<="), C(1, 1, 5, "<=")],
      p: 5,
      q: 4,
      goal: "max",
    },
    { label: "Minimum biaya", cons: [C(1, 1, 4, ">="), C(1, 3, 6, ">=")], p: 2, q: 3, goal: "min" },
  ],
};

const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: true,
  curveWidth: 3,
  pointSize: 4,
};

const NO_REVEAL: Record<Mode, Reveal> = {
  spldv: { region: false, points: false },
  ptlsv: { region: false, points: false },
  lp: { region: false, points: false },
};

/* ───────── Format ───────── */

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const fmtInput = (v: number) => String(Math.round(v * 1000) / 1000);
const tx = (v: number) => fmtN(v).replace("−", "-");
const ptTex = (pt: Pt) => String.raw`(${tx(pt.x)},${tx(pt.y)})`;
const stepText = (v: number) => String(v);

function polyTex(terms: [number, string][]) {
  const parts: string[] = [];
  terms.forEach(([coef, symbol]) => {
    if (Math.abs(coef) < 5e-4) return;
    const abs = Math.abs(coef);
    const body = Math.abs(abs - 1) < 5e-4 ? symbol : `${tx(abs)}${symbol}`;
    if (parts.length === 0) parts.push(coef < 0 ? `-${body}` : body);
    else parts.push(`${coef < 0 ? "-" : "+"} ${body}`);
  });
  return parts.length ? parts.join(" ") : "0";
}

const lineTex = (c: Cons) =>
  `${polyTex([
    [c.a, "x"],
    [c.b, "y"],
  ])}\\ ${OP_TEX[c.op]}\\ ${tx(c.c)}`;

const isStrict = (op: Op) => op === "<" || op === ">";

function sanitize(list: unknown, mode: Mode): Cons[] {
  const max = MAX_BY_MODE[mode];
  if (!Array.isArray(list)) return DEFAULTS[mode];
  const ok = list
    .filter(
      (c): c is Cons =>
        !!c &&
        Number.isFinite(c.a) &&
        Number.isFinite(c.b) &&
        Number.isFinite(c.c) &&
        typeof c.op === "string",
    )
    .map((c) => (mode === "spldv" ? { ...c, op: "=" as Op } : c.op === "=" ? { ...c, op: "<=" as Op } : c))
    .slice(0, max);
  return ok.length > 0 ? ok : DEFAULTS[mode];
}

/* ───────── Helper JSXGraph ───────── */

function makeCreate(board: SimBoard): Creator {
  const raw = board as unknown as {
    create: (type: string, parents: unknown[], attrs: Record<string, unknown>) => unknown;
  };
  return (type, parents, attrs) => raw.create(type, parents, attrs) as JEl;
}

function removeEl(board: SimBoard, el: JEl) {
  try {
    (board as unknown as { removeObject: (o: unknown) => unknown }).removeObject(el);
  } catch {
    /* papan sudah dibebaskan */
  }
}

const HALO = "font-weight:600;white-space:nowrap;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;";

/* ───────── Kolom koefisien dengan tombol − / + ───────── */

function parseNumber(t: string): number | null {
  if (!/^-?\d*[.,]?\d*$/.test(t.trim())) return null;
  const v = parseFloat(t.replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

function CoefField({
  label,
  value,
  step,
  wide = false,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  wide?: boolean;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(fmtInput(value));

  // Nilai berubah dari luar (tombol − / +, contoh, atur ulang): ikuti,
  // kecuali teks yang sedang diketik memang bernilai sama.
  useEffect(() => {
    if (parseNumber(text) !== value) setText(fmtInput(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const bump = (dir: 1 | -1) =>
    onChange(clamp(round6(value + dir * step), -MAX_COEF, MAX_COEF));

  return (
    <div className={`sim-lin-coef${wide ? " sim-lin-coef--wide" : ""}`}>
      <input
        className="sim-input sim-lin-num"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        enterKeyHint="done"
        spellCheck={false}
        aria-label={label}
        value={text}
        onChange={(e) => {
          const t = e.currentTarget.value;
          setText(t);
          const v = parseNumber(t);
          if (v !== null) onChange(clamp(v, -MAX_COEF, MAX_COEF));
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => setText(fmtInput(value))}
      />
      <div className="sim-lin-bumps">
        <button
          type="button"
          className="sim-lin-bump"
          aria-label={`Kurangi ${label} sebesar ${stepText(step)}`}
          onClick={() => bump(-1)}
        >
          −
        </button>
        <button
          type="button"
          className="sim-lin-bump"
          aria-label={`Tambah ${label} sebesar ${stepText(step)}`}
          onClick={() => bump(1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

/* ───────── Editor satu persamaan / pertidaksamaan ───────── */

function ConsEditor({
  index,
  cons,
  color,
  mode,
  step,
  canDelete,
  onChange,
  onDelete,
}: {
  index: number;
  cons: Cons;
  color: string;
  mode: Mode;
  step: number;
  canDelete: boolean;
  onChange: (patch: Partial<Cons>) => void;
  onDelete: () => void;
}) {
  const n = index + 1;
  const noun = mode === "spldv" ? "Persamaan" : "Pertidaksamaan";
  const invalid = !validLine(cons);
  return (
    <div className="sim-lin-card" style={{ "--sim-accent": color } as AccentStyle}>
      <div className="sim-lin-head">
        <span className="sim-lin-swatch" aria-hidden="true" />
        <span className="sim-lin-title">
          {noun} {n}
        </span>
        <span className="sim-lin-preview">{!invalid && <SimMath tex={lineTex(cons)} />}</span>
        <button
          type="button"
          className="sim-icon-btn sim-lin-del"
          aria-label={`Hapus ${noun.toLowerCase()} ${n}`}
          title={`Hapus ${noun.toLowerCase()} ${n}`}
          disabled={!canDelete}
          onClick={onDelete}
        >
          ×
        </button>
      </div>
      <div className="sim-lin-form" role="group" aria-label={`${noun} ${n}`}>
        <CoefField
          label={`a pada ${noun.toLowerCase()} ${n}`}
          value={cons.a}
          step={step}
          onChange={(a) => onChange({ a })}
        />
        <span className="sim-lin-sym">x +</span>
        <CoefField
          label={`b pada ${noun.toLowerCase()} ${n}`}
          value={cons.b}
          step={step}
          onChange={(b) => onChange({ b })}
        />
        <span className="sim-lin-sym">y</span>
        {mode === "spldv" ? (
          <span className="sim-lin-op sim-lin-op--fixed" aria-hidden="true">
            =
          </span>
        ) : (
          <select
            className="sim-lin-op"
            aria-label={`Tanda pertidaksamaan ${n}`}
            value={cons.op}
            onChange={(e) => onChange({ op: e.currentTarget.value as Op })}
          >
            {OPS.map((o) => (
              <option key={o} value={o}>
                {OP_SYMBOL[o]}
              </option>
            ))}
          </select>
        )}
        <CoefField
          label={`c pada ${noun.toLowerCase()} ${n}`}
          value={cons.c}
          step={step}
          onChange={(c) => onChange({ c })}
        />
      </div>
      {invalid && (
        <p className="sim-status is-error" role="alert">
          a dan b tidak boleh keduanya 0.
        </p>
      )}
    </div>
  );
}

/* ───────── Komponen utama ───────── */

export function LinearSystemSimulation() {
  const [storedMode, setMode] = useStoredSimulationState<Mode>("linear-system.v2.mode", "spldv");
  const mode: Mode = MODES.some((m) => m.id === storedMode) ? storedMode : "spldv";

  const [storedEqs, setEqs] = useStoredSimulationState<Cons[]>(
    "linear-system.v2.equations",
    DEFAULTS.spldv,
  );
  const [storedPtl, setPtl] = useStoredSimulationState<Cons[]>(
    "linear-system.v2.inequalities",
    DEFAULTS.ptlsv,
  );
  const [storedLp, setLpCons] = useStoredSimulationState<Cons[]>(
    "linear-system.v2.constraints",
    DEFAULTS.lp,
  );
  const [nnPtl, setNnPtl] = useStoredSimulationState("linear-system.v2.nonneg-ptl", false);
  const [nnLp, setNnLp] = useStoredSimulationState("linear-system.v2.nonneg-lp", true);
  const [p, setP] = useStoredSimulationState("linear-system.v2.objective-p", 3);
  const [q, setQ] = useStoredSimulationState("linear-system.v2.objective-q", 4);
  const [goal, setGoal] = useStoredSimulationState<Goal>("linear-system.v2.goal", "max");
  const [k, setK] = useStoredSimulationState("linear-system.v2.level", 0);
  const [step, setStep] = useStoredSimulationState("linear-system.v2.step", 1);
  const [storedView, setStoredView] = useStoredSimulationState("linear-system.v2.view", initialView);
  const view = useMemo<ViewState>(() => ({ ...initialView, ...storedView }), [storedView]);

  // Tombol "Tampilkan" sengaja tidak disimpan: setiap sesi mulai dari kosong.
  const [reveal, setReveal] = useState<Record<Mode, Reveal>>(NO_REVEAL);

  const eqs = useMemo(() => sanitize(storedEqs, "spldv"), [storedEqs]);
  const ptl = useMemo(() => sanitize(storedPtl, "ptlsv"), [storedPtl]);
  const lpCons = useMemo(() => sanitize(storedLp, "lp"), [storedLp]);

  const list = mode === "spldv" ? eqs : mode === "ptlsv" ? ptl : lpCons;
  const nonneg = mode === "ptlsv" ? nnPtl : mode === "lp" ? nnLp : false;
  const rev = reveal[mode];
  const maxItems = MAX_BY_MODE[mode];

  const setList = (fn: (l: Cons[]) => Cons[]) => {
    if (mode === "spldv") setEqs(fn);
    else if (mode === "ptlsv") setPtl(fn);
    else setLpCons(fn);
  };
  const toggleReveal = (key: keyof Reveal) =>
    setReveal((r) => ({ ...r, [mode]: { ...r[mode], [key]: !r[mode][key] } }));

  /* ───────── Perhitungan ───────── */

  const analysis = useMemo<Analysis>(() => {
    const valid = list.map((c, i) => ({ c, i })).filter(({ c }) => validLine(c));
    if (mode === "spldv") {
      const pairs: Analysis["pairs"] = [];
      const points: MeetPoint[] = [];
      for (let a = 0; a < valid.length; a += 1) {
        for (let b = a + 1; b < valid.length; b += 1) {
          const sol = solve2(valid[a].c, valid[b].c);
          pairs.push({ i: valid[a].i, j: valid[b].i, sol });
          if (sol.kind === "unique") {
            const tag = `${valid[a].i + 1}&${valid[b].i + 1}`;
            const found = points.find((pt) => Math.hypot(pt.x - sol.x, pt.y - sol.y) < 1e-6);
            if (found) found.from.push(tag);
            else points.push({ x: sol.x, y: sol.y, from: [tag] });
          }
        }
      }
      return { pairs, points, region: null, opt: null };
    }
    const cons = valid.map((v) => v.c);
    if (nonneg) cons.push(C(1, 0, 0, ">="), C(0, 1, 0, ">="));
    const region = feasibleRegion(cons);
    const opt = mode === "lp" ? optimize(region, p, q, goal) : null;
    return { pairs: [], points: [], region, opt };
  }, [mode, list, nonneg, p, q, goal]);

  const zAt = (pt: Pt) => p * pt.x + q * pt.y;

  // Rentang z untuk slider garis selidik (mencakup seluruh tampilan awal dan semua titik sudut).
  const kRange = useMemo<[number, number]>(() => {
    const b = HOME.lp;
    const zs = [
      p * b[0] + q * b[3],
      p * b[2] + q * b[3],
      p * b[0] + q * b[1],
      p * b[2] + q * b[1],
    ];
    if (mode === "lp") analysis.region?.vertices.forEach((v) => zs.push(p * v.x + q * v.y));
    return [Math.floor(Math.min(...zs)), Math.ceil(Math.max(...zs))];
  }, [p, q, mode, analysis.region]);

  /* ───────── Ref untuk papan ───────── */

  const sceneRef = useRef<{ grid: JEl; axes: AxisEl[] } | null>(null);
  const levelRef = useRef<{ h: JEl; p: number; q: number } | null>(null);
  const kRef = useRef(k);
  kRef.current = k;
  const stepRef = useRef(step);
  stepRef.current = step;
  const kRangeRef = useRef(kRange);
  kRangeRef.current = kRange;
  const viewRef = useRef(view);
  viewRef.current = view;

  /* ───────── Papan: grid dan sumbu (sekali) ───────── */

  const setup = (board: SimBoard) => {
    const create = makeCreate(board);
    const v = viewRef.current;
    const grid = create("grid", [], {
      strokeColor: colors.grid,
      strokeOpacity: 1,
      strokeWidth: 1,
      highlight: false,
      visible: v.grid,
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
      { ...axisStyle, name: "x", label: { position: "rt", offset: [-14, 14], fontSize: 13 }, ticks },
    ) as AxisEl;
    const yAxis = create(
      "axis",
      [
        [0, 0],
        [0, 1],
      ],
      { ...axisStyle, name: "y", label: { position: "rt", offset: [12, -14], fontSize: 13 }, ticks },
    ) as AxisEl;
    sceneRef.current = { grid, axes: [xAxis, yAxis] };
  };

  const { boardProps, boardRef, zoomIn, zoomOut } = useJsxBoard({
    boundingBox: HOME[mode],
    setup,
  });

  const goHome = () => boardRef.current?.setBoundingBox(HOME[mode], true);

  // Ganti mode → tampilan awal mode itu.
  useEffect(() => {
    boardRef.current?.setBoundingBox(HOME[mode], true);
  }, [mode, boardRef]);

  // Grid dan angka sumbu.
  useEffect(() => {
    const board = boardRef.current;
    const s = sceneRef.current;
    if (!board || !s) return;
    s.grid.setAttribute({ visible: view.grid });
    s.axes.forEach((a) => a.defaultTicks.setAttribute({ drawLabels: view.axisNumbers }));
    const full = (board as unknown as { fullUpdate?: () => unknown }).fullUpdate;
    if (full) full.call(board);
    else board.update();
  }, [view.grid, view.axisNumbers, boardRef]);

  /* ───────── Papan: isi (dibangun ulang bila data berubah) ───────── */

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const create = makeCreate(board);
    const made: JEl[] = [];
    const add = (el: JEl) => {
      made.push(el);
      return el;
    };
    const { curveWidth, pointSize, pointLabels } = view;

    const boxNow = (): Box => {
      const [x1, y1, x2, y2] = board.getBoundingBox();
      const mx = (x2 - x1) * 0.02;
      const my = (y1 - y2) * 0.02;
      return [x1 - mx, y1 + my, x2 + mx, y2 - my];
    };

    // Isian poligon yang dihitung ulang sesuai tampilan saat digeser/di-zoom.
    const fill = (hex: string, opacity: number, get: (b: Box) => Pt[]) => {
      const curve = add(
        create("curve", [[0], [0]], {
          strokeWidth: 0,
          strokeColor: hex,
          fillColor: hex,
          fillOpacity: opacity,
          highlight: false,
          fixed: true,
        }),
      ) as unknown as CurveLike;
      curve.updateDataArray = function (this: CurveLike) {
        const pts = get(boxNow());
        if (pts.length === 0) {
          this.dataX = [0];
          this.dataY = [0];
        } else {
          this.dataX = [...pts.map((pt) => pt.x), pts[0].x];
          this.dataY = [...pts.map((pt) => pt.y), pts[0].y];
        }
      };
    };

    const marker = (
      x: number,
      y: number,
      hex: string,
      size: number,
      extra: Record<string, unknown> = {},
    ) =>
      add(
        create("point", [x, y], {
          name: "",
          withLabel: false,
          size,
          fillColor: hex,
          strokeColor: "#ffffff",
          strokeWidth: 1.5,
          highlightFillColor: hex,
          highlightStrokeColor: "#ffffff",
          fixed: true,
          highlight: false,
          showInfobox: false,
          layer: 7,
          ...extra,
        }),
      );

    const label = (
      x: number,
      y: number,
      text: string,
      hex: string,
      extra: Record<string, unknown> = {},
    ) =>
      add(
        create("text", [x, y, text], {
          fontSize: 12,
          strokeColor: hex,
          anchorX: "left",
          anchorY: "bottom",
          offset: [8, 6],
          highlight: false,
          fixed: true,
          layer: 8,
          cssStyle: HALO,
          ...extra,
        }),
      );

    // 1) Daerah (hanya setelah tombol "Tampilkan daerah" ditekan)
    if (mode !== "spldv" && rev.region) {
      list.forEach((c, i) => {
        if (!validLine(c)) return;
        fill(colors.lines[i], 0.08, (b) => clipByCons(boxPoly(b[0], b[1], b[2], b[3]), c));
      });
      const region = analysis.region;
      if (region && !region.empty) {
        const poly = region.poly;
        fill(colors.region, 0.38, (b) => clipToBox(poly, b));
      }
    }

    // 2) Garis. Putus-putus hanya untuk tanda < dan >.
    list.forEach((c, i) => {
      if (!validLine(c)) return;
      const dashed = mode !== "spldv" && isStrict(c.op);
      add(
        create("line", [-c.c, c.a, c.b], {
          strokeColor: colors.lines[i],
          strokeWidth: curveWidth,
          dash: dashed ? 2 : 0,
          highlight: false,
          fixed: true,
        }),
      );
    });

    // 3) Titik potong SPLDV + garis putus-putus ke sumbu
    if (mode === "spldv" && rev.points) {
      const guide = {
        strokeColor: colors.inter,
        strokeWidth: 1.8,
        dash: 2,
        highlight: false,
        fixed: true,
        firstArrow: false,
        lastArrow: false,
        layer: 6,
      };
      analysis.points.forEach((pt) => {
        if (Math.abs(pt.y) > 1e-9) {
          add(
            create(
              "segment",
              [
                [pt.x, pt.y],
                [pt.x, 0],
              ],
              guide,
            ),
          );
          marker(pt.x, 0, colors.inter, Math.max(2, pointSize - 1));
          if (pointLabels) {
            label(pt.x, 0, fmtN(pt.x), colors.inter, {
              anchorX: "middle",
              anchorY: "top",
              offset: [0, -8],
            });
          }
        }
        if (Math.abs(pt.x) > 1e-9) {
          add(
            create(
              "segment",
              [
                [pt.x, pt.y],
                [0, pt.y],
              ],
              guide,
            ),
          );
          marker(0, pt.y, colors.inter, Math.max(2, pointSize - 1));
          if (pointLabels) {
            label(0, pt.y, fmtN(pt.y), colors.inter, {
              anchorX: "right",
              anchorY: "middle",
              offset: [-8, 0],
            });
          }
        }
        marker(pt.x, pt.y, colors.inter, pointSize + 2);
        if (pointLabels) label(pt.x, pt.y, ptText(pt), colors.inter, { fontSize: 13 });
      });
    }

    // 4) Titik sudut (pertidaksamaan dan program linear)
    if (mode !== "spldv" && rev.points && analysis.region && !analysis.region.empty) {
      const verts = analysis.region.vertices.slice(0, 12);
      const opt = analysis.opt;
      if (mode === "lp" && opt && opt.status === "optimal") {
        opt.points.slice(0, 4).forEach((pt) =>
          marker(pt.x, pt.y, colors.opt, pointSize + 5, {
            strokeColor: colors.optDark,
            strokeWidth: 2,
            fillOpacity: 0.9,
            layer: 6,
          }),
        );
      }
      verts.forEach((pt) => {
        // Titik pada garis putus-putus tidak termasuk daerah: gambar sebagai titik kosong.
        const open =
          mode === "ptlsv" &&
          list.some(
            (c) => isStrict(c.op) && Math.abs(c.a * pt.x + c.b * pt.y - c.c) < 1e-6,
          );
        marker(
          pt.x,
          pt.y,
          open ? "#ffffff" : colors.vertex,
          pointSize,
          open ? { strokeColor: colors.vertex, strokeWidth: 2, highlightFillColor: "#ffffff" } : {},
        );
        if (pointLabels) label(pt.x, pt.y, ptText(pt), colors.vertex);
      });
    }

    // 5) Garis selidik z = k (selalu tampil di program linear; bukan titik potong)
    levelRef.current = null;
    const sq = p * p + q * q;
    if (mode === "lp" && sq > 1e-12) {
      const home = HOME.lp;
      const cx = (home[0] + home[2]) / 2;
      const cy = (home[1] + home[3]) / 2;
      const t0 = (kRef.current - p * cx - q * cy) / sq;
      add(
        create("line", [() => -kRef.current, () => p, () => q], {
          strokeColor: colors.opt,
          strokeWidth: curveWidth + 0.5,
          highlight: false,
          fixed: true,
          layer: 5,
        }),
      );
      const h = add(
        create("point", [cx + t0 * p, cy + t0 * q], {
          name: "",
          withLabel: false,
          size: pointSize + 3,
          fillColor: colors.opt,
          strokeColor: "#ffffff",
          strokeWidth: 2,
          highlightFillColor: colors.opt,
          highlightStrokeColor: "#ffffff",
          showInfobox: false,
          layer: 9,
        }),
      );
      add(
        create(
          "text",
          [() => h.X(), () => h.Y(), () => `z = ${fmtN(kRef.current)}`],
          {
            fontSize: 13,
            strokeColor: colors.optDark,
            anchorX: "left",
            anchorY: "bottom",
            offset: [12, 8],
            highlight: false,
            fixed: true,
            layer: 8,
            cssStyle: HALO,
          },
        ),
      );
      const place = (kk: number) => {
        // Geser pegangan sejajar vektor normal (p, q) sampai tepat di garis p·x + q·y = kk.
        const dz = (kk - (p * h.X() + q * h.Y())) / sq;
        h.setPosition(COORDS_BY_USER, [h.X() + dz * p, h.Y() + dz * q]);
      };
      h.on("drag", () => {
        const [lo, hi] = kRangeRef.current;
        const next = clamp(snapTo(p * h.X() + q * h.Y(), stepRef.current), lo, hi);
        kRef.current = next;
        place(next);
        setK(next);
      });
      levelRef.current = { h, p, q };
    }

    board.update();

    return () => {
      levelRef.current = null;
      for (let i = made.length - 1; i >= 0; i -= 1) removeEl(board, made[i]);
    };
  }, [boardRef, mode, list, rev.region, rev.points, analysis, p, q, view, setK]);

  // Slider / tombol − + untuk z: gerakkan pegangan dan garis selidik.
  useEffect(() => {
    const lv = levelRef.current;
    const board = boardRef.current;
    if (!lv || !board) return;
    const sq = lv.p * lv.p + lv.q * lv.q;
    const dz = (k - (lv.p * lv.h.X() + lv.q * lv.h.Y())) / sq;
    if (Math.abs(dz) > 1e-12) {
      lv.h.setPosition(COORDS_BY_USER, [lv.h.X() + dz * lv.p, lv.h.Y() + dz * lv.q]);
    }
    board.update();
  }, [k, boardRef]);

  // Jaga k tetap di dalam rentang slider bila p, q berubah.
  useEffect(() => {
    if (mode !== "lp") return;
    if (k < kRange[0] || k > kRange[1]) setK(clamp(k, kRange[0], kRange[1]));
  }, [mode, k, kRange, setK]);

  /* ───────── Aksi ───────── */

  const updateCons = (i: number, patch: Partial<Cons>) =>
    setList((l) => l.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addCons = () =>
    setList((l) => (l.length >= maxItems ? l : [...l, { ...NEW_ROW[mode] }]));
  const removeCons = (i: number) =>
    setList((l) => (l.length <= 1 ? l : l.filter((_, idx) => idx !== i)));

  const applyPreset = (preset: Preset) => {
    setList(() => preset.cons.map((c) => ({ ...c })));
    if (mode === "lp") {
      if (preset.p !== undefined) setP(preset.p);
      if (preset.q !== undefined) setQ(preset.q);
      if (preset.goal) setGoal(preset.goal);
      setK(0);
    }
  };

  const resetAll = () => {
    setList(() => DEFAULTS[mode].map((c) => ({ ...c })));
    setReveal((r) => ({ ...r, [mode]: { region: false, points: false } }));
    if (mode === "ptlsv") setNnPtl(false);
    if (mode === "lp") {
      setNnLp(true);
      setP(3);
      setQ(4);
      setGoal("max");
      setK(0);
    }
    goHome();
  };

  const setViewPart = (patch: Partial<ViewState>) => setStoredView({ ...view, ...patch });

  /* ───────── Turunan untuk tampilan panel ───────── */

  const validList = list.map((c, i) => ({ c, i })).filter(({ c }) => validLine(c));
  const opt = analysis.opt;
  const region = analysis.region;
  const verts = region?.vertices ?? [];
  const goalWord = goal === "max" ? "maksimum" : "minimum";
  const objectiveDead = Math.abs(p) < 1e-12 && Math.abs(q) < 1e-12;

  const regionNote = (() => {
    if (!region) return "";
    if (region.empty) return "Tidak ada daerah penyelesaian: pertidaksamaan saling bertentangan.";
    if (region.unbounded) return "Daerah penyelesaian tidak terbatas (meluas tanpa batas).";
    return "Daerah penyelesaian terbatas (berbentuk bangun tertutup).";
  })();

  const optNote = (() => {
    if (!opt) return "";
    if (opt.status === "optimal")
      return `Nilai ${goalWord} Z = ${fmtN(opt.z)}, dicapai di ${opt.points.map(ptText).join(" dan ")}.`;
    if (opt.status === "unbounded") return `Tidak ada nilai ${goalWord}: daerah layak tak terbatas ke arah itu.`;
    if (opt.status === "empty") return "Daerah layak kosong, sehingga tidak ada nilai optimum.";
    return "Z bernilai konstan karena p = q = 0.";
  })();

  /* ───────── Tampilan ───────── */

  const showButtons =
    mode === "spldv" ? (
      <button
        type="button"
        className="sim-text-btn sim-lin-show"
        aria-pressed={rev.points}
        onClick={() => toggleReveal("points")}
      >
        {rev.points ? "Sembunyikan titik potong" : "Tampilkan titik potong"}
      </button>
    ) : (
      <>
        <button
          type="button"
          className="sim-text-btn sim-lin-show"
          aria-pressed={rev.region}
          onClick={() => toggleReveal("region")}
        >
          {rev.region
            ? mode === "lp"
              ? "Sembunyikan daerah layak"
              : "Sembunyikan daerah hasil"
            : mode === "lp"
              ? "Tampilkan daerah layak"
              : "Tampilkan daerah hasil"}
        </button>
        <button
          type="button"
          className="sim-text-btn sim-lin-show"
          aria-pressed={rev.points}
          onClick={() => toggleReveal("points")}
        >
          {rev.points ? "Sembunyikan titik sudut" : "Tampilkan titik sudut"}
        </button>
      </>
    );

  const sectionTitle =
    mode === "spldv"
      ? "Persamaan (maks. 3)"
      : mode === "ptlsv"
        ? "Pertidaksamaan (maks. 4)"
        : "Kendala (maks. 4)";

  return (
    <SimulationShell
      title="Persamaan, pertidaksamaan, dan program linear"
      toggles={
        <>
          <SimToggle
            icon={<GridIcon />}
            label="Grid"
            pressed={view.grid}
            onClick={() => setViewPart({ grid: !view.grid })}
          />
          <SimToggle
            icon={<AxisNumbersIcon />}
            label="Angka sumbu"
            pressed={view.axisNumbers}
            onClick={() => setViewPart({ axisNumbers: !view.axisNumbers })}
          />
          <SimToggle
            icon={<PointLabelIcon />}
            label="Label titik"
            pressed={view.pointLabels}
            onClick={() => setViewPart({ pointLabels: !view.pointLabels })}
          />
        </>
      }
      settings={
        <SimSection title="Tampilan">
          <SimSlider
            id="lin-curve"
            name="tebal garis"
            label="Tebal garis"
            value={view.curveWidth}
            min={1}
            max={6}
            step={0.5}
            onChange={(curveWidth) => setViewPart({ curveWidth })}
          />
          <SimSlider
            id="lin-point"
            name="ukuran titik"
            label="Ukuran titik"
            value={view.pointSize}
            min={2}
            max={8}
            step={1}
            onChange={(pointSize) => setViewPart({ pointSize })}
          />
        </SimSection>
      }
      onReset={resetAll}
      onZoomIn={zoomIn}
      onZoomOut={zoomOut}
      onHome={goHome}
      graph={<div {...boardProps} />}
      overlay={
        validList.length > 0 ? (
          <div className="sim-overlay">
            {validList.map(({ c, i }) => (
              <div key={i} style={{ color: colors.lines[i] }}>
                <SimMath tex={lineTex(c)} />
              </div>
            ))}
            {mode !== "spldv" && nonneg && <SimMath tex={String.raw`x\ge 0,\ y\ge 0`} />}
          </div>
        ) : null
      }
      panel={
        <>
          <SimSection title="Simulasi" sticky>
            <div className="sim-seg" role="radiogroup" aria-label="Pilih simulasi">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  className="sim-seg__btn"
                  onClick={() => setMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </SimSection>

          <SimSection title={sectionTitle}>
            <div className="sim-chips" role="group" aria-label="Contoh soal">
              {PRESETS[mode].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="sim-chip"
                  aria-pressed={false}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {list.map((c, i) => (
              <ConsEditor
                key={i}
                index={i}
                cons={c}
                color={colors.lines[i]}
                mode={mode}
                step={step}
                canDelete={list.length > 1}
                onChange={(patch) => updateCons(i, patch)}
                onDelete={() => removeCons(i)}
              />
            ))}
            <button
              type="button"
              className="sim-text-btn sim-lin-add"
              disabled={list.length >= maxItems}
              onClick={addCons}
            >
              + Tambah {mode === "spldv" ? "persamaan" : "pertidaksamaan"}
            </button>
            {mode !== "spldv" && (
              <button
                type="button"
                className="sim-text-btn"
                aria-pressed={nonneg}
                onClick={() => (mode === "ptlsv" ? setNnPtl(!nnPtl) : setNnLp(!nnLp))}
              >
                Tambahkan x ≥ 0 dan y ≥ 0
              </button>
            )}
          </SimSection>

          <SimSection title="Langkah tombol − / +">
            <div className="sim-seg" role="radiogroup" aria-label="Besar langkah tombol minus dan plus">
              {STEPS.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={step === s}
                  className="sim-seg__btn"
                  onClick={() => setStep(s)}
                >
                  {stepText(s)} satuan
                </button>
              ))}
            </div>
            <p className="sim-hint sim-lin-step-note">
              Berlaku untuk koefisien
              {mode === "lp" ? ", fungsi tujuan, dan pergeseran garis selidik." : "."}
            </p>
          </SimSection>

          {mode === "lp" && (
            <SimSection title="Fungsi tujuan dan garis selidik">
              <div className="sim-lin-objective" role="group" aria-label="Fungsi tujuan Z">
                <span className="sim-lin-sym">Z =</span>
                <CoefField label="p pada Z" value={p} step={step} onChange={setP} />
                <span className="sim-lin-sym">x +</span>
                <CoefField label="q pada Z" value={q} step={step} onChange={setQ} />
                <span className="sim-lin-sym">y</span>
              </div>
              <div className="sim-seg" role="radiogroup" aria-label="Tujuan">
                {(["max", "min"] as Goal[]).map((g) => (
                  <button
                    key={g}
                    type="button"
                    role="radio"
                    aria-checked={goal === g}
                    className="sim-seg__btn"
                    onClick={() => setGoal(g)}
                  >
                    {g === "max" ? "Maksimum" : "Minimum"}
                  </button>
                ))}
              </div>
              {objectiveDead ? (
                <p className="sim-status is-error" role="alert">
                  p dan q tidak boleh keduanya 0.
                </p>
              ) : (
                <>
                  <SimSlider
                    id="lin-level"
                    name="nilai z garis selidik"
                    label={<SimMath tex={`z=${tx(k)}`} />}
                    hint="geser garis selidik"
                    value={clamp(k, kRange[0], kRange[1])}
                    min={kRange[0]}
                    max={kRange[1]}
                    step={step}
                    accent={colors.opt}
                    valueText={`z sama dengan ${fmtN(k)}`}
                    onChange={setK}
                  />
                  <p className="sim-hint">
                    Seret titik emas di grafik, atau pakai tombol − / + (tiap klik mengubah z
                    sebesar {stepText(step)}).
                  </p>
                  <button
                    type="button"
                    className="sim-text-btn"
                    disabled={!(rev.points && opt?.status === "optimal")}
                    onClick={() => {
                      if (opt?.status === "optimal") setK(opt.z);
                    }}
                  >
                    Geser ke titik {goalWord}
                  </button>
                </>
              )}
            </SimSection>
          )}

          <SimSection title="Tampilkan">
            <div className="sim-lin-shows" style={{ "--sim-accent": colors.inter } as AccentStyle}>
              {showButtons}
            </div>
          </SimSection>

          <SimSection title="Hasil">
            <ul className="sim-rows" aria-live="polite">
              {validList.map(({ c, i }) => (
                <SimRow key={i} color={colors.lines[i]}>
                  <SimMath tex={lineTex(c)} />
                </SimRow>
              ))}
              {mode !== "spldv" && nonneg && (
                <SimRow>
                  <SimMath tex={String.raw`x\ge 0,\ y\ge 0`} />
                </SimRow>
              )}
              {mode === "lp" && !objectiveDead && (
                <SimRow color={colors.opt}>
                  <SimMath tex={`Z=${polyTex([[p, "x"], [q, "y"]])}`} />
                </SimRow>
              )}
            </ul>

            {mode === "spldv" &&
              (!rev.points ? (
                <p className="sim-hint">Tekan “Tampilkan titik potong” untuk melihat hasilnya.</p>
              ) : analysis.pairs.length === 0 ? (
                <p className="sim-callout">Isi minimal dua persamaan untuk mencari titik potong.</p>
              ) : (
                <>
                  <ul className="sim-rows">
                    {analysis.pairs.map(({ i, j, sol }) => (
                      <SimRow key={`${i}-${j}`}>
                        <span className="sim-wrap">
                          Persamaan {i + 1} dan {j + 1}:{" "}
                          {sol.kind === "unique" ? (
                            <SimMath tex={ptTex(sol)} />
                          ) : sol.kind === "parallel" ? (
                            "sejajar, tidak berpotongan"
                          ) : (
                            "berimpit, titik potongnya tak hingga banyak"
                          )}
                        </span>
                      </SimRow>
                    ))}
                  </ul>
                  {analysis.points.length === 1 && analysis.pairs.length === 3 && (
                    <p className="sim-callout" role="status">
                      Ketiga garis berpotongan di satu titik yang sama.
                    </p>
                  )}
                </>
              ))}

            {mode !== "spldv" && (
              <>
                {!rev.region && !rev.points && (
                  <p className="sim-hint">
                    Tekan tombol “Tampilkan” untuk melihat{" "}
                    {mode === "lp" ? "daerah layak dan titik sudut" : "daerah hasil dan titik sudut"}.
                  </p>
                )}
                {rev.region && (
                  <p className="sim-callout" role="status">
                    {regionNote}
                  </p>
                )}
                {rev.points && region && !region.empty && (
                  <>
                    <ul className="sim-rows">
                      <SimRow color={colors.vertex}>
                        {verts.length === 0 ? (
                          <span>Tidak ada titik sudut.</span>
                        ) : (
                          <SimMath tex={verts.map(ptTex).join(String.raw`\ `)} />
                        )}
                      </SimRow>
                    </ul>
                    {mode === "ptlsv" && list.some((c) => isStrict(c.op)) && (
                      <p className="sim-hint">
                        Titik kosong berada pada garis putus-putus, jadi tidak termasuk daerah hasil.
                      </p>
                    )}
                  </>
                )}
                {mode === "ptlsv" && rev.points && region?.empty && (
                  <p className="sim-callout" role="status">
                    {regionNote}
                  </p>
                )}
              </>
            )}

            {mode === "lp" && rev.points && (
              <>
                {verts.length > 0 && !objectiveDead && (
                  <div className="sim-table-wrap" style={{ marginTop: 6 }}>
                    <table className="sim-table sim-table--left">
                      <caption>
                        Z = {fmtN(p)}x + {fmtN(q)}y (cari {goalWord})
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Titik sudut</th>
                          <th scope="col">Z</th>
                          <th scope="col" />
                        </tr>
                      </thead>
                      <tbody>
                        {verts.map((vt, i) => {
                          const best =
                            opt?.status === "optimal" &&
                            Math.abs(zAt(vt) - opt.z) < 1e-6 * (1 + Math.abs(opt.z));
                          return (
                            <tr key={i} className={best ? "sim-table__limit" : ""}>
                              <th scope="row">{ptText(vt)}</th>
                              <td>{fmtN(zAt(vt))}</td>
                              <td>{best ? `← ${goalWord}` : ""}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {optNote && (
                  <p className="sim-callout" role="status">
                    {optNote}
                  </p>
                )}
              </>
            )}
          </SimSection>
        </>
      }
      notes={
        mode === "spldv" ? (
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.inter }}>Titik potong: </strong>
            penyelesaian SPLDV adalah titik potong dua garis. Garis putus-putus merah dari titik
            potong menunjukkan nilai x (pada sumbu-x) dan nilai y (pada sumbu-y). Dua garis bisa
            berpotongan, sejajar, atau berimpit.
          </p>
        ) : mode === "ptlsv" ? (
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.region }}>Daerah hasil: </strong>
            irisan semua sisi yang memenuhi tiap pertidaksamaan. Tanda <SimMath tex="<" /> atau{" "}
            <SimMath tex=">" /> memakai garis putus-putus (garis tidak ikut), tanda{" "}
            <SimMath tex={String.raw`\le`} /> atau <SimMath tex={String.raw`\ge`} /> memakai garis
            penuh.
          </p>
        ) : (
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.opt }}>Garis selidik: </strong>
            geser garis <SimMath tex="z=k" /> sejajar dirinya sendiri. Titik terakhir di daerah layak
            yang disentuh garis itu adalah titik {goalWord}.
          </p>
        )
      }
    />
  );
}

export default LinearSystemSimulation;
