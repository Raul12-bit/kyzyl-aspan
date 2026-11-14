import type { SVGProps } from 'react';

/** 24×24 stroke icons drawn for Emberline (1.5px strokes, round joins). Decorative by default. */
const PATHS = {
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Zm5.3-2.2L21 21',
  layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  draw: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 9h6v6H9z',
  crosshair: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  pin: 'M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Zm0-9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  play: 'M8 5.5v13a.6.6 0 0 0 .9.5l10.2-6.5a.6.6 0 0 0 0-1L8.9 5a.6.6 0 0 0-.9.5Z',
  pause: 'M8 5v14M16 5v14',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v6m0-9.5v.5',
  close: 'm6 6 12 12M18 6 6 18',
  chevronRight: 'm9 5 7 7-7 7',
  chevronDown: 'm5 9 7 7 7-7',
  arrowRight: 'M4 12h16m-6-6 6 6-6 6',
  arrowLeft: 'M20 12H4m6-6-6 6 6 6',
  satellite:
    'm13 7 4 4m-9.5-.5 3-3a1.4 1.4 0 0 1 2 0l3 3a1.4 1.4 0 0 1 0 2l-3 3a1.4 1.4 0 0 1-2 0l-3-3a1.4 1.4 0 0 1 0-2ZM7 13 3 17l4 4 4-4m6-6 4-4-4-4-4 4m-6.5 8.5A3.5 3.5 0 0 0 4 20',
  flame:
    'M12 21c3.9 0 6.5-2.6 6.5-6.2 0-3.7-2.6-6-4.4-8.8-.4 2-1.5 3.2-2.8 3.9.2-2.6-.8-5.3-3-6.9.3 3.2-3.8 5.8-3.8 10.4C4.5 18.4 8.1 21 12 21Z',
  alert: 'M12 4 2.8 19.5h18.4L12 4Zm0 6v4.5m0 2.5v.5',
  download: 'M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M4.5 19.5h15',
  sparkles: 'M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.6l-1.6-5.4L5 10.6 10.4 9 12 3.5ZM18.5 16l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z',
  calendar: 'M4.5 6.5h15v13h-15zM4.5 10.5h15M8.5 4v4M15.5 4v4',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2.5-11.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5v.7m0 3v.5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 9h17M3.5 15h17M12 3c-2.5 2.7-3.5 5.7-3.5 9s1 6.3 3.5 9c2.5-2.7 3.5-5.7 3.5-9s-1-6.3-3.5-9Z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  map: 'M9 4.5 3.5 6.5v13L9 17.5l6 2 5.5-2v-13L15 6.5l-6-2Zm0 0v13m6-11v13',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1',
  shield: 'M12 3.5 19 6v5.5c0 4.3-3 7.7-7 9-4-1.3-7-4.7-7-9V6l7-2.5Zm-3 8.7 2.2 2.2 4-4.2',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  table: 'M4 5h16v14H4zM4 10h16M4 14.5h16M10 5v14',
  chart: 'M4 4v16h16M7.5 15l3.5-4 3 2.5L19 7',
  reset: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4',
  compare: 'M12 3v18M7 7l-4 5 4 5M17 7l4 5-4 5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  /** Provide only when the icon is the sole content and carries meaning. */
  title?: string;
}

export function Icon({ name, size = 20, title, strokeWidth = 1.6, ...rest }: IconProps) {
  const filled = name === 'play';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
