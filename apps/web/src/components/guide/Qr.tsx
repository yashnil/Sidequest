import { encode } from 'uqr';

/**
 * A QR code as crisp vector squares, so it scans from a home printer.
 * Error correction M survives a crease or a coffee ring; the quiet zone is the
 * four modules the standard asks for.
 */
export function Qr({ value, size, label }: { value: string; size: string; label: string }) {
  const { data, size: modules } = encode(value, { ecc: value.length > 180 ? 'L' : 'M', border: 0 });
  const quiet = 4;
  const total = modules + quiet * 2;
  let d = '';
  for (let y = 0; y < modules; y += 1) {
    let x = 0;
    while (x < modules) {
      if (!data[y]![x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < modules && data[y]![x]) x += 1;
      d += `M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`;
    }
  }
  return (
    <svg viewBox={`0 0 ${total} ${total}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges" className="guide-qr">
      <rect width={total} height={total} fill="#fff" />
      <path d={d} fill="#0d1a1f" />
    </svg>
  );
}
