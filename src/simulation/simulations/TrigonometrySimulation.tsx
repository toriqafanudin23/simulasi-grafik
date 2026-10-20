import JXG from "jsxgraph";
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
import { formatText, texNumber } from "../common/utils/simUtils";
import { useJsxBoard, type BoundingBox, type SimBoard } from "../common/hooks/useJsxBoard";
import { useStoredSimulationState } from "../common/hooks/useStoredSimulationState";

/* Simulasi trigonometri: lingkaran satuan (kiri) dan grafik sin, cos, tan
   (kanan) dalam SATU papan, dihubungkan garis putus-putus. Kerangka, slider,
   dan CSS memakai kit umum (prefix sim-); tidak ada CSS khusus. */

/* ───────── Tipe & konstanta ───────── */

type FnKey = "sin" | "cos" | "tan";
type ViewState = {
  grid: boolean;
  axisNumbers: boolean;
  pointLabels: boolean; // tampilkan koordinat (cos θ; sin θ) di titik P
  curveWidth: number;
  pointSize: number;
  show: Record<FnKey, boolean>;
};

const FN_KEYS: FnKey[] = ["sin", "cos", "tan"];
const initialAngle = 45;
const TAU = Math.PI * 2;
const CX = -2; // pusat lingkaran satuan di papan
const TAN_CLIP = 6; // |tan| lebih besar dari ini tidak digambar

/* Tampilan awal: lingkaran di kiri, gelombang 0…2π di kanan. */
const initialBox: BoundingBox = [-3.7, 2.6, 7.0, -2.6];

const initialView: ViewState = {
  grid: false,
  axisNumbers: true,
  pointLabels: true,
  curveWidth: 3,
  pointSize: 4,
  show: { sin: true, cos: true, tan: true },
};

const specialAngles = [
  0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330,
];

const colors = {
  sin: "#e65100",
  cos: "#1565c0",
  tan: "#2e7d32",
  theta: "#6557d2",
  guide: "#8f8f99",
  ink: "#232329",
  grid: "#dcdce2",
  axis: "#4a4a55",
};

/* ───────── Matematika & format ───────── */

const normalizeDegrees = (value: number) => ((Math.round(value) % 360) + 360) % 360;
const toRad = (deg: number) => (deg * Math.PI) / 180;

const sanitizeAngle = (raw: unknown) =>
  typeof raw === "number" && Number.isFinite(raw) ? normalizeDegrees(raw) : initialAngle;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Sudut dalam radian sebagai TeX, mis. \dfrac{3\pi}{4}. */
function radiansTex(deg: number) {
  if (deg === 0) return "0";
  const d = gcd(deg, 180);
  const num = deg / d;
  const den = 180 / d;
  const coef = num === 1 ? "" : String(num);
  return den === 1 ? `${coef}\\pi` : `\\dfrac{${coef}\\pi}{${den}}`;
}

const sinBase: Record<number, string> = {
  0: "0",
  30: String.raw`\tfrac{1}{2}`,
  45: String.raw`\tfrac{1}{2}\sqrt{2}`,
  60: String.raw`\tfrac{1}{2}\sqrt{3}`,
  90: "1",
};

const tanBase: Record<number, string> = {
  0: "0",
  30: String.raw`\tfrac{1}{3}\sqrt{3}`,
  45: "1",
  60: String.raw`\sqrt{3}`,
};

/** Nilai eksak sin untuk kelipatan 30° dan 45°; null bila bukan sudut istimewa. */
function exactSin(deg: number): string | null {
  const d = (((deg % 360) + 360) % 360);
  if (d % 30 !== 0 && d % 45 !== 0) return null;
  const m = d % 180;
  const ref = m > 90 ? 180 - m : m;
  const base = sinBase[ref];
  if (base === undefined) return null;
  if (base === "0") return "0";
  return d > 180 ? `-${base}` : base;
}

const exactCos = (deg: number) => exactSin(deg + 90);

/** Nilai eksak tan; "undefined" untuk 90° dan 270°. */
function exactTan(deg: number): string | null {
  const d = (((deg % 360) + 360) % 360);
  if (d % 30 !== 0 && d % 45 !== 0) return null;
  const m = d % 180;
  if (m === 90) return "undefined";
  const ref = m > 90 ? 180 - m : m;
  const base = tanBase[ref];
  if (base === undefined) return null;
  if (base === "0") return "0";
  return m > 90 ? `-${base}` : base;
}

function quadrantInfo(deg: number) {
  if (deg % 90 === 0) {
    const axis = ["sumbu x positif", "sumbu y positif", "sumbu x negatif", "sumbu y negatif"][
      deg / 90
    ];
    return { text: `Berada pada ${axis}`, ref: 0 };
  }
  const q = Math.floor(deg / 90);
  const ref = q === 0 ? deg : q === 1 ? 180 - deg : q === 2 ? deg - 180 : 360 - deg;
  const name = ["I", "II", "III", "IV"][q];
  const signs = [
    "sin +, cos +, tan +",
    "sin +, cos −, tan −",
    "sin −, cos −, tan +",
    "sin −, cos +, tan −",
  ][q];
  return { text: `Kuadran ${name} (${signs}) · sudut referensi ${ref}°`, ref };
}

/** Baris "f θ = nilai eksak ≈ desimal" dalam TeX. */
function valueTex(name: string, exact: string | null, value: number | null) {
  const head = `\\${name}\\,\\theta`;
  if (exact === "undefined" || value === null) return `${head}=\\text{tak terdefinisi}`;
  const approx = texNumber(value);
  if (!exact) return `${head}=${approx}`;
  const trivial = exact === "0" || exact === "1" || exact === "-1";
  return trivial ? `${head}=${exact}` : `${head}=${exact}\\approx ${approx}`;
}

/* ───────── Tipe elemen JSXGraph ───────── */

type Settable = { setAttribute: (attributes: Record<string, unknown>) => unknown };
type Evented = { on: (event: string, handler: () => void) => unknown };
type PointEl = Settable &
  Evented & {
    X: () => number;
    Y: () => number;
    setPosition: (method: number, coords: number[]) => unknown;
  };
type DataCurve = Settable & {
  dataX: number[];
  dataY: number[];
  updateDataArray: () => void;
};
type Scene = {
  grid: Settable;
  numbers: Settable[];
  curves: Record<FnKey, Settable>;
  dots: Record<FnKey, Settable>;
  sinLink: Settable;
  sinSeg: Settable;
  cosSeg: Settable;
  tanSeg: Settable;
  tanRay: Settable;
  radius: Settable;
  arc: Settable;
  handle: PointEl;
  handleLabel: Settable;
};

/* ───────── Komponen utama ───────── */

export function TrigonometrySimulation() {
  const [stored, setStored] = useStoredSimulationState("trigonometry.v3", initialAngle);
  const [storedView, setStoredView] = useStoredSimulationState("trigonometry.view", initialView);

  const angle = sanitizeAngle(stored);
  const view = useMemo<ViewState>(
    () => ({
      ...initialView,
      ...storedView,
      show: { ...initialView.show, ...storedView.show },
    }),
    [storedView],
  );

  const angleRef = useRef(angle);
  angleRef.current = angle;
  const viewRef = useRef(view);
  viewRef.current = view;
  const scene = useRef<Scene | null>(null);

  const [angleText, setAngleText] = useState(String(angle));
  const angleFocused = useRef(false);

  /* ───────── Papan JSXGraph ───────── */

  const setup = (board: SimBoard) => {
    const v = viewRef.current;
    const rad = () => toRad(angleRef.current);
    const px = () => CX + Math.cos(rad());
    const py = () => Math.sin(rad());
    const tanVal = (x: number) => {
      const t = Math.tan(x);
      return Math.abs(Math.cos(x)) < 0.02 || Math.abs(t) > TAN_CLIP ? Number.NaN : t;
    };

    const grid = board.create("grid", [], {
      strokeColor: colors.grid,
      strokeOpacity: 1,
      strokeWidth: 1,
      highlight: false,
    }) as unknown as Settable;

    /* Sumbu dan garis bantu */
    const axisLine = (p1: [number, number], p2: [number, number]) =>
      board.create("line", [p1, p2], {
        straightFirst: true,
        straightLast: true,
        strokeColor: colors.axis,
        strokeWidth: 1.2,
        highlight: false,
        fixed: true,
        point1: { visible: false },
        point2: { visible: false },
      });
    axisLine([0, 0], [1, 0]); // sumbu mendatar (lingkaran dan gelombang)
    axisLine([CX, 0], [CX, 1]); // sumbu tegak lingkaran
    axisLine([0, 0], [0, 1]); // sumbu tegak gelombang

    const numbers: Settable[] = [];
    const numberText = (x: number, y: number, text: string, anchorX: string, anchorY: string) =>
      numbers.push(
        board.create("text", [x, y, text], {
          anchorX,
          anchorY,
          fontSize: 10,
          strokeColor: "#5c5c68",
          fixed: true,
          highlight: false,
          visible: v.axisNumbers,
        }) as unknown as Settable,
      );

    ([1, -1] as const).forEach((y) => {
      board.create(
        "segment",
        [
          [0, y],
          [TAU, y],
        ],
        {
          strokeColor: colors.guide,
          strokeOpacity: 0.55,
          strokeWidth: 1,
          dash: 2,
          highlight: false,
          fixed: true,
          point1: { visible: false },
          point2: { visible: false },
        },
      );
      numberText(-0.12, y, y === 1 ? "1" : "−1", "right", "middle");
    });

    const tickLabels: [number, string][] = [
      [Math.PI / 2, "π/2"],
      [Math.PI, "π"],
      [1.5 * Math.PI, "3π/2"],
      [TAU, "2π"],
    ];
    tickLabels.forEach(([x, text]) => {
      numbers.push(
        board.create("point", [x, 0], {
          name: "",
          withLabel: false,
          size: 1.5,
          fillColor: colors.axis,
          strokeColor: colors.axis,
          fixed: true,
          highlight: false,
          showInfobox: false,
          visible: v.axisNumbers,
        }) as unknown as Settable,
      );
      numberText(x, -0.14, text, "middle", "top");
    });
    numberText(CX + 1.08, -0.04, "1", "left", "top");
    numberText(CX - 1.08, -0.04, "−1", "right", "top");

    /* Lingkaran satuan */
    const unitCircle = board.create(
      "circle",
      [
        [CX, 0],
        1,
      ],
      {
        strokeColor: colors.guide,
        strokeWidth: 1.5,
        fillColor: "#e2e2ea",
        fillOpacity: 0.35,
        fixed: true,
        highlight: false,
      },
    );

    /* Kurva dari daftar titik; null / NaN = disembunyikan */
    const dataCurve = (build: () => [number, number][] | null, attrs: Record<string, unknown>) => {
      const curve = board.create("curve", [[0], [0]], {
        highlight: false,
        fixed: true,
        ...attrs,
      }) as unknown as DataCurve;
      curve.updateDataArray = () => {
        const pts = build();
        if (!pts || pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
          curve.dataX = [Number.NaN];
          curve.dataY = [Number.NaN];
          return;
        }
        curve.dataX = pts.map((p) => p[0]);
        curve.dataY = pts.map((p) => p[1]);
      };
      return curve as Settable;
    };

    /* Busur sudut θ */
    const arc = dataCurve(
      () => {
        const r = rad();
        if (r <= 0) return null;
        const steps = Math.max(2, Math.ceil(r / 0.1));
        const pts: [number, number][] = [];
        for (let i = 0; i <= steps; i += 1) {
          const t = (r * i) / steps;
          pts.push([CX + 0.32 * Math.cos(t), 0.32 * Math.sin(t)]);
        }
        return pts;
      },
      { strokeColor: colors.theta, strokeWidth: 2 },
    );

    /* Grafik gelombang 0…2π */
    const curve = (fn: (x: number) => number, stroke: string) =>
      board.create("functiongraph", [fn, 0, TAU], {
        strokeColor: stroke,
        strokeWidth: v.curveWidth,
        highlight: false,
      }) as unknown as Settable;
    const curves: Record<FnKey, Settable> = {
      sin: curve(Math.sin, colors.sin),
      cos: curve(Math.cos, colors.cos),
      tan: curve(tanVal, colors.tan),
    };

    // garis sudut θ pada gelombang
    board.create(
      "line",
      [
        [() => rad(), 0],
        [() => rad(), 1],
      ],
      {
        straightFirst: true,
        straightLast: true,
        strokeColor: colors.guide,
        strokeWidth: 1,
        dash: 2,
        highlight: false,
        fixed: true,
        point1: { visible: false },
        point2: { visible: false },
      },
    );

    // penghubung nilai sin θ: dari titik di lingkaran ke gelombang
    const sinLink = board.create(
      "segment",
      [
        [px, py],
        [() => rad(), py],
      ],
      {
        strokeColor: colors.sin,
        strokeWidth: 1.25,
        dash: 2,
        highlight: false,
        fixed: true,
        point1: { visible: false },
        point2: { visible: false },
      },
    ) as unknown as Settable;

    // segmen di lingkaran: jari-jari, sin θ (tegak), cos θ (mendatar), tan θ
    const segment = (
      p1: [number | (() => number), number | (() => number)],
      p2: [number | (() => number), number | (() => number)],
      stroke: string,
      width: number,
    ) =>
      board.create("segment", [p1, p2], {
        strokeColor: stroke,
        strokeWidth: width,
        highlight: false,
        fixed: true,
        point1: { visible: false },
        point2: { visible: false },
      }) as unknown as Settable;
    const radius = segment([CX, 0], [px, py], colors.ink, 2);
    const sinSeg = segment([px, py], [px, 0], colors.sin, v.curveWidth);
    const cosSeg = segment([CX, 0], [px, 0], colors.cos, v.curveWidth);

    const tanSeg = dataCurve(
      () => {
        const t = tanVal(rad());
        return Number.isNaN(t)
          ? null
          : [
              [CX + 1, 0],
              [CX + 1, t],
            ];
      },
      { strokeColor: colors.tan, strokeWidth: v.curveWidth },
    );
    const tanRay = dataCurve(
      () => {
        const t = tanVal(rad());
        return Number.isNaN(t)
          ? null
          : [
              [px(), py()],
              [CX + 1, t],
            ];
      },
      { strokeColor: colors.tan, strokeWidth: 1.25, dash: 2 },
    );

    // titik nilai pada gelombang
    const dot = (fn: (x: number) => number, fill: string) =>
      board.create("point", [() => rad(), () => fn(rad())], {
        name: "",
        withLabel: false,
        size: v.pointSize,
        fillColor: fill,
        strokeColor: "#ffffff",
        strokeWidth: 1.5,
        fixed: true,
        highlight: false,
        showInfobox: false,
      }) as unknown as Settable;
    const dots: Record<FnKey, Settable> = {
      sin: dot(Math.sin, colors.sin),
      cos: dot(Math.cos, colors.cos),
      tan: dot(tanVal, colors.tan),
    };

    /* Titik yang diseret pada lingkaran + label koordinat */
    const handle = board.create("glider", [px(), py(), unitCircle], {
      name: "",
      withLabel: false,
      size: v.pointSize + 3,
      fillColor: colors.theta,
      strokeColor: "#ffffff",
      strokeWidth: 2,
      showInfobox: false,
      highlight: false,
      snapToGrid: false,
    }) as unknown as PointEl;
    handle.on("drag", () => {
      const deg = (Math.atan2(handle.Y(), handle.X() - CX) * 180) / Math.PI;
      const next = normalizeDegrees(deg);
      angleRef.current = next;
      setStored(next);
      board.update();
    });

    const handleLabel = board.create(
      "text",
      [
        () => px() + 10 / board.unitX,
        () => py() + 8 / board.unitY,
        () =>
          `P(${formatText(Math.cos(rad()))}, ${formatText(Math.sin(rad()))})`,
      ],
      {
        anchorX: "left",
        anchorY: "bottom",
        fontSize: 12,
        strokeColor: colors.theta,
        highlight: false,
        fixed: true,
        cssStyle:
          "font-weight:600;white-space:nowrap;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;",
      },
    ) as unknown as Settable;

    // huruf θ di samping busur
    board.create(
      "text",
      [
        () => CX + 0.52 * Math.cos(rad() / 2),
        () => 0.52 * Math.sin(rad() / 2),
        () => (angleRef.current >= 8 ? "θ" : ""),
      ],
      {
        anchorX: "middle",
        anchorY: "middle",
        fontSize: 13,
        strokeColor: colors.theta,
        highlight: false,
        fixed: true,
      },
    );

    scene.current = {
      grid,
      numbers,
      curves,
      dots,
      sinLink,
      sinSeg,
      cosSeg,
      tanSeg,
      tanRay,
      radius,
      arc,
      handle,
      handleLabel,
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
    s.numbers.forEach((item) => item.setAttribute({ visible: v.axisNumbers }));

    s.curves.sin.setAttribute({ visible: v.show.sin, strokeWidth: v.curveWidth });
    s.curves.cos.setAttribute({ visible: v.show.cos, strokeWidth: v.curveWidth });
    s.curves.tan.setAttribute({
      visible: v.show.tan,
      strokeWidth: Math.max(1, v.curveWidth - 0.5),
    });
    FN_KEYS.forEach((key) =>
      s.dots[key].setAttribute({ visible: v.show[key], size: v.pointSize }),
    );

    s.sinLink.setAttribute({ visible: v.show.sin });
    s.sinSeg.setAttribute({ visible: v.show.sin, strokeWidth: v.curveWidth });
    s.cosSeg.setAttribute({ visible: v.show.cos, strokeWidth: v.curveWidth });
    s.tanSeg.setAttribute({ visible: v.show.tan, strokeWidth: v.curveWidth });
    s.tanRay.setAttribute({ visible: v.show.tan });

    s.handle.setAttribute({ size: v.pointSize + 3 });
    s.handleLabel.setAttribute({ visible: v.pointLabels });

    boardRef.current?.update();
  }

  useEffect(() => {
    applyView();
  }, [view]);

  useEffect(() => {
    boardRef.current?.update();
  }, [angle, boardRef]);

  /* ───────── Perubahan dari pengguna ───────── */

  const updateAngle = (value: number) => {
    const next = normalizeDegrees(value);
    angleRef.current = next;
    setStored(next);
    const r = toRad(next);
    scene.current?.handle.setPosition(JXG.COORDS_BY_USER, [CX + Math.cos(r), Math.sin(r)]);
    boardRef.current?.update();
  };

  const updateView = (patch: Partial<ViewState>) => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setStoredView(next);
  };

  const toggleShow = (key: FnKey) =>
    updateView({ show: { ...viewRef.current.show, [key]: !viewRef.current.show[key] } });

  const resetAll = () => {
    updateAngle(initialAngle);
    resetView();
  };

  const changeAngleText = (text: string) => {
    setAngleText(text);
    const cleaned = text.trim().replace("°", "");
    if (/^\d{1,3}$/.test(cleaned)) updateAngle(Number(cleaned));
  };

  // Kolom angka mengikuti sudut yang berubah dari slider atau lingkaran.
  useEffect(() => {
    if (!angleFocused.current) setAngleText(String(angle));
  }, [angle]);

  /* ───────── Nilai turunan ───────── */

  const radians = toRad(angle);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const tanDefined = Math.abs(cosine) > 0.0005;
  const tangent = tanDefined ? Math.tan(radians) : null;
  const quadrant = quadrantInfo(angle);

  const thetaTex = String.raw`\theta=${angle}^{\circ}=${radiansTex(angle)}\ \text{rad}`;
  const num = (value: number) => (value < 0 ? `(${texNumber(value)})` : texNumber(value));

  /* ───────── Tampilan ───────── */

  return (
    <SimulationShell
      title="Simulasi trigonometri"
      onReset={resetAll}
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
            id="trigonometry-curve-width"
            name="tebal kurva"
            label={`Tebal kurva: ${view.curveWidth}`}
            value={view.curveWidth}
            min={1}
            max={8}
            step={1}
            onChange={(curveWidth) => updateView({ curveWidth })}
          />
          <SimSlider
            id="trigonometry-point-size"
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
          aria-label="Lingkaran satuan di kiri dan grafik sinus, kosinus, tangen di kanan. Seret titik ungu pada lingkaran untuk mengubah sudut. Seret area kosong untuk menggeser, cubit atau gulir untuk memperbesar."
        />
      }
      overlay={
        <p className="sim-overlay" aria-live="polite">
          <SimMath tex={thetaTex} />
        </p>
      }
      panel={
        <>
          <SimSection title="Sudut" sticky>
            <SimSlider
              id="trigonometry-angle"
              name="sudut theta"
              label={<SimMath tex={String.raw`\theta=${angle}^{\circ}`} />}
              hint="derajat"
              value={angle}
              min={0}
              max={359}
              step={1}
              valueText={`${angle} derajat`}
              onChange={updateAngle}
            />
            <div className="sim-slot">
              <label htmlFor="trigonometry-angle-input" className="sim-muted">
                Ketik sudut (°)
              </label>
              <input
                id="trigonometry-angle-input"
                className="sim-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                enterKeyHint="done"
                aria-label="Sudut dalam derajat (0 sampai 359)"
                value={angleText}
                onChange={(event) => changeAngleText(event.currentTarget.value)}
                onFocus={(event) => {
                  angleFocused.current = true;
                  event.currentTarget.select();
                }}
                onBlur={() => {
                  angleFocused.current = false;
                  setAngleText(String(angle));
                }}
              />
            </div>
          </SimSection>

          <SimSection title="Sudut istimewa">
            <div className="sim-chips" role="group" aria-label="Sudut istimewa">
              {specialAngles.map((special) => (
                <button
                  key={special}
                  type="button"
                  className="sim-chip"
                  aria-pressed={angle === special}
                  onClick={() => updateAngle(special)}
                >
                  {special}°
                </button>
              ))}
            </div>
          </SimSection>

          <SimSection title="Hasil">
            <ul className="sim-rows" aria-live="polite">
              <SimRow color={colors.theta}>
                <SimMath tex={thetaTex} />
              </SimRow>
              <SimRow
                color={colors.sin}
                visible={view.show.sin}
                onToggle={() => toggleShow("sin")}
                toggleLabel="Tampilkan atau sembunyikan grafik sinus"
              >
                <SimMath tex={valueTex("sin", exactSin(angle), sine)} />
              </SimRow>
              <SimRow
                color={colors.cos}
                visible={view.show.cos}
                onToggle={() => toggleShow("cos")}
                toggleLabel="Tampilkan atau sembunyikan grafik kosinus"
              >
                <SimMath tex={valueTex("cos", exactCos(angle), cosine)} />
              </SimRow>
              <SimRow
                color={colors.tan}
                visible={view.show.tan}
                onToggle={() => toggleShow("tan")}
                toggleLabel="Tampilkan atau sembunyikan grafik tangen"
              >
                <SimMath tex={valueTex("tan", exactTan(angle), tangent)} />
              </SimRow>
              <SimRow>
                <SimMath
                  tex={String.raw`P(\cos\theta,\sin\theta)=(${texNumber(cosine)},${texNumber(sine)})`}
                />
              </SimRow>
            </ul>
            <p className="sim-callout" role="status">
              {quadrant.text}
            </p>
          </SimSection>
        </>
      }
      notes={
        <>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.theta }}>Lingkaran satuan</strong>
            {": titik "}
            <SimMath tex={String.raw`P(\cos\theta,\sin\theta)`} />
            {" berada pada lingkaran berjari-jari 1, sehingga "}
            <SimMath
              tex={String.raw`\sin^{2}\theta+\cos^{2}\theta=${num(sine)}^{2}+${num(cosine)}^{2}=1`}
            />
            {"."}
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.sin }}>Sinus</strong>
            {" adalah tinggi titik P (ordinat), "}
            <strong style={{ color: colors.cos }}>kosinus</strong>
            {" adalah posisi mendatarnya (absis). Garis putus-putus memindahkan nilai sinus ke grafik gelombang di kanan."}
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: colors.tan }}>Tangen</strong>
            {": "}
            <SimMath tex={String.raw`\tan\theta=\dfrac{\sin\theta}{\cos\theta}`} />
            {" sama dengan panjang ruas hijau pada garis singgung "}
            <SimMath tex="x=1" />
            {". Saat "}
            <SimMath tex={String.raw`\cos\theta=0`} />
            {" (90° dan 270°) tangen tidak terdefinisi, sehingga grafiknya putus."}
          </p>
        </>
      }
    />
  );
}

export default TrigonometrySimulation;
