import { ImageResponse } from 'next/og';

/**
 * V9 §11 — THE APP ICON, GENERATED: BRAND OCHRE ON THE ATLAS GROUND.
 *
 * Three sizes from one drawing, so the manifest can name a 192 and a 512
 * without a file in `public/` that drifts from the brand. No asset is
 * fetched; the mark is a route rule and a waypoint, drawn with boxes.
 */
const ATLAS = '#101d24';
const OCHRE = '#a94f27';
const INK = '#e9eef0';

export function generateImageMetadata() {
  return [
    { id: 'small', contentType: 'image/png', size: { width: 48, height: 48 } },
    { id: 'app', contentType: 'image/png', size: { width: 192, height: 192 } },
    { id: 'large', contentType: 'image/png', size: { width: 512, height: 512 } },
  ];
}

export function SidequestMark({ px }: { px: number }) {
  const unit = px / 48;
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: ATLAS, borderRadius: Math.round(px * 0.22) }}>
      <div style={{ position: 'relative', width: px * 0.62, height: px * 0.62, display: 'flex' }}>
        {/* The route: a rising rule from the lower left to the upper right. */}
        <div style={{ position: 'absolute', left: 0, top: '50%', width: '100%', height: Math.max(2, Math.round(3 * unit)), background: INK, transform: 'rotate(-38deg)', borderRadius: 999 }} />
        {/* The traveller's waypoint, in ochre. */}
        <div style={{ position: 'absolute', right: -unit * 2, top: -unit * 1, width: 14 * unit, height: 14 * unit, borderRadius: 999, background: OCHRE }} />
        {/* Where they started. */}
        <div style={{ position: 'absolute', left: -unit, bottom: -unit * 2, width: 8 * unit, height: 8 * unit, borderRadius: 999, background: INK }} />
      </div>
    </div>
  );
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const which = String(await id);
  const px = which === 'large' ? 512 : which === 'app' ? 192 : 48;
  return new ImageResponse(<SidequestMark px={px} />, { width: px, height: px });
}
