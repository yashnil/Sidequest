import { ImageResponse } from 'next/og';
import { SidequestMark } from './icon';

/**
 * The home-screen icon iOS asks for by name. Apple squares the corners
 * itself, so the mark is drawn edge to edge on the night ground.
 */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(<SidequestMark px={180} rounded={false} />, { ...size });
}
