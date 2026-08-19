/**
 * Stylised top-down enamel plates, straight from the approved Phase 0
 * prototype. Inline SVG: no image requests, works offline, ties to the
 * palette. Unknown dishes get a plain plate, so a future restaurant's menu
 * renders decently before anyone uploads photos.
 */

function Plate({ inner, rim = "#0B5D48" }: { inner: React.ReactNode; rim?: string }) {
  return (
    <svg viewBox="0 0 84 84" aria-hidden="true">
      <rect width="84" height="84" fill="#EFEDE3" />
      <circle cx="42" cy="42" r="33" fill="#FCFBF7" stroke={rim} strokeWidth="3.5" />
      {inner}
    </svg>
  );
}

const ART: Record<string, React.ReactNode> = {
  itm_nasilemak: (
    <Plate
      inner={
        <>
          <path d="M42 24c9 0 15 7 15 14s-7 13-15 13-15-6-15-13 6-14 15-14z" fill="#FFFDF4" />
          <circle cx="30" cy="52" r="7" fill="#DC3B23" />
          <ellipse cx="55" cy="50" rx="8" ry="6" fill="#FFF6D8" />
          <circle cx="55" cy="50" r="3" fill="#D9963A" />
          <path d="M20 42c4-2 8-2 11 0" stroke="#8A6A3A" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M50 26c4 1 7 3 9 6" stroke="#3E9E62" strokeWidth="3" fill="none" strokeLinecap="round" />
        </>
      }
    />
  ),
  itm_nasigoreng: (
    <Plate
      inner={
        <>
          <circle cx="42" cy="42" r="22" fill="#E4C489" />
          <circle cx="34" cy="36" r="3" fill="#DC3B23" />
          <circle cx="50" cy="45" r="3" fill="#DC3B23" />
          <circle cx="43" cy="52" r="2.6" fill="#3E9E62" />
          <circle cx="48" cy="33" r="2.6" fill="#3E9E62" />
          <circle cx="33" cy="48" r="2.4" fill="#8A6A3A" />
        </>
      }
    />
  ),
  itm_meegoreng: (
    <Plate
      inner={
        <>
          <path d="M24 38c8-5 12 6 20 1s10 6 17 0" stroke="#D9963A" strokeWidth="4.5" fill="none" strokeLinecap="round" />
          <path d="M23 46c8-5 13 6 20 1s11 6 18 0" stroke="#E0A94F" strokeWidth="4.5" fill="none" strokeLinecap="round" />
          <path d="M25 54c8-4 12 5 19 1s11 5 17 0" stroke="#C9812C" strokeWidth="4.5" fill="none" strokeLinecap="round" />
          <circle cx="52" cy="34" r="4" fill="#DC3B23" />
          <circle cx="31" cy="33" r="3" fill="#3E9E62" />
        </>
      }
    />
  ),
  itm_roti: (
    <Plate
      inner={
        <>
          <circle cx="42" cy="42" r="23" fill="#F2DFB4" />
          <path d="M28 38c6 3 10-4 16 0s10-3 14 1" stroke="#D2B173" strokeWidth="2.5" fill="none" />
          <path d="M26 48c7 3 11-4 17 0s11-3 15 1" stroke="#D2B173" strokeWidth="2.5" fill="none" />
          <circle cx="42" cy="42" r="8" fill="#F6C846" />
        </>
      }
    />
  ),
  itm_ayam: (
    <Plate
      inner={
        <>
          <path d="M32 30c9-4 20 0 22 10s-6 18-15 17-16-8-14-17c1-5 4-8 7-10z" fill="#C97A2B" />
          <path d="M36 36c3-1 7 0 9 3" stroke="#8A4F14" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M40 48c4 1 8 0 10-2" stroke="#8A4F14" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <circle cx="27" cy="54" r="5" fill="#DC3B23" />
        </>
      }
    />
  ),
  itm_tehtarik: (
    <Plate
      inner={
        <>
          <path d="M30 26h24l-3 30H33z" fill="#FCFBF7" stroke="#0B5D48" strokeWidth="2.5" />
          <path d="M32 34h20l-2 20H34z" fill="#C58A4E" />
          <path d="M32 32h20v4H32z" fill="#E8D3B4" />
        </>
      }
    />
  ),
  itm_kopi: (
    <Plate
      rim="#101E19"
      inner={
        <>
          <path d="M29 28h26l-4 30H33z" fill="#FCFBF7" stroke="#101E19" strokeWidth="2.5" />
          <path d="M32 36h20l-3 20H35z" fill="#3B2415" />
          <rect x="36" y="20" width="3" height="10" rx="1.5" fill="#8C9189" />
        </>
      }
    />
  ),
  itm_milo: (
    <Plate
      inner={
        <>
          <path d="M30 28h24l-3 30H33z" fill="#FCFBF7" stroke="#0B5D48" strokeWidth="2.5" />
          <path d="M32 38h20l-2 18H34z" fill="#5A3418" />
          <rect x="34" y="32" width="16" height="6" rx="2" fill="#8A5A2E" />
          <rect x="46" y="18" width="3" height="12" rx="1.5" fill="#DC3B23" transform="rotate(12 47 24)" />
        </>
      }
    />
  ),
};

export function DishArt({ itemId }: { itemId: string }) {
  return <>{ART[itemId] ?? <Plate inner={null} />}</>;
}
