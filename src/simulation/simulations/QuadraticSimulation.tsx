import { useEffect, useMemo, useRef } from "react";
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
import { formatText, texNumber } from "../common/utils/simUtils";
import { useJsxBoard, type BoundingBox, type SimBoard } from "../common/hooks/useJsxBoard";
import { useStoredSimulationState } from "../common/hooks/useStoredSimulationState";

/* Simulasi fungsi kuadrat  f(x) = ax² + bx + c
   Kerangka, slider, dan CSS memakai kit umum (prefix sim-). */

type Params = { a: number; b: number; c: number };
type ObjectKey =
  | "curve"
  | "reference"
  | "symmetry"
  | "vertex"
  | "roots"
  | "intercept";
type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean;
  curveWidth: number;
  pointSize: number;
  show: Record<ObjectKey, boolean>;
};

const initialParams: Params = { a: 1, b: -2, c: -3 };
const initialView: ViewState = {
  grid: true,
  axisNumbers: true,
  pointLabels: true,
  curveWidth: 3,
  pointSize: 4,
  show: {
    curve: true,
    reference: true,
    symmetry: true,
    vertex: true,
    roots: true,
    intercept: true,
  },
};
const initialBox: BoundingBox = [-10, 10, 10, -10];

const sliderConfig = [
  { key: "a", min: -5, max: 5, hint: "arah & kelebaran" },
  { key: "b", min: -10, max: 10, hint: "geser sumbu simetri" },
  { key: "c", min: -10, max: 10, hint: "memotong sumbu y" },
] as const;

const colors = {
  a: "#6557d2",
  b: "#e65100",
  c: "#2e7d32",
  curve: "#1565c0",
  reference: "#8f8f99",
  vertex: "#c28a00",
  root: "#c62828",
  grid: "#dcdce2",
  axis: "#4a4a55",
};

type Settable = { setAttribute: (attributes: Record<string, unknown>) => unknown };
type AxisElement = Settable & { defaultTicks: Settable };
type Scene = {
  grid: Settable;
  axes: AxisElement[];
  curve: Settable;
  reference: Settable;
  symmetry: Settable;
  vertex: { point: Settable; label: Settable };
  intercept: { point: Settable; label: Settable };
  roots: { point: Settable; label: Settable }[];
};

const finite = (value: number) => Number.isFinite(value);

function equationTex({ a, b, c }: Params) {
  const parts: string[] = [];
  const push = (coef: number, term: string) => {
    if (coef === 0) return;
    const abs = Math.abs(coef);
    const body = term !== "" && abs === 1 ? term : `${texNumber(abs)}${term}`;
    if (parts.length === 0) parts.push(coef < 0 ? `-${body}` : body);
    else parts.push(`${coef < 0 ? "-" : "+"} ${body}`);
  };
  push(a, "x^{2}");
  push(b, "x");
  push(c, "");
  return parts.length ? parts.join(" ") : "0";
}

export function QuadraticSimulation() {
  const [params, setParams] = useStoredSimulationState(
    "quadratic.params",
    initialParams,
  );
  const [storedView, setStoredView] = useStoredSimulationState(
    "quadratic.view",
    initialView,
  );
  const [parameterStep, setParameterStep] = useStoredSimulationState(
    "quadratic.parameter-step",
    1,
  );
  const view = useMemo<ViewState>(
    () => ({
      ...initialView,
      ...storedView,
      show: { ...initialView.show, ...storedView.show },
    }),
    [storedView],
  );

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const viewRef = useRef(view);
  viewRef.current = view;
  const scene = useRef<Scene | null>(null);

  /* ───────── Papan JSXGraph ───────── */

  const setup = (board: SimBoard) => {
    const p = () => paramsRef.current;
    const f = (x: number) => p().a * x * x + p().b * x + p().c;
    const isQuadratic = () => p().a !== 0;
    const vertexX = () => (isQuadratic() ? -p().b / (2 * p().a) : Number.NaN);
    const vertexY = () => (isQuadratic() ? f(vertexX()) : Number.NaN);
    const rootX = (sign: 1 | -1) => () => {
      const { a, b, c } = p();
      const d = b * b - 4 * a * c;
      if (a === 0 || d < 0) return Number.NaN;
      // Akar kembar hanya digambar sekali.
      if (d === 0 && sign === -1) return Number.NaN;
      return (-b + sign * Math.sqrt(d)) / (2 * a);
    };

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

    // Pembanding y = x²
    const reference = board.create("functiongraph", [(x: number) => x * x], {
      strokeColor: colors.reference,
      strokeWidth: 1.5,
      dash: 3,
      highlight: false,
    }) as unknown as Settable;

    // Sumbu simetri
    const symmetry = board.create(
      "line",
      [
        [() => vertexX(), 0],
        [() => vertexX(), 1],
      ],
      {
        straightFirst: true,
        straightLast: true,
        strokeColor: colors.b,
        strokeWidth: 1.2,
        dash: 2,
        highlight: false,
        fixed: true,
        point1: { visible: false },
        point2: { visible: false },
      },
    ) as unknown as Settable;

    // Kurva utama
    const curve = board.create("functiongraph", [f], {
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
    ) => {
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
              ? `(${formatText(x())}, ${formatText(y())})`
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
      reference,
      symmetry,
      intercept: marker(() => 0, () => p().c, colors.c, 1),
      roots: [
        marker(rootX(1), () => (finite(rootX(1)()) ? 0 : Number.NaN), colors.root, 0),
        marker(rootX(-1), () => (finite(rootX(-1)()) ? 0 : Number.NaN), colors.root, 0),
      ],
      vertex: marker(vertexX, vertexY, colors.vertex, 1),
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

    const thin = Math.max(1, v.curveWidth / 2);
    s.curve.setAttribute({ visible: v.show.curve, strokeWidth: v.curveWidth });
    s.reference.setAttribute({ visible: v.show.reference, strokeWidth: thin });
    s.symmetry.setAttribute({ visible: v.show.symmetry, strokeWidth: thin });

    const apply = (
      item: { point: Settable; label: Settable },
      shown: boolean,
      extra: number,
    ) => {
      item.point.setAttribute({ visible: shown, size: v.pointSize + extra });
      item.label.setAttribute({ visible: shown && v.pointLabels });
    };
    apply(s.vertex, v.show.vertex, 1);
    apply(s.intercept, v.show.intercept, 1);
    s.roots.forEach((root) => apply(root, v.show.roots, 0));

    boardRef.current?.update();
  }

  useEffect(() => {
    applyView();
  }, [view]);

  useEffect(() => {
    boardRef.current?.update();
  }, [params, boardRef]);

  /* ───────── Perubahan dari pengguna ───────── */

  const updateParam = (key: keyof Params, value: number) => {
    const next = { ...paramsRef.current, [key]: value };
    paramsRef.current = next;
    setParams(next);
    boardRef.current?.update();
  };

  const resetParams = () => {
    paramsRef.current = initialParams;
    setParams(initialParams);
    boardRef.current?.update();
  };

  const updateView = (patch: Partial<ViewState>) => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setStoredView(next);
  };

  const toggleShow = (key: ObjectKey) =>
    updateView({ show: { ...viewRef.current.show, [key]: !viewRef.current.show[key] } });

  /* ───────── Nilai turunan ───────── */

  const { a, b, c } = params;
  const isQuadratic = a !== 0;
  const discriminant = b * b - 4 * a * c;
  const vx = isQuadratic ? -b / (2 * a) : null;
  const vy = isQuadratic && vx !== null ? a * vx * vx + b * vx + c : null;
  const equation = equationTex(params);
  const undefinedTex = String.raw`\text{tak terdefinisi}`;

  let rootsTex = undefinedTex;
  if (isQuadratic) {
    const sqrtD = Math.sqrt(Math.max(discriminant, 0));
    if (discriminant > 0) {
      const [lo, hi] = [(-b - sqrtD) / (2 * a), (-b + sqrtD) / (2 * a)].sort(
        (m, n) => m - n,
      );
      rootsTex = String.raw`A(${texNumber(lo)},0),\ B(${texNumber(hi)},0)`;
    } else if (discriminant === 0) {
      rootsTex = String.raw`A(${texNumber(-b / (2 * a))},0)`;
    } else {
      rootsTex = String.raw`\text{tidak ada akar real}`;
    }
  }

  const widthTex =
    Math.abs(a) > 1 ? "lebih sempit" : Math.abs(a) < 1 ? "lebih lebar" : "sama";

  /* ───────── Tampilan ───────── */

  return (
    <SimulationShell
      title="Simulasi fungsi kuadrat"
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
            id="quadratic-curve-width"
            name="tebal kurva"
            label={`Tebal kurva: ${view.curveWidth}`}
            value={view.curveWidth}
            min={1}
            max={8}
            step={1}
            onChange={(curveWidth) => updateView({ curveWidth })}
          />
          <SimSlider
            id="quadratic-point-size"
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
          aria-label="Grafik fungsi kuadrat. Seret untuk menggeser, cubit atau gulir untuk memperbesar."
        />
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          <SimMath tex={`f(x)=${equation}`} />
        </p>
      }
      panel={
        <>
          <SimSection title="Parameter" sticky>
            <p className="sim-hint">Pilih langkah tombol tambah dan kurangi</p>
            <div className="sim-seg" role="radiogroup" aria-label="Besar perubahan parameter">
              {([0.2, 0.5, 1] as const).map((step) => (
                <button
                  key={step}
                  type="button"
                  role="radio"
                  className="sim-seg__btn"
                  aria-checked={parameterStep === step}
                  onClick={() => setParameterStep(step)}
                >
                  ±{step.toLocaleString("en-US")}
                </button>
              ))}
            </div>
            {sliderConfig.map(({ key, min, max, hint }) => (
              <SimSlider
                key={key}
                id={`quadratic-${key}`}
                name={key}
                label={<SimMath tex={`${key}=${texNumber(params[key])}`} />}
                hint={hint}
                accent={colors[key]}
                value={params[key]}
                min={min}
                max={max}
                step={parameterStep}
                valueText={`${key} sama dengan ${params[key]}`}
                onChange={(value) => updateParam(key, value)}
              />
            ))}
          </SimSection>

          <SimSection title="Hasil">
            <ul className="sim-rows" aria-live="polite">
              <SimRow
                color={colors.curve}
                visible={view.show.curve}
                onToggle={() => toggleShow("curve")}
                toggleLabel="Tampilkan atau sembunyikan kurva"
              >
                <SimMath tex={`f(x)=${equation}`} />
              </SimRow>
              <SimRow
                color={colors.reference}
                visible={view.show.reference}
                onToggle={() => toggleShow("reference")}
                toggleLabel="Tampilkan atau sembunyikan kurva pembanding"
              >
                <SimMath tex="g(x)=x^{2}" />
              </SimRow>
              <SimRow
                color={colors.b}
                visible={view.show.symmetry}
                onToggle={() => toggleShow("symmetry")}
                toggleLabel="Tampilkan atau sembunyikan sumbu simetri"
              >
                <SimMath
                  tex={vx === null ? undefinedTex : `x=${texNumber(vx)}`}
                />
              </SimRow>
              <SimRow
                color={colors.vertex}
                visible={view.show.vertex}
                onToggle={() => toggleShow("vertex")}
                toggleLabel="Tampilkan atau sembunyikan titik puncak"
              >
                <SimMath
                  tex={
                    vx === null || vy === null
                      ? undefinedTex
                      : String.raw`P(${texNumber(vx)},${texNumber(vy)})`
                  }
                />
              </SimRow>
              <SimRow
                color={colors.root}
                visible={view.show.roots}
                onToggle={() => toggleShow("roots")}
                toggleLabel="Tampilkan atau sembunyikan titik potong sumbu x"
              >
                <SimMath tex={rootsTex} />
              </SimRow>
              <SimRow
                color={colors.c}
                visible={view.show.intercept}
                onToggle={() => toggleShow("intercept")}
                toggleLabel="Tampilkan atau sembunyikan titik potong sumbu y"
              >
                <SimMath tex={String.raw`C(0,${texNumber(c)})`} />
              </SimRow>
              <SimRow>
                <SimMath
                  tex={
                    isQuadratic
                      ? `D=b^{2}-4ac=${texNumber(discriminant)}`
                      : String.raw`D=\text{—}`
                  }
                />
              </SimRow>
              <SimRow>
                {isQuadratic ? (
                  <span>
                    Terbuka ke {a > 0 ? "atas" : "bawah"} (
                    <SimMath tex={a > 0 ? "a>0" : "a<0"} />)
                  </span>
                ) : (
                  <span>
                    <SimMath tex="a=0" />: grafik berupa garis lurus
                  </span>
                )}
              </SimRow>
            </ul>
          </SimSection>
        </>
      }
      notes={
        <>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.a }}>Pengaruh </strong>
            <SimMath tex="a" />
            {": "}
            {isQuadratic
              ? `a ${a > 0 ? "positif" : "negatif"} membuat parabola terbuka ke ${a > 0 ? "atas" : "bawah"}. Karena |a| = ${formatText(Math.abs(a))}, parabola ${widthTex} dibanding y = x².`
              : "a = 0 membuat grafik berupa garis lurus."}
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.b }}>Pengaruh </strong>
            <SimMath tex="b" />
            {": sumbu simetri berada di "}
            <SimMath
              tex={
                vx === null
                  ? String.raw`x=-\dfrac{b}{2a}`
                  : String.raw`x=-\dfrac{b}{2a}=${texNumber(vx)}`
              }
            />
            . Mengubah b menggeser puncak ke kiri atau kanan sekaligus ke atas
            atau bawah.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.c }}>Pengaruh </strong>
            <SimMath tex="c" />
            {": grafik selalu memotong sumbu y di "}
            <SimMath tex={String.raw`(0,${texNumber(c)})`} />
            . Mengubah c menggeser seluruh parabola secara vertikal.
          </p>
        </>
      }
    />
  );
}
