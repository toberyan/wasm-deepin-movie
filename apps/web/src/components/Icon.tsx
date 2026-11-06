import type { ReactElement, SVGProps } from "react";

export type IconName =
  | "play"
  | "pause"
  | "volume"
  | "volumeOff"
  | "settings"
  | "subtitles"
  | "audio"
  | "fullscreen"
  | "exitFullscreen"
  | "folder"
  | "link"
  | "library"
  | "more"
  | "camera"
  | "close"
  | "chevronDown"
  | "check"
  | "reset"
  | "stats"
  | "film"
  | "sun"
  | "monitor"
  | "moon"
  | "speed"
  | "skipBack"
  | "skipForward"
  | "stepBack"
  | "stepForward"
  | "info";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

/**
 * Single-stroke icon set shared by the player chrome.
 * Kept inline so the packaged app has no icon-font or network dependency.
 */
export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

const paths: Record<IconName, ReactElement> = {
  play: <path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  volume: (
    <>
      <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4v-5Z" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 7a7 7 0 0 1 0 10" />
    </>
  ),
  volumeOff: (
    <>
      <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4v-5Z" />
      <path d="m16 9 5 5m0-5-5 5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h0A1.7 1.7 0 0 0 10 3.05V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v0c.24.6.8 1 1.45 1H21a2 2 0 1 1 0 4h-.09c-.65 0-1.21.4-1.51 1Z" />
    </>
  ),
  subtitles: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M6.5 14h3.2M12.6 14h4.9M6.5 10.5h4.9M14.3 10.5h3.2" />
    </>
  ),
  audio: (
    <>
      <path d="M5 9v6h3l5 4V5L8 9H5Z" />
      <path d="M16 9.5a4.2 4.2 0 0 1 0 5" />
    </>
  ),
  fullscreen: (
    <path d="M8.5 4H4v4.5M15.5 4H20v4.5M20 15.5V20h-4.5M4 15.5V20h4.5" />
  ),
  exitFullscreen: (
    <path d="M4 8.5h4.5V4M20 8.5h-4.5V4M15.5 20v-4.5H20M8.5 20v-4.5H4" />
  ),
  folder: (
    <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3l2 2.5h7A2.5 2.5 0 0 1 20.5 10v6A2.5 2.5 0 0 1 18 18.5H6A2.5 2.5 0 0 1 3.5 16V7.5Z" />
  ),
  link: (
    <>
      <path d="M10 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.5 6.3" />
      <path d="M14 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.1-1.1" />
    </>
  ),
  library: (
    <>
      <path d="M4 6h10M4 12h10M4 18h10" />
      <path d="m17 8 2.5 2.5L17 13M17 13v5" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8.5h3l1.5-2h7l1.5 2h3v10H4v-10Z" />
      <circle cx="12" cy="13" r="3.2" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  reset: (
    <>
      <path d="M4.5 9.5A8 8 0 1 1 4 12" />
      <path d="M4.5 4.5v5h5" />
    </>
  ),
  stats: (
    <>
      <path d="M4 19V5M4 19h16" />
      <path d="m7 15 3.5-4 3 2.5L19 7" />
    </>
  ),
  film: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M8 4.5v15M16 4.5v15M3.5 9h4.5M16 9h4.5M3.5 15h4.5M16 15h4.5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  speed: (
    <>
      <path d="M5.2 18.5a8 8 0 1 1 13.6 0" />
      <path d="m12 12 4-4" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  skipBack: (
    <>
      <path d="M6 5v14" />
      <path d="M18 6.5 9 12l9 5.5v-11Z" fill="currentColor" stroke="none" />
    </>
  ),
  skipForward: (
    <>
      <path d="M18 5v14" />
      <path d="M6 6.5 15 12l-9 5.5v-11Z" fill="currentColor" stroke="none" />
    </>
  ),
  stepBack: (
    <>
      <path d="M7 6v12" />
      <path d="m17 7-7 5 7 5V7Z" />
    </>
  ),
  stepForward: (
    <>
      <path d="M17 6v12" />
      <path d="m7 7 7 5-7 5V7Z" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8v.2" />
    </>
  )
};
