import katex from "katex";
import "katex/dist/katex.min.css";
import { useMemo } from "react";

type SimMathProps = {
  tex: string;
  display?: boolean;
  className?: string;
};

/** Menampilkan rumus dengan KaTeX. Contoh: <SimMath tex="x_1 = -b/2a" /> */
export function SimMath({ tex, display = false, className }: SimMathProps) {
  const html = useMemo(
    () =>
      katex.renderToString(tex, {
        throwOnError: false,
        displayMode: display,
        strict: "ignore",
      }),
    [tex, display],
  );
  return (
    <span
      className={className ? `sim-math ${className}` : "sim-math"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
