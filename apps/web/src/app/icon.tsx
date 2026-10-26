import { ImageResponse } from 'next/og';
import { MARK_HORIZON_PATH, MARK_RIDGE_PATH, MARK_SUN, MARK_TRAIL_PATH } from '@/components/brand/SidequestMark';

/**
 * THE APP ICON, GENERATED FROM THE MARK'S OWN GEOMETRY.
 *
 * "First Light": a flare sun behind a bone ridge, a night-coloured dotted
 * trail up it and a glacier horizon, on the night ground — at three sizes
 * from one drawing, so the manifest's 192 and 512 can never drift from the
 * brand. The tile geometry is drawn inside the maskable 80 % safe circle, so
 * the same image serves every Android mask. No asset is fetched.
 */
const NIGHT = '#0d1a1f';
const BONE = '#f1ebdf';
const FLARE = '#ff5a1f';
const GLACIER = '#7fd1e0';

export function generateImageMetadata() {
  return [
    { id: 'small', contentType: 'image/png', size: { width: 48, height: 48 } },
    { id: 'app', contentType: 'image/png', size: { width: 192, height: 192 } },
    { id: 'large', contentType: 'image/png', size: { width: 512, height: 512 } },
  ];
}

export function SidequestMark({ px, rounded = true }: { px: number; rounded?: boolean }) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', background: NIGHT, borderRadius: rounded ? Math.round(px * 0.22) : 0 }}>
      <svg width={px} height={px} viewBox="0 0 100 100">
        <circle cx={MARK_SUN.cx} cy={MARK_SUN.cy} r={MARK_SUN.r} fill={FLARE} />
        <path d={MARK_RIDGE_PATH} fill={BONE} stroke={BONE} strokeWidth={2} strokeLinejoin="round" />
        {/* Under a pixel wide at favicon size, so only the app icons carry the trail. */}
        {px >= 96 ? <path d={MARK_TRAIL_PATH} fill="none" stroke={NIGHT} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="0.5 4.2" /> : null}
        <path d={MARK_HORIZON_PATH} fill="none" stroke={GLACIER} strokeWidth={2.4} strokeLinecap="round" />
      </svg>
    </div>
  );
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const which = String(await id);
  const px = which === 'large' ? 512 : which === 'app' ? 192 : 48;
  return new ImageResponse(<SidequestMark px={px} />, { width: px, height: px });
}
