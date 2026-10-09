import type { Device } from '@shlab/engine';
export function DeviceIcon({
  type,
  profile,
  size = 48,
}: {
  type: Device['type'];
  profile?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={'device-icon ' + type}
    >
      {profile === 'rack' ? (
        <>
          <rect x="12" y="4" width="40" height="56" rx="2" stroke="currentColor" strokeWidth="2.5" />
          {[13, 24, 35, 46].map((y) => (
            <rect key={y} x="18" y={y} width="28" height="7" rx="1" fill="currentColor" opacity=".6" />
          ))}
        </>
      ) : profile === 'ups' ? (
        <>
          <rect x="12" y="8" width="40" height="48" rx="4" stroke="currentColor" strokeWidth="2.5" />
          <path d="m34 17-12 18h10l-2 14 13-20H33l1-12Z" fill="currentColor" />
        </>
      ) : profile === 'patch-panel' ? (
        <>
          <rect x="4" y="18" width="56" height="28" rx="3" stroke="currentColor" strokeWidth="2.5" />
          {[10, 20, 30, 40, 50].map((x) => (
            <g key={x}>
              <rect x={x} y="24" width="5" height="5" fill="currentColor" />
              <rect x={x} y="35" width="5" height="5" fill="currentColor" />
            </g>
          ))}
        </>
      ) : profile === 'database' ? (
        <>
          <ellipse cx="32" cy="12" rx="22" ry="8" stroke="currentColor" strokeWidth="2.5" />
          <path
            d="M10 12v40c0 11 44 11 44 0V12M10 25c0 11 44 11 44 0M10 39c0 11 44 11 44 0"
            stroke="currentColor"
            strokeWidth="2.5"
          />
        </>
      ) : type === 'pc' ? (
        <>
          <rect x="9" y="9" width="46" height="33" rx="4" fill="currentColor" opacity=".12" />
          <rect x="9" y="9" width="46" height="33" rx="4" stroke="currentColor" strokeWidth="2.5" />
          <path
            d="M25 43v9m14-9v9M19 53h26M15 35h34"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <path d="m24 22 5 5 11-11" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </>
      ) : type === 'switch' ? (
        <>
          <path d="m7 24 9-10h33l8 10v23H7V24Z" fill="currentColor" opacity=".12" />
          <path
            d="m7 24 9-10h33l8 10v23H7V24Z"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <path d="M7 26h50" stroke="currentColor" strokeWidth="2" />
          {[15, 24, 33, 42].map((x) => (
            <rect key={x} x={x} y="33" width="6" height="6" rx="1" fill="currentColor" />
          ))}
          <path d="M16 51h32" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </>
      ) : type === 'router' ? (
        <>
          <ellipse cx="32" cy="22" rx="24" ry="11" fill="currentColor" opacity=".15" />
          <path d="M8 22v21c0 6 11 11 24 11s24-5 24-11V22" stroke="currentColor" strokeWidth="2.5" />
          <ellipse cx="32" cy="22" rx="24" ry="11" stroke="currentColor" strokeWidth="2.5" />
          <path
            d="m19 21 6-3m-6 3 5 3m-5-3h10m16 1-6-3m6 3-5 3m5-3H35M17 41h3m5 2h3m5 1h3"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          {[8, 25, 42].map((y) => (
            <g key={y}>
              <rect
                x="14"
                y={y}
                width="36"
                height="14"
                rx="3"
                fill="currentColor"
                fillOpacity=".12"
                stroke="currentColor"
                strokeWidth="2.5"
              />
              <circle cx="22" cy={y + 7} r="2" fill="currentColor" />
              <path d={'M30 ' + (y + 7) + 'h12'} stroke="currentColor" strokeWidth="2" />
            </g>
          ))}
        </>
      )}
    </svg>
  );
}
