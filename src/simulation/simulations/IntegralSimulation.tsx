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

/* Simulasi integral: jumlah Riemann → integral tentu.
   Kerangka, slider, dan CSS memakai kit umum (prefix sim-), sama seperti
   simulasi fungsi kuadrat dan turunan. */

/* ───────── Tipe & konstanta ───────── */

type Method = "left" | "right" | "mid";
type Params = {
  fn: FnKey;
  a: number; // batas bawah
  b: number; // batas atas
  n: number; // banyak persegi panjang
  method: Method;
};
type ObjectKey = "curve" | "rects" | "bounds";
type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean;
  curveWidth: number;
  pointSize: number;
  show: Record<ObjectKey, boolean>;
};

const initialParams: Params = { fn: "quad", a: -3, b: 3, n: 6, method: "left" };
const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: true,
  curveWidth: 3,
  pointSize: 4,
  show: { curve: true, rects: true, bounds: true },
};
const initialBox: BoundingBox = [-7, 7, 7, -7];

const A_RANGE = [-6, 5.5] as const;
const B_RANGE = [-5.5, 6] as const;
const N_RANGE = [1, 100] as const;
const MIN_GAP = 0.5;
const N_STEPS = [
  1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100,
];
/** Jeda antar langkah animasi n (ms) = 550 / faktor. */
const ANIMATION_SPEED_FACTOR = 0.25;

const METHODS: { key: Method; label: string; full: string }[] = [
  { key: "left", label: "Kiri", full: "titik kiri" },
  { key: "right", label: "Kanan", full: "titik kanan" },
  { key: "mid", label: "Tengah", full: "titik tengah" },
];

const colors = {
  a: "#6557d2",
  b: "#e65100",
  n: "#2e7d32",
  curve: calcColors.curve,
  area: calcColors.area,
  point: calcColors.point,
  error: "#c62828",
  ink: "#4a4a55",
  grid: "#dcdce2",
  axis: "#4a4a55",
};

type Settable = { setAttribute: (attributes: Record<string, unknown>) => unknown };
type AxisElement = Settable & { defaultTicks: Settable };
type DataCurve = Settable & {
  dataX: number[];
  dataY: number[];
  updateDataArray: () => void;
};
type Marker = { point: Settable; label: Settable };
type Scene = {
  grid: Settable;
  axes: AxisElement[];
  curve: Settable;
  rects: Settable[];
  boundLines: Settable[];
  boundPoints: Marker[];
};

const finite = (value: number) => Number.isFinite(value);
const round1 = (value: number) => Math.round(value * 10) / 10;

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

/* ───────── Jumlah Riemann ───────── */

function riemann({ fn, a, b, n, method }: Params) {
  const { f } = FUNCS[fn];
  const dx = (b - a) / n;
  const heights: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const left = a + i * dx;
    const right = left + dx;
    const sample =
      method === "left" ? left : method === "right" ? right : (left + right) / 2;
    heights.push(f(sample));
  }
  const sum = heights.reduce((total, h) => total + h, 0) * dx;
  return { dx, heights, sum };
}

export function IntegralSimulation() {
  const [params, setParams] = useStoredSimulationState(
    "integral.params",
    initialParams,
  );
  const [storedView, setStoredView] = useStoredSimulationState(
    "integral.view",
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

  // Jaga-jaga bila nilai tersimpan sudah tidak valid.
  const safeParams = useMemo<Params>(() => {
    const merged = { ...initialParams, ...params };
    return {
      fn: FN_KEYS.includes(merged.fn) ? merged.fn : initialParams.fn,
      a: clamp(merged.a, A_RANGE[0], A_RANGE[1]),
      b: clamp(merged.b, B_RANGE[0], B_RANGE[1]),
      n: clamp(Math.round(merged.n), N_RANGE[0], N_RANGE[1]),
      method: METHODS.some((m) => m.key === merged.method)
        ? merged.method
        : initialParams.method,
    };
  }, [params]);

  const paramsRef = useRef(safeParams);
  paramsRef.current = safeParams;
  const viewRef = useRef(view);
  viewRef.current = view;
  const scene = useRef<Scene | null>(null);
  const timerRef = useRef<number | null>(null);
  const [animating, setAnimating] = useState(false);

  /* ───────── Papan JSXGraph ───────── */

  const setup = (board: SimBoard) => {
    const p = () => paramsRef.current;
    const F = () => FUNCS[p().fn];

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

    // Persegi panjang Riemann: isi
    const fill = board.create("curve", [[0], [0]], {
      strokeWidth: 0,
      fillColor: colors.area,
      fillOpacity: 0.28,
      highlight: false,
    }) as unknown as DataCurve;
    fill.updateDataArray = function (this: DataCurve) {
      const { a, b } = p();
      const { dx, heights } = riemann(p());
      const xs: number[] = [a];
      const ys: number[] = [0];
      heights.forEach((h, i) => {
        xs.push(a + i * dx, a + (i + 1) * dx);
        ys.push(h, h);
      });
      xs.push(b);
      ys.push(0);
      this.dataX = xs;
      this.dataY = ys;
    };

    // Persegi panjang Riemann: garis tepi
    const outline = board.create("curve", [[0], [0]], {
      strokeColor: colors.area,
      strokeWidth: 1.4,
      highlight: false,
    }) as unknown as DataCurve;
    outline.updateDataArray = function (this: DataCurve) {
      const { a } = p();
      const { dx, heights } = riemann(p());
      const xs: number[] = [];
      const ys: number[] = [];
      heights.forEach((h, i) => {
        const x0 = a + i * dx;
        const x1 = x0 + dx;
        xs.push(x0, x0, x1, x1, x0, Number.NaN);
        ys.push(0, h, h, 0, 0, Number.NaN);
      });
      this.dataX = xs;
      this.dataY = ys;
    };

    // Batas a dan b: garis vertikal tak berhingga
    const boundX = [() => p().a, () => p().b];
    const boundLines = boundX.map(
      (edge) =>
        board.create(
          "line",
          [
            [edge, 0],
            [edge, 1],
          ],
          {
            straightFirst: true,
            straightLast: true,
            strokeColor: colors.point,
            strokeWidth: 1.2,
            dash: 2,
            highlight: false,
            fixed: true,
            point1: { visible: false },
            point2: { visible: false },
          },
        ) as unknown as Settable,
    );

    // Kurva utama (tanpa batas domain: mengikuti area yang terlihat)
    const curve = board.create("functiongraph", [(x: number) => F().f(x)], {
      strokeColor: colors.curve,
      strokeWidth: v.curveWidth,
      highlight: false,
    }) as unknown as Settable;

    // Titik di batas + label koordinat
    const marker = (x: () => number, y: () => number): Marker => {
      const point = board.create("point", [x, y], {
        name: "",
        withLabel: false,
        size: v.pointSize,
        fillColor: colors.point,
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
            finite(x()) && finite(y()) ? `(${fmt(x())}, ${fmt(y())})` : "",
        ],
        {
          anchorX: "left",
          anchorY: "bottom",
          fontSize: 12,
          strokeColor: colors.point,
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
      rects: [fill, outline],
      boundLines,
      boundPoints: boundX.map((edge) => marker(edge, () => F().f(edge()))),
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

    s.curve.setAttribute({ visible: v.show.curve, strokeWidth: v.curveWidth });
    s.rects.forEach((item) => item.setAttribute({ visible: v.show.rects }));
    s.boundLines.forEach((line) =>
      line.setAttribute({
        visible: v.show.bounds,
        strokeWidth: Math.max(1, v.curveWidth / 2),
      }),
    );
    s.boundPoints.forEach((item) => {
      item.point.setAttribute({ visible: v.show.bounds, size: v.pointSize });
      item.label.setAttribute({ visible: v.show.bounds && v.pointLabels });
    });

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
    const next: Params = { ...paramsRef.current, ...change };
    if (change.a !== undefined) {
      next.a = round1(next.a);
      if (next.a > next.b - MIN_GAP) next.b = round1(next.a + MIN_GAP);
    }
    if (change.b !== undefined) {
      next.b = round1(next.b);
      if (next.b < next.a + MIN_GAP) next.a = round1(next.b - MIN_GAP);
    }
    paramsRef.current = next;
    setParams(next);
    boardRef.current?.update();
  };

  const stopAnimation = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    setAnimating(false);
  };

  // Animasi n: 1 → 100 persegi panjang.
  const toggleAnimation = () => {
    if (timerRef.current !== null) {
      stopAnimation();
      return;
    }
    let index = 0;
    patch({ n: N_STEPS[0] });
    setAnimating(true);
    timerRef.current = window.setInterval(() => {
      index += 1;
      if (index >= N_STEPS.length) {
        stopAnimation();
        return;
      }
      patch({ n: N_STEPS[index] });
    }, 550 / ANIMATION_SPEED_FACTOR);
  };

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
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

  const { fn: fnKey, a, b, n, method } = safeParams;
  const fn = FUNCS[fnKey];
  const rm = riemann(safeParams);
  const exact = fn.F(b) - fn.F(a);
  const error = rm.sum - exact;
  const methodName = METHODS.find((m) => m.key === method)?.full ?? "";

  const overlayTex = String.raw`S_{${n}}=${tex(rm.sum, 3)}\ \to\ \int_{${tex(a, 1)}}^{${tex(b, 1)}} f(x)\,dx=${tex(exact, 3)}`;

  /* ───────── Tampilan ───────── */

  return (
    <SimulationShell
      title="Simulasi integral"
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
            id="integral-curve-width"
            name="tebal kurva"
            label={`Tebal kurva: ${view.curveWidth}`}
            value={view.curveWidth}
            min={1}
            max={8}
            step={1}
            onChange={(curveWidth) => updateView({ curveWidth })}
          />
          <SimSlider
            id="integral-point-size"
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
          aria-label="Grafik fungsi f dengan n persegi panjang Riemann di antara batas a dan b. Seret untuk menggeser, cubit atau gulir untuk memperbesar."
        />
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          <SimMath tex={overlayTex} />
        </p>
      }
      panel={
        <>
          <SimSection title="Fungsi">
            <div className="sim-seg" role="radiogroup" aria-label="Pilih fungsi">
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
            <h3 className="sim-section__title" style={{ marginTop: 8 }}>
              Titik tinggi persegi panjang
            </h3>
            <div
              className="sim-seg"
              role="radiogroup"
              aria-label="Titik tinggi persegi panjang"
            >
              {METHODS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="radio"
                  aria-checked={method === m.key}
                  className="sim-seg__btn"
                  onClick={() => patch({ method: m.key })}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </SimSection>

          <SimSection title="Parameter" sticky>
            <SimSlider
              id="integral-a"
              name="a"
              label={<SimMath tex={`a=${tex(a, 1)}`} />}
              hint="batas bawah"
              accent={colors.a}
              value={a}
              min={A_RANGE[0]}
              max={A_RANGE[1]}
              step={0.1}
              valueText={`a sama dengan ${fmt(a, 1)}`}
              onChange={(value) => patch({ a: value })}
            />
            <SimSlider
              id="integral-b"
              name="b"
              label={<SimMath tex={`b=${tex(b, 1)}`} />}
              hint="batas atas"
              accent={colors.b}
              value={b}
              min={B_RANGE[0]}
              max={B_RANGE[1]}
              step={0.1}
              valueText={`b sama dengan ${fmt(b, 1)}`}
              onChange={(value) => patch({ b: value })}
            />
            <SimSlider
              id="integral-n"
              name="n"
              label={<SimMath tex={`n=${n}`} />}
              hint="banyak persegi panjang"
              accent={colors.n}
              value={n}
              min={N_RANGE[0]}
              max={N_RANGE[1]}
              step={1}
              valueText={`n sama dengan ${n}`}
              onChange={(value) => {
                stopAnimation();
                patch({ n: value });
              }}
            />
            <button
              type="button"
              className="sim-text-btn"
              aria-pressed={animating}
              onClick={toggleAnimation}
            >
              {animating ? "Hentikan" : "Animasikan n → 100"}
            </button>
          </SimSection>

          <SimSection title="Hasil">
            <ul className="sim-rows" aria-live="polite">
              <SimRow
                color={colors.curve}
                visible={view.show.curve}
                onToggle={() => toggleShow("curve")}
                toggleLabel="Tampilkan atau sembunyikan kurva"
              >
                <span>{fn.label}</span>
              </SimRow>
              <SimRow
                color={colors.area}
                visible={view.show.rects}
                onToggle={() => toggleShow("rects")}
                toggleLabel="Tampilkan atau sembunyikan persegi panjang Riemann"
              >
                <SimMath tex={`S_{${n}}=${tex(rm.sum, 4)}`} />
              </SimRow>
              <SimRow>
                <span>
                  n = {n}, {methodName}
                </span>
              </SimRow>
              <SimRow color={colors.ink}>
                <SimMath
                  tex={String.raw`\int_{${tex(a, 1)}}^{${tex(b, 1)}} f(x)\,dx=${tex(exact, 4)}`}
                />
              </SimRow>
              <SimRow color={colors.error}>
                <SimMath tex={`S_{${n}}-\\text{eksak}=${tex(error, 4)}`} />
              </SimRow>
              <SimRow>
                <SimMath tex={String.raw`\Delta x=\dfrac{b-a}{n}=${tex(rm.dx, 4)}`} />
              </SimRow>
              <SimRow
                color={colors.point}
                visible={view.show.bounds}
                onToggle={() => toggleShow("bounds")}
                toggleLabel="Tampilkan atau sembunyikan batas a dan b"
              >
                <SimMath tex={`[${tex(a, 1)};\\,${tex(b, 1)}]`} />
              </SimRow>
            </ul>
          </SimSection>
        </>
      }
      notes={
        <>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.area }}>Jumlah Riemann: </strong>
            <SimMath
              tex={String.raw`S_n=\sum_{i=1}^{n} f(x_i^{*})\,\Delta x,\quad \Delta x=\dfrac{b-a}{n}`}
            />
            . Saat n membesar, S<sub>n</sub> menuju integral tentu{" "}
            <SimMath tex={String.raw`\int_a^b f(x)\,dx=F(b)-F(a)`} />.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.point }}>Luas bertanda: </strong>
            bagian grafik di bawah sumbu x menyumbang luas negatif, sehingga
            nilai integral bisa lebih kecil dari luas daerah sebenarnya.
            Coba fungsi <SimMath tex={String.raw`-\dfrac{1}{4}x^{2}+4`} /> dengan a = −6 dan b = 6 untuk
            melihat bagian positif dan negatif saling mengurangi.
          </p>
        </>
      }
    />
  );
}
