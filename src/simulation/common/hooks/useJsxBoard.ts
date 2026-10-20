import JXG from "jsxgraph";
import { useCallback, useEffect, useId, useRef } from "react";
import "../../../styles/jsxgraph.css";

export type SimBoard = ReturnType<typeof JXG.JSXGraph.initBoard>;
export type BoundingBox = [number, number, number, number];

type Options = {
  boundingBox: BoundingBox;
  /** Dipanggil sekali saat papan dibuat. Buat semua elemen grafik di sini. */
  setup: (board: SimBoard) => void;
  /** Batas zoom relatif terhadap tampilan awal. Bawaan [0.25, 8]. */
  zoomRange?: [number, number];
  /** Kunci rasio sumbu 1 : 1 saat papan dibuat. Bawaan true. */
  keepAspectRatio?: boolean;
};

/** Bagian internal JSXGraph yang perlu disentuh saat ukuran kontainer berubah. */
type BoardInternals = {
  canvasWidth: number;
  canvasHeight: number;
  keepaspectratio?: boolean;
  renderer?: { resize?: (width: number, height: number) => void };
  fullUpdate?: () => unknown;
};

/**
 * Hook papan JSXGraph untuk semua simulasi.
 * - Sebar `boardProps` ke <div> papan.
 * - Saat ukuran kontainer berubah (putar layar, layar penuh), skala dan titik
 *   tengah dipertahankan sehingga grafik tidak melompat, dan seluruh kanvas
 *   (termasuk grid dan sumbu) diperluas sampai tepi kontainer.
 */
export function useJsxBoard({
  boundingBox,
  setup,
  zoomRange = [0.25, 8],
  keepAspectRatio = true,
}: Options) {
  const reactId = useId().replace(/:/g, "");
  const boardId = `sim-board-${reactId}`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const boardRef = useRef<SimBoard | null>(null);
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const boxRef = useRef(boundingBox);
  const zoomRef = useRef(zoomRange);
  const aspectRef = useRef(keepAspectRatio);

  useEffect(() => {
    const board = JXG.JSXGraph.initBoard(boardId, {
      boundingbox: boxRef.current,
      axis: false,
      showCopyright: false,
      showNavigation: false,
      keepAspectRatio: aspectRef.current,
      // Perubahan ukuran ditangani sepenuhnya oleh ResizeObserver di bawah.
      // Pendengar bawaan JSXGraph (throttle) ikut mengubah kanvas dan kotak
      // batas secara terpisah sehingga bisa meninggalkan sisa area kosong.
      resize: { enabled: false, throttle: 100 },
      pan: { enabled: true, needShift: false, needTwoFingers: false },
      zoom: {
        wheel: true,
        needShift: false,
        factorX: 1.15,
        factorY: 1.15,
        min: zoomRef.current[0],
        max: zoomRef.current[1],
      },
    });
    boardRef.current = board;
    setupRef.current(board);

    const internals = board as unknown as BoardInternals;
    let last = {
      w: containerRef.current?.clientWidth ?? 0,
      h: containerRef.current?.clientHeight ?? 0,
    };

    /** Samakan kanvas dengan ukuran kontainer saat ini. */
    const sync = () => {
      const el = containerRef.current;
      if (!el || el.clientWidth <= 0 || el.clientHeight <= 0) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (
        w === last.w &&
        h === last.h &&
        w === internals.canvasWidth &&
        h === internals.canvasHeight
      ) {
        return;
      }

      const bb = board.getBoundingBox();
      const spanX = bb[2] - bb[0];
      const spanY = bb[1] - bb[3];
      // Skala (piksel per satuan) sebelum ukuran berubah.
      const ux = last.w > 0 && spanX > 0 ? last.w / spanX : 0;
      const uy = last.h > 0 && spanY > 0 ? last.h / spanY : 0;

      board.resizeContainer(w, h, true, true);
      // Jangan bergantung pada arti parameter resizeContainer: pastikan ukuran
      // kanvas internal dan elemen SVG sama dengan kontainer.
      internals.canvasWidth = w;
      internals.canvasHeight = h;
      internals.renderer?.resize?.(w, h);

      if (ux > 0 && uy > 0) {
        const cx = (bb[0] + bb[2]) / 2;
        const cy = (bb[1] + bb[3]) / 2;
        board.setBoundingBox(
          [cx - w / 2 / ux, cy + h / 2 / uy, cx + w / 2 / ux, cy - h / 2 / uy],
          // Hormati kunci rasio yang sedang aktif (bisa diubah simulasi).
          internals.keepaspectratio ?? aspectRef.current,
        );
      }
      last = { w, h };
      if (internals.fullUpdate) internals.fullUpdate();
      else board.update();
    };

    const observer = new ResizeObserver(sync);
    if (containerRef.current) observer.observe(containerRef.current);

    // Layar penuh dan rotasi mengubah ukuran bertahap; periksa ulang setelah
    // tata letak mapan agar tidak ada sisa area kosong di tepi bawah.
    let raf = 0;
    const settle = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        sync();
        raf = requestAnimationFrame(sync);
      });
    };
    document.addEventListener("fullscreenchange", settle);
    document.addEventListener("webkitfullscreenchange", settle);
    window.addEventListener("resize", settle);
    window.addEventListener("orientationchange", settle);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("fullscreenchange", settle);
      document.removeEventListener("webkitfullscreenchange", settle);
      window.removeEventListener("resize", settle);
      window.removeEventListener("orientationchange", settle);
      JXG.JSXGraph.freeBoard(board);
      boardRef.current = null;
    };
  }, [boardId]);

  const zoomIn = useCallback(() => boardRef.current?.zoomIn(), []);
  const zoomOut = useCallback(() => boardRef.current?.zoomOut(), []);
  const resetView = useCallback(
    () => boardRef.current?.setBoundingBox(boxRef.current, true),
    [],
  );

  return {
    boardProps: { id: boardId, ref: containerRef, className: "sim-board" },
    boardRef,
    zoomIn,
    zoomOut,
    resetView,
  };
}
