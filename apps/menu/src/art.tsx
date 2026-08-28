/**
 * Stylised top-down enamel plates, straight from the approved Phase 0
 * prototype. Inline SVG: no image requests, works offline, ties to the
 * palette.
 *
 * Drawn per *category*, not per dish. The real menu has a hundred and
 * forty-seven dishes and nobody is drawing a hundred and forty-seven plates —
 * but every dish in a section looks broadly alike anyway, so a section's plate
 * is honest. A handful of drinks keep their own glass, and anything unmapped
 * falls back to a plain plate, so a new restaurant's menu renders decently
 * before anyone uploads a photo.
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

const DRAWINGS: Record<string, React.ReactNode> = {
  nasilemak: (
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
  nasigoreng: (
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
  mee: (
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
  roti: (
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
  ayam: (
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
  teh: (
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
  kopi: (
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
  milo: (
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
  chop: (
    <Plate
      inner={
        <>
          <path d="M27 34c6-8 24-8 30 0 5 7 3 17-5 21-7 4-13 4-20 0-8-4-10-14-5-21z" fill="#8A5A2E" stroke="#5A3418" strokeWidth="2.5" />
          <path d="M34 40c5-3 11-3 16 0" stroke="#3B220E" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M32 48c6-3 14-3 20 0" stroke="#3B220E" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M20 56h12l-2 6H22z" fill="#D9963A" />
          <path d="M56 24c5 1 8 4 9 8" stroke="#3E9E62" strokeWidth="3" fill="none" strokeLinecap="round" />
        </>
      }
    />
  ),
  pasta: (
    <Plate
      inner={
        <>
          <ellipse cx="42" cy="45" rx="20" ry="14" fill="#F3E2AE" />
          <path d="M25 42c8-5 26-5 34 0" stroke="#D9963A" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M25 48c8-5 26-5 34 0" stroke="#D9963A" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M27 54c8-4 22-4 30 0" stroke="#D9963A" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <ellipse cx="42" cy="38" rx="11" ry="6" fill="#DC3B23" />
          <path d="M38 26c4 1 6 3 7 6" stroke="#3E9E62" strokeWidth="3" fill="none" strokeLinecap="round" />
        </>
      }
    />
  ),
  burger: (
    <Plate
      inner={
        <>
          <path d="M24 38c0-8 8-13 18-13s18 5 18 13z" fill="#D9963A" stroke="#8A5A2E" strokeWidth="2" />
          <circle cx="35" cy="32" r="1.6" fill="#FFF6D8" />
          <circle cx="45" cy="30" r="1.6" fill="#FFF6D8" />
          <circle cx="52" cy="34" r="1.6" fill="#FFF6D8" />
          <rect x="23" y="38" width="38" height="5" rx="2.5" fill="#3E9E62" />
          <rect x="23" y="43" width="38" height="7" rx="2" fill="#5A3418" />
          <path d="M24 50c0 6 8 9 18 9s18-3 18-9z" fill="#D9963A" stroke="#8A5A2E" strokeWidth="2" />
        </>
      }
    />
  ),
};

/**
 * Which drawing a section gets. Deliberately a small map with obvious
 * neighbours — sets of rice share the rice plate, fried things share the
 * chicken plate — rather than a drawing per section nobody would keep updated.
 */
const BY_CATEGORY: Record<string, string> = {
  cat_hainan: "ayam",
  cat_nasilemak: "nasilemak",
  cat_setnasi: "nasigoreng",
  cat_mee: "mee",
  cat_nasigoreng: "nasigoreng",
  cat_western: "chop",
  cat_pasta: "pasta",
  cat_side: "ayam",
  cat_indo: "nasilemak",
  cat_sarapan: "roti",
  cat_tambahan: "ayam",
  cat_roti: "roti",
  cat_burger: "burger",
  cat_minum: "teh",
};

/** The few drinks that already had their own glass in the prototype. */
const BY_ITEM: Record<string, string> = {
  itm_min_kopio: "kopi",
  itm_min_kopisusu: "kopi",
  itm_min_cam: "kopi",
  itm_min_nescafe: "kopi",
  itm_min_nescafeo: "kopi",
  itm_min_milo: "milo",
  itm_min_milodinasour: "milo",
  itm_min_neslo: "milo",
  itm_min_horlick: "milo",
};

export function DishArt({
  itemId,
  categoryId,
}: {
  itemId: string;
  categoryId?: string;
}) {
  const key = BY_ITEM[itemId] ?? (categoryId ? BY_CATEGORY[categoryId] : undefined);
  return <>{(key && DRAWINGS[key]) ?? <Plate inner={null} />}</>;
}
