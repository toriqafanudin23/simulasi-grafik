import {
  Home,
  Maximize2,
  Menu,
  Minimize2,
  Minus,
  Plus,
  RotateCcw,
  Settings,
  Share2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { buildShareUrl } from "../utils/shareState";
import "../styles/simulation.css";

/* Kerangka umum semua simulasi (gaya GeoGebra).
   - Bilah atas : tombol panel, toggle tampilan, atur ulang, pengaturan.
   - Panel kiri : parameter dan hasil (1 bagian) | grafik (2 bagian).
   - Layar penuh: grafik 100%, panel mengambang lewat tombol menu.
   - Layar sentuh: layar penuh otomatis dikunci ke lanskap bila didukung. */

type SimulationShellProps = {
  title: string;
  toggles?: ReactNode;
  settings?: ReactNode;
  onReset?: () => void;
  graph: ReactNode;
  /** Ditampilkan di atas grafik saat panel disembunyikan (mis. persamaan). */
  overlay?: ReactNode;
  panel: ReactNode;
  /** Catatan di bawah simulasi, hanya tampil di layar lebar. */
  notes?: ReactNode;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onHome: () => void;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type LockableOrientation = {
  lock?: (mode: "landscape") => Promise<void>;
  unlock?: () => void;
};

function unlockOrientation() {
  try {
    (screen.orientation as unknown as LockableOrientation)?.unlock?.();
  } catch {
    /* diabaikan */
  }
}

async function lockLandscape() {
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  try {
    await (screen.orientation as unknown as LockableOrientation)?.lock?.(
      "landscape",
    );
  } catch {
    /* iOS dan beberapa browser menolak; banner "putar ponsel" tetap muncul. */
  }
}

export function SimulationShell({
  title,
  toggles,
  settings,
  onReset,
  graph,
  overlay,
  panel,
  notes,
  onZoomIn,
  onZoomOut,
  onHome,
}: SimulationShellProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const nativeFullscreen = useRef(false);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareNote, setShareNote] = useState("");
  const shareTimer = useRef<number | undefined>(undefined);

  /* ───────── Tautan bagikan ───────── */

  const announceShare = (text: string) => {
    setShareNote(text);
    window.clearTimeout(shareTimer.current);
    shareTimer.current = window.setTimeout(() => setShareNote(""), 2500);
  };
  useEffect(() => () => window.clearTimeout(shareTimer.current), []);

  const shareLink = async () => {
    const url = buildShareUrl();
    if (!url) {
      announceShare("Pengaturan terlalu panjang untuk dibagikan");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      announceShare("Tautan disalin");
      return;
    } catch {
      /* clipboard ditolak: coba lembar bagikan bawaan, lalu kotak salin manual */
    }
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
    } catch {
      return; // pengguna membatalkan
    }
    window.prompt("Salin tautan ini:", url);
  };

  /* ───────── Layar penuh + kunci lanskap ───────── */

  const finishExit = () => {
    unlockOrientation();
    nativeFullscreen.current = false;
    setIsFullscreen(false);
    setPanelOpen(true);
    setSettingsOpen(false);
  };

  const enterFullscreen = async () => {
    setPanelOpen(false);
    setSettingsOpen(false);
    setIsFullscreen(true);
    const el = rootRef.current as FullscreenElement | null;
    try {
      if (el?.requestFullscreen) {
        await el.requestFullscreen();
        nativeFullscreen.current = true;
      } else if (el?.webkitRequestFullscreen) {
        await el.webkitRequestFullscreen();
        nativeFullscreen.current = true;
      }
    } catch {
      // Tetap memakai layar penuh CSS.
    }
    await lockLandscape();
  };

  const exitFullscreen = async () => {
    const doc = document as FullscreenDocument;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (doc.webkitFullscreenElement) await doc.webkitExitFullscreen?.();
    } catch {
      /* diabaikan */
    }
    finishExit();
  };

  useEffect(() => {
    const onChange = () => {
      const doc = document as FullscreenDocument;
      if (
        nativeFullscreen.current &&
        !document.fullscreenElement &&
        !doc.webkitFullscreenElement
      ) {
        finishExit();
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
      unlockOrientation();
    };
  }, []);

  // Cegah halaman di belakang ikut bergulir saat layar penuh.
  useEffect(() => {
    if (!isFullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isFullscreen]);

  /* ───────── Popover pengaturan & tombol Esc ───────── */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (settingsOpen) setSettingsOpen(false);
      else if (isFullscreen && !nativeFullscreen.current) finishExit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settingsOpen, isFullscreen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        settingsButtonRef.current?.contains(target)
      ) {
        return;
      }
      setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [settingsOpen]);

  const rootClass = [
    "sim",
    isFullscreen ? "is-fs" : "",
    panelOpen ? "" : "is-panel-closed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={rootRef} className={rootClass} role="region" aria-label={title}>
      <div className="sim-bar" role="toolbar" aria-label="Alat simulasi">
        <button
          type="button"
          className="sim-btn"
          aria-pressed={panelOpen}
          aria-label={panelOpen ? "Sembunyikan panel" : "Tampilkan panel"}
          title={panelOpen ? "Sembunyikan panel" : "Tampilkan panel"}
          onClick={() => setPanelOpen((open) => !open)}
        >
          <Menu size={18} aria-hidden="true" />
        </button>
        {toggles && <span className="sim-bar__sep" aria-hidden="true" />}
        {toggles}
        <span className="sim-bar__spacer" />
        {onReset && (
          <button
            type="button"
            className="sim-btn"
            aria-label="Atur ulang parameter"
            title="Atur ulang parameter"
            onClick={onReset}
          >
            <RotateCcw size={17} aria-hidden="true" />
            <span className="sim-btn__label">Atur ulang</span>
          </button>
        )}
        <button
          type="button"
          className="sim-btn"
          aria-label="Bagikan simulasi dengan pengaturan saat ini"
          title="Salin tautan dengan pengaturan saat ini"
          onClick={shareLink}
        >
          <Share2 size={17} aria-hidden="true" />
          <span className="sim-btn__label">Bagikan</span>
        </button>
        {settings && (
          <button
            ref={settingsButtonRef}
            type="button"
            className="sim-btn"
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            aria-label="Pengaturan tampilan"
            title="Pengaturan tampilan"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings size={18} aria-hidden="true" />
          </button>
        )}
      </div>

      <span className="sim-share-note" role="status" aria-live="polite">
        {shareNote}
      </span>

      {settingsOpen && settings && (
        <div
          ref={popoverRef}
          className="sim-popover"
          role="dialog"
          aria-label="Pengaturan tampilan"
        >
          {settings}
        </div>
      )}

      <p className="sim-rotate" role="status">
        Untuk tampilan terbaik, tekan tombol layar penuh atau miringkan ponsel
        ke mode lanskap.
      </p>

      <div className="sim-main">
        <aside className="sim-panel" aria-label="Panel parameter dan hasil">
          {panel}
        </aside>

        <section className="sim-stage" aria-label="Grafik">
          {graph}
          {!panelOpen && overlay}
          <div className="sim-fabs" role="group" aria-label="Tampilan grafik">
            <button
              type="button"
              className="sim-fab"
              aria-pressed={isFullscreen}
              aria-label={isFullscreen ? "Keluar layar penuh" : "Layar penuh"}
              title={isFullscreen ? "Keluar layar penuh" : "Layar penuh"}
              onClick={isFullscreen ? exitFullscreen : enterFullscreen}
            >
              {isFullscreen ? (
                <Minimize2 size={16} aria-hidden="true" />
              ) : (
                <Maximize2 size={16} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="sim-fab"
              aria-label="Pusatkan tampilan"
              title="Pusatkan tampilan"
              onClick={onHome}
            >
              <Home size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="sim-fab"
              aria-label="Perbesar"
              title="Perbesar"
              onClick={onZoomIn}
            >
              <Plus size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="sim-fab"
              aria-label="Perkecil"
              title="Perkecil"
              onClick={onZoomOut}
            >
              <Minus size={17} aria-hidden="true" />
            </button>
          </div>
        </section>
      </div>

      {notes && <div className="sim-notes">{notes}</div>}
    </div>
  );
}
