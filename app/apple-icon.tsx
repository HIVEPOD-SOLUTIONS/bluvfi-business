import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** The bluvfi mark from components/Nav.tsx, full-bleed (iOS rounds the corners itself). */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <svg width="180" height="180" viewBox="0 0 32 32">
        <rect width="32" height="32" fill="#0000CC" />
        <path d="M11 7v18M11 14c1.2-1.4 2.8-2 4.6-2 3.3 0 5.4 2.2 5.4 5s-2.1 5-5.4 5c-1.8 0-3.4-.6-4.6-2" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M24 5l2.6 2.6L24 10.2 21.4 7.6z" fill="#C9A84C" />
      </svg>
    ),
    size,
  );
}
