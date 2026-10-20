import { useEffect, useMemo, useRef, useState } from "react";
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
import { clamp } from "../common/utils/simUtils";
import { useJsxBoard, type BoundingBox, type SimBoard } from "../common/hooks/useJsxBoard";
import { useStoredSimulationState } from "../common/hooks/useStoredSimulationState";
import { FN_KEYS, FUNCS, calcColors, type FnKey } from "../math/calculusFunctions";

/* Simulasi turunan: tali busur PQ → garis singgung di P saat h → 0.
   Kerangka, slider, dan CSS memakai kit umum (prefix sim-), sama seperti
   simulasi fungsi kuadrat. */

type Params = { fn: FnKey; x0: number; h: number };
type ObjectKey = "curve" | "tangent" | "secant" | "helpers" | "p" | "q";
type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean;
  curveWidth: number;
  pointSize: number;
  show: Record<ObjectKey, boolean>;
};

const initialParams: Params = { fn: "quad", x0: 1, h: 2 };
const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: true,
  curveWidth: 3,
  pointSize: 4,
  show: {
    curve: true,
    tangent: true,
    secant: true,
    helpers: true,
    p: true,
    q: true,
  },
};
const initialBox: BoundingBox = [-7, 7, 7, -7];

const X0_LIMIT = 4;
const H_LIMIT = 3;
/** h dipangkas separuh setiap 450 ms / faktor ini. */
const ANIMATION_SPEED_FACTOR = 0.25;
const H_MIN = 0.0005;

const colors = {
  curve: calcColors.curve,
  tangent: calcColors.tangent,
  secant: calcColors.secant,
  p: calcColors.point,
  q: calcColors.secant,
  helper: "#9aa8b0",
  gap: "#c62828",
  grid: "#dcdce2",
  axis: "#4a4a55",
};

type Settable = { setAttribute: (attributes: Record<string, unknown>) => unknown };
type AxisElement = Settable & { defaultTicks: Settable };
type Marker = { point: Settable; label: Settable };
type Scene = {
  grid: Settable;
  axes: AxisElement[];
  curve: Settable;
  tangent: Settable;
  secant: Settable;
  helpers: Settable[];
  p: Marker;
  q: Marker;
};

const finite = (value: number) => Number.isFinite(value);

/* ───────── Format angka (titik desimal, minus sebenarnya) ───────── */

const formatters = new Map<number, Intl.NumberFormat>();
function fmt(value: number, digits = 2) {
  if (!finite(value)) return "—";
  let nf = formatters.get(digits);
  if (!nf) {
    nf = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: digits,
      useGrouping: false,
    });
    formatters.set(digits, nf);
  }
  if (Math.abs(value) < 0.5 * 10 ** -digits) return "0";
  return nf.format(value).replace("-", "−");
}

/** Angka untuk KaTeX: titik desimal tanpa spasi, minus sebagai "-". */
function tex(value: number, digits = 2) {
  return fmt(value, digits).replace("−", "-");
}

/** Angka negatif diberi kurung agar aman dipakai di rumus. */
function texParen(value: number, digits = 2) {
  return value < 0 ? `(${tex(value, digits)})` : tex(value, digits);
}

export function DerivativeSimulation() {
  const [params, setParams] = useStoredSimulationState(
    "derivative.params",
    initialParams,
  );
  const [storedView, setStoredView] = useStoredSimulationState(
    "derivative.view",
    initialView,
  );
  const view = useMemo<ViewState>(
    () => ({
      ...initialView,
      ...storedView,
      show: { ...initialView.show, ...storedView.show },
    }),
    [storedView],
  );

  // Jaga-jaga bila nilai tersimpan berisi fungsi yang sudah tidak ada.
  const safeParams = useMemo<Params>(
    () => ({
      ...initialParams,
      ...params,
      fn: FN_KEYS.includes(params.fn) ? params.fn : initialParams.fn,
    }),
    [params],
  );

  const paramsRef = useRef(safeParams);
  paramsRef.current = safeParams;
  const viewRef = useRef(view);
  viewRef.current = view;
  const scene = useRef<Scene | null>(null);
  const rafRef = useRef<number | null>(null);
  const [animating, setAnimating] = useState(false);

  /* ───────── Papan JSXGraph ───────── */

  const setup = (board: SimBoard) => {
    const p = () => paramsRef.current;
    const F = () => FUNCS[p().fn];
    const hZero = () => Math.abs(p().h) < 1e-9;
    const qx = () => p().x0 + p().h;
    const qy = () => (hZero() ? Number.NaN : F().f(qx()));
    const py = () => F().f(p().x0);
    const secantSlope = () =>
      hZero() ? Number.NaN : (F().f(qx()) - F().f(p().x0)) / p().h;

    const v = viewRef.current;

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

    // Garis singgung di P
    const tangent = board.create(
      "functiongraph",
      [(x: number) => py() + F().df(p().x0) * (x - p().x0)],
      {
        strokeColor: colors.tangent,
        strokeWidth: 2,
        dash: 2,
        highlight: false,
      },
    ) as unknown as Settable;

    // Tali busur PQ
    const secant = board.create(
      "functiongraph",
      [
        (x: number) => {
          const m = secantSlope();
          return finite(m) ? py() + m * (x - p().x0) : Number.NaN;
        },
      ],
      {
        strokeColor: colors.secant,
        strokeWidth: 2.5,
        highlight: false,
      },
    ) as unknown as Settable;

    // Segmen bantu: Δx (mendatar) dan Δy (tegak)
    const helperStyle = {
      strokeWidth: 1.5,
      dash: 2,
      highlight: false,
      fixed: true,
      point1: { visible: false },
      point2: { visible: false },
    };
    const deltaX = board.create(
      "segment",
      [
        [() => p().x0, py],
        [qx, py],
      ],
      { ...helperStyle, strokeColor: colors.helper },
    ) as unknown as Settable;
    const deltaY = board.create(
      "segment",
      [
        [qx, py],
        [qx, () => F().f(qx())],
      ],
      { ...helperStyle, strokeColor: colors.secant },
    ) as unknown as Settable;

    // Kurva utama
    const curve = board.create("functiongraph", [(x: number) => F().f(x)], {
      strokeColor: colors.curve,
      strokeWidth: v.curveWidth,
      highlight: false,
    }) as unknown as Settable;

    // Titik + label koordinat
    const marker = (
      x: () => number,
      y: () => number,
      color: string,
      extra: number,
      name: string,
    ): Marker => {
      const point = board.create("point", [x, y], {
        name: "",
        withLabel: false,
        size: v.pointSize + extra,
        fillColor: color,
        strokeColor: "#ffffff",
        strokeWidth: 1.5,
        fixed: true,
        highlight: false,
        showInfobox: false,
      }) as unknown as Settable;
      const label = board.create(
        "text",
        [
          () => (finite(x()) ? x() + 8 / board.unitX : 0),
          () => (finite(y()) ? y() + 6 / board.unitY : 0),
          () =>
            finite(x()) && finite(y())
              ? `${name}(${fmt(x())}, ${fmt(y())})`
              : "",
        ],
        {
          anchorX: "left",
          anchorY: "bottom",
          fontSize: 12,
          strokeColor: color,
          highlight: false,
          fixed: true,
          cssStyle:
            "font-weight:600;white-space:nowrap;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;",
        },
      ) as unknown as Settable;
      return { point, label };
    };

    scene.current = {
      grid,
      axes: [xAxis, yAxis],
      curve,
      tangent,
      secant,
      helpers: [deltaX, deltaY],
      q: marker(qx, qy, colors.q, 0.5, "Q"),
      p: marker(() => p().x0, py, colors.p, 1, "P"),
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

    s.grid.setAttribute({ visible: v.grid });
    s.axes.forEach((axis) =>
      axis.defaultTicks.setAttribute({
        visible: v.axisNumbers,
        drawLabels: v.axisNumbers,
      }),
    );

    const thin = Math.max(1.5, v.curveWidth * 0.7);
    s.curve.setAttribute({ visible: v.show.curve, strokeWidth: v.curveWidth });
    s.tangent.setAttribute({ visible: v.show.tangent, strokeWidth: thin });
    s.secant.setAttribute({
      visible: v.show.secant,
      strokeWidth: thin + 0.5,
    });
    s.helpers.forEach((h) =>
      h.setAttribute({ visible: v.show.helpers, strokeWidth: 1.5 }),
    );

    const apply = (item: Marker, shown: boolean, extra: number) => {
      item.point.setAttribute({ visible: shown, size: v.pointSize + extra });
      item.label.setAttribute({ visible: shown && v.pointLabels });
    };
    apply(s.p, v.show.p, 1);
    apply(s.q, v.show.q, 0.5);

    boardRef.current?.update();
  }

  useEffect(() => {
    applyView();
  }, [view]);

  useEffect(() => {
    boardRef.current?.update();
  }, [safeParams, boardRef]);

  /* ───────── Perubahan dari pengguna ───────── */

  const patch = (change: Partial<Params>) => {
    const next = { ...paramsRef.current, ...change };
    paramsRef.current = next;
    setParams(next);
    boardRef.current?.update();
  };

  const stopAnimation = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setAnimating(false);
  };

  // Animasi h → 0: h dipangkas separuh setiap 450 ms pada kecepatan penuh.
  const toggleAnimation = () => {
    if (rafRef.current !== null) {
      stopAnimation();
      return;
    }
    const current = paramsRef.current.h;
    if (Math.abs(current) < 0.05) patch({ h: current < 0 ? -3 : 3 });
    setAnimating(true);
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(now - last, 64);
      last = now;
      const next =
        paramsRef.current.h * Math.pow(0.5, dt / (450 / ANIMATION_SPEED_FACTOR));
      if (Math.abs(next) < H_MIN) {
        patch({ h: next < 0 ? -H_MIN : H_MIN });
        rafRef.current = null;
        setAnimating(false);
        return;
      }
      patch({ h: next });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const resetParams = () => {
    stopAnimation();
    patch(initialParams);
  };

  const updateView = (change: Partial<ViewState>) => {
    const next = { ...viewRef.current, ...change };
    viewRef.current = next;
    setStoredView(next);
  };

  const toggleShow = (key: ObjectKey) =>
    updateView({
      show: { ...viewRef.current.show, [key]: !viewRef.current.show[key] },
    });

  /* ───────── Nilai turunan ───────── */

  const { fn: fnKey, x0, h } = safeParams;
  const fn = FUNCS[fnKey];
  const fx0 = fn.f(x0);
  const hZero = Math.abs(h) < 1e-9;
  const mSec = hZero ? Number.NaN : (fn.f(x0 + h) - fx0) / h;
  const mTan = fn.df(x0);
  const gap = finite(mSec) ? Math.abs(mSec - mTan) : Number.NaN;
  const qxVal = x0 + h;
  const qyVal = fn.f(qxVal);

  const tableRows = [1, 0.1, 0.01, 0.001].map((hh) => ({
    hh,
    minus: (fn.f(x0 - hh) - fx0) / -hh,
    plus: (fn.f(x0 + hh) - fx0) / hh,
  }));

  const slopeTex = hZero
    ? String.raw`m_{PQ}=\tfrac{0}{0}\ \to\ f'(x_0)=${tex(mTan, 3)}`
    : String.raw`m_{PQ}=${tex(mSec, 3)}\ \to\ f'(x_0)=${tex(mTan, 3)}`;

  /* ───────── Tampilan ───────── */

  return (
    <SimulationShell
      title="Simulasi turunan"
      onReset={resetParams}
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
            id="derivative-curve-width"
            name="tebal kurva"
            label={`Tebal kurva: ${view.curveWidth}`}
            value={view.curveWidth}
            min={1}
            max={8}
            step={1}
            onChange={(curveWidth) => updateView({ curveWidth })}
          />
          <SimSlider
            id="derivative-point-size"
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
          aria-label="Grafik fungsi f dengan tali busur melalui titik P dan Q serta garis singgung di P. Seret untuk menggeser, cubit atau gulir untuk memperbesar."
        />
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          <SimMath tex={slopeTex} />
        </p>
      }
      panel={
        <>
          <SimSection title="Fungsi">
            <div
              className="sim-seg"
              role="radiogroup"
              aria-label="Pilih fungsi"
            >
              {FN_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={fnKey === key}
                  className="sim-seg__btn"
                  onClick={() => patch({ fn: key })}
                >
                  {FUNCS[key].short}
                </button>
              ))}
            </div>
          </SimSection>

          <SimSection title="Parameter" sticky>
            <SimSlider
              id="derivative-x0"
              name="x nol"
              label={<SimMath tex={`x_0=${tex(x0, 1)}`} />}
              hint="posisi titik P"
              accent={colors.p}
              value={x0}
              min={-X0_LIMIT}
              max={X0_LIMIT}
              step={0.1}
              valueText={`x nol sama dengan ${fmt(x0, 1)}`}
              onChange={(value) => patch({ x0: value })}
            />
            <SimSlider
              id="derivative-h"
              name="h"
              label={<SimMath tex={`h=${tex(h, 3)}`} />}
              hint="jarak P ke Q (Δx)"
              accent={colors.secant}
              value={clamp(h, -H_LIMIT, H_LIMIT)}
              min={-H_LIMIT}
              max={H_LIMIT}
              step={0.01}
              valueText={`h sama dengan ${fmt(h, 3)}`}
              onChange={(value) => {
                stopAnimation();
                patch({ h: value });
              }}
            />
            <button
              type="button"
              className="sim-text-btn"
              aria-pressed={animating}
              onClick={toggleAnimation}
            >
              {animating ? "Hentikan" : "Animasikan h → 0"}
            </button>
          </SimSection>

          <SimSection title="Hasil">
            <ul className="sim-rows" aria-live="polite">
              <SimRow
                color={colors.curve}
                visible={view.show.curve}
                onToggle={() => toggleShow("curve")}
                toggleLabel="Tampilkan atau sembunyikan kurva f(x)"
              >
                <span>
                  {fn.label} · {fn.dLabel}
                </span>
              </SimRow>
              <SimRow
                color={colors.p}
                visible={view.show.p}
                onToggle={() => toggleShow("p")}
                toggleLabel="Tampilkan atau sembunyikan titik P"
              >
                <SimMath
                  tex={String.raw`P(${tex(x0, 1)},${tex(fx0)})`}
                />
              </SimRow>
              <SimRow
                color={colors.q}
                visible={view.show.q}
                onToggle={() => toggleShow("q")}
                toggleLabel="Tampilkan atau sembunyikan titik Q"
              >
                <SimMath
                  tex={
                    hZero
                      ? String.raw`Q:\ \text{berimpit dengan }P`
                      : String.raw`Q(${tex(qxVal, 3)},${tex(qyVal, 3)})`
                  }
                />
              </SimRow>
              <SimRow
                color={colors.secant}
                visible={view.show.secant}
                onToggle={() => toggleShow("secant")}
                toggleLabel="Tampilkan atau sembunyikan tali busur"
              >
                <SimMath
                  tex={
                    hZero
                      ? String.raw`m_{PQ}=\tfrac{0}{0}`
                      : String.raw`m_{PQ}=\dfrac{\Delta y}{\Delta x}=${tex(mSec, 4)}`
                  }
                />
              </SimRow>
              <SimRow
                color={colors.tangent}
                visible={view.show.tangent}
                onToggle={() => toggleShow("tangent")}
                toggleLabel="Tampilkan atau sembunyikan garis singgung"
              >
                <SimMath tex={`f'(x_0)=${tex(mTan, 4)}`} />
              </SimRow>
              <SimRow
                color={colors.helper}
                visible={view.show.helpers}
                onToggle={() => toggleShow("helpers")}
                toggleLabel="Tampilkan atau sembunyikan segmen Δx dan Δy"
              >
                <SimMath
                  tex={
                    hZero
                      ? String.raw`\Delta x=0,\ \Delta y=0`
                      : String.raw`\Delta x=${tex(h, 3)},\ \Delta y=${tex(qyVal - fx0, 3)}`
                  }
                />
              </SimRow>
              <SimRow>
                <SimMath
                  tex={
                    hZero
                      ? String.raw`|m_{PQ}-f'(x_0)|=\text{—}`
                      : String.raw`|m_{PQ}-f'(x_0)|=${tex(gap, 4)}`
                  }
                />
              </SimRow>
              <SimRow>
                <SimMath
                  tex={String.raw`y=${tex(mTan)}\,(x-${texParen(x0, 1)})+${texParen(fx0)}`}
                />
              </SimRow>
            </ul>
            {hZero && (
              <p
                role="status"
                style={{ margin: "6px 0 0", color: "#c62828", fontSize: "0.95em" }}
              >
                Saat h = 0, titik Q berimpit dengan P sehingga kemiringan tali
                busur berbentuk 0/0 (tak terdefinisi). Karena itu turunan
                didefinisikan sebagai limit saat h mendekati 0.
              </p>
            )}
          </SimSection>

          <SimSection title="Pendekatan limit">
            <div className="sim-table-wrap">
              <table className="sim-table">
                <caption>
                  Kemiringan tali busur di x₀ = {fmt(x0, 1)} untuk h yang makin
                  kecil
                </caption>
                <thead>
                  <tr>
                    <th scope="col">h</th>
                    <th scope="col">dari kiri (−h)</th>
                    <th scope="col">dari kanan (+h)</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row) => (
                    <tr key={row.hh}>
                      <th scope="row">{fmt(row.hh, 3)}</th>
                      <td>{fmt(row.minus, 4)}</td>
                      <td>{fmt(row.plus, 4)}</td>
                    </tr>
                  ))}
                  <tr className="sim-table__limit">
                    <th scope="row">h → 0</th>
                    <td colSpan={2}>{`f′(x₀) = ${fmt(mTan, 4)}`}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </SimSection>
        </>
      }
      notes={
        <>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.secant }}>Tali busur: </strong>
            kemiringan PQ adalah{" "}
            <SimMath tex={String.raw`\dfrac{f(x_0+h)-f(x_0)}{h}`} />. Saat h
            mengecil, titik Q merapat ke P dan tali busur berputar menuju garis
            singgung.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.tangent }}>
              Limit dan turunan:{" "}
            </strong>
            <SimMath
              tex={String.raw`f'(x_0)=\lim_{h\to 0}\dfrac{f(x_0+h)-f(x_0)}{h}=${tex(mTan, 4)}`}
            />
            . Limit ada karena pendekatan dari kiri dan kanan menuju nilai yang
            sama (lihat tabel).
          </p>
        </>
      }
    />
  );
}
