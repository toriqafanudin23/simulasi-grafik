import { Minus, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { clamp, snap } from "../utils/simUtils";

/* Komponen kontrol umum. Semua gaya ada di simulation.css (prefix sim-). */

type AccentStyle = CSSProperties & { "--sim-accent"?: string; "--sim-fill"?: string };

/* ───────── Ikon bawaan (SVG sendiri agar tidak bergantung versi lucide) ───────── */

const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function GridIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 3h18v18H3z M9 3v18 M15 3v18 M3 9h18 M3 15h18" />
    </svg>
  );
}

export function AxisNumbersIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 12h18 M12 3v18 M7 10v4 M17 10v4 M10 7h4 M10 17h4" />
    </svg>
  );
}

export function PointLabelIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="6" cy="17" r="2.2" fill="currentColor" stroke="none" />
      <path d="M11 6h9 M11 10h6" />
    </svg>
  );
}

/* ───────── Tombol toggle di bilah atas ───────── */

type SimToggleProps = {
  icon: ReactNode;
  label: string;
  pressed: boolean;
  onClick: () => void;
};

export function SimToggle({ icon, label, pressed, onClick }: SimToggleProps) {
  return (
    <button
      type="button"
      className="sim-btn"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {icon}
      <span className="sim-btn__label">{label}</span>
    </button>
  );
}

/* ───────── Seksi panel ───────── */

type SimSectionProps = {
  title: string;
  sticky?: boolean;
  children: ReactNode;
};

export function SimSection({ title, sticky = false, children }: SimSectionProps) {
  return (
    <section className={`sim-section${sticky ? " sim-section--sticky" : ""}`}>
      <h3 className="sim-section__title">{title}</h3>
      {children}
    </section>
  );
}

/* ───────── Baris aljabar (titik warna = tampil/sembunyi, seperti GeoGebra) ───────── */

type SimRowProps = {
  color?: string;
  /** Bila diisi, titik warna menjadi tombol tampil/sembunyi. */
  visible?: boolean;
  onToggle?: () => void;
  toggleLabel?: string;
  children: ReactNode;
};

export function SimRow({
  color,
  visible = true,
  onToggle,
  toggleLabel,
  children,
}: SimRowProps) {
  const style: AccentStyle = color ? { "--sim-accent": color } : {};
  return (
    <li className="sim-row" style={style}>
      {onToggle ? (
        <button
          type="button"
          className="sim-dot"
          aria-pressed={visible}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggle}
        >
          <span />
        </button>
      ) : (
        <span className="sim-dot sim-dot--empty" aria-hidden="true" />
      )}
      <div className="sim-row__body">{children}</div>
    </li>
  );
}

/* ───────── Slider dengan tombol − / + (tahan untuk mengulang) ───────── */

type SimSliderProps = {
  id: string;
  /** Nama untuk pembaca layar, mis. "a" atau "tebal kurva". */
  name: string;
  label: ReactNode;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  accent?: string;
  valueText?: string;
  onChange: (value: number) => void;
};

export function SimSlider({
  id,
  name,
  label,
  hint,
  value,
  min,
  max,
  step = 0.1,
  accent,
  valueText,
  onChange,
}: SimSliderProps) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const timers = useRef<{ delay?: number; repeat?: number }>({});

  const stop = useCallback(() => {
    window.clearTimeout(timers.current.delay);
    window.clearInterval(timers.current.repeat);
    timers.current = {};
  }, []);

  useEffect(() => {
    // Tombol yang menjadi disabled di batas tidak mengirim pointerup.
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      stop();
    };
  }, [stop]);

  const nudge = (direction: 1 | -1) => {
    const next = clamp(snap(valueRef.current + direction * step, step), min, max);
    valueRef.current = next;
    onChangeRef.current(next);
  };

  const start =
    (direction: 1 | -1) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      stop();
      nudge(direction);
      timers.current.delay = window.setTimeout(() => {
        timers.current.repeat = window.setInterval(() => nudge(direction), 60);
      }, 400);
    };

  const stepProps = (direction: 1 | -1, atLimit: boolean) => ({
    type: "button" as const,
    className: "sim-step",
    disabled: atLimit,
    "aria-label": `${direction === 1 ? "Tambah" : "Kurangi"} ${name}`,
    onPointerDown: start(direction),
    onPointerLeave: stop,
    onBlur: stop,
    onContextMenu: (event: { preventDefault: () => void }) =>
      event.preventDefault(),
    // detail === 0 → aktivasi lewat keyboard (Enter/Spasi)
    onClick: (event: { detail: number }) => {
      if (event.detail === 0) nudge(direction);
    },
  });

  const style: AccentStyle = {
    "--sim-fill": `${((value - min) / (max - min)) * 100}%`,
  };
  if (accent) style["--sim-accent"] = accent;

  return (
    <div className="sim-slider" style={style}>
      <label className="sim-slider__label" htmlFor={id}>
        {label}
        {hint && <small className="sim-slider__hint">{hint}</small>}
      </label>
      <button {...stepProps(-1, value <= min)}>
        <Minus size={13} aria-hidden="true" />
      </button>
      <input
        id={id}
        className="sim-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueText ?? `${name} sama dengan ${value}`}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <button {...stepProps(1, value >= max)}>
        <Plus size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
