import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatMYR } from "@suriani/core/money";
import { shortLabel } from "@suriani/core/menu";

import type { MenuItem, TablePage } from "../api";
import type { Lang, Key } from "../i18n";
import type { PlacedSummary } from "../cart";
import { DishArt } from "../art";
import { StatusCard } from "../StatusCard";

export function MenuScreen({
  page,
  lang,
  t,
  placed,
  stage,
  billRequested,
  waiterCalled,
  onBill,
  onWaiter,
  onPick,
}: {
  page: TablePage;
  lang: Lang;
  t: (k: Key) => string;
  placed: PlacedSummary[];
  stage: 1 | 2 | 3;
  billRequested: boolean;
  waiterCalled: boolean;
  onBill: () => void;
  onWaiter: () => void;
  onPick: (item: MenuItem) => void;
}) {
  const categories = page.menu.categories;
  const [cat, setCat] = useState(categories[0]?.id ?? "");
  const items = page.menu.items.filter((i) => i.categoryId === cat);
  const category = categories.find((c) => c.id === cat);
  const heading = category
    ? lang === "ms"
      ? category.nameMs
      : category.nameEn
    : "";
  const latest = placed[placed.length - 1];

  const rail = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = rail.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, []);

  useLayoutEffect(measure, [measure, categories.length]);

  /**
   * A vertical wheel scrolls the rail sideways.
   *
   * Without this a laptop cannot move it at all: a wheel over a horizontal
   * container does nothing unless you know to hold shift. Fourteen sections
   * make that the difference between finding nasi goreng and not.
   *
   * Bound here rather than with onWheel because React's synthetic wheel
   * handler is passive, and a passive listener cannot preventDefault.
   */
  useEffect(() => {
    const el = rail.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      // At either end, hand the gesture back so the page still scrolls.
      if (e.deltaY < 0 && el.scrollLeft <= 0) return;
      if (e.deltaY > 0 && el.scrollLeft >= max) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", measure);
    };
  }, [measure]);

  /** Keep the chosen section on screen — it may be the eleventh of fourteen. */
  const pickCategory = (id: string) => {
    setCat(id);
    rail.current
      ?.querySelector(`[data-cat="${id}"]`)
      ?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  };

  return (
    <div className="scroll">
      {latest && (
        <StatusCard
          t={t}
          placed={placed}
          stage={stage}
          billRequested={billRequested}
          local={page.local === true}
          waiterCalled={waiterCalled}
          onBill={onBill}
          onWaiter={onWaiter}
        />
      )}

      <nav
        ref={rail}
        className={`cat-rail ${edges.left ? "more-left" : ""} ${
          edges.right ? "more-right" : ""
        }`}
      >
        {categories.map((c) => (
          <button
            key={c.id}
            data-cat={c.id}
            aria-pressed={c.id === cat}
            onClick={() => pickCategory(c.id)}
          >
            {lang === "ms" ? c.nameMs : c.nameEn}
          </button>
        ))}
      </nav>

      <p className="press-hint">{t("press_hint")}</p>

      <div className="menu-list">
        {items.length === 0 && <p className="empty-cat">{t("cat_empty")}</p>}
        {items.map((item) => {
          const out = item.isAvailable === 0;
          return (
            <button
              key={item.id}
              className="dish"
              disabled={out}
              onClick={() => onPick(item)}
            >
              <div className="dish-art">
                <DishArt itemId={item.id} categoryId={item.categoryId} />
              </div>
              <div>
                <div className="dish-name">
                  {/* The heading is right there above it, so drop it from the
                      row exactly as the printed menu does. The stored name
                      stays full for the docket and the bill. */}
                  {shortLabel(lang === "ms" ? item.nameMs : item.nameEn, heading)}
                </div>
                {/* The printed menu carries no dish descriptions, so most
                    items have none. An empty element still takes its margin
                    and leaves a gap under every name. */}
                {(lang === "ms" ? item.descMs : item.descEn) && (
                  <div className="dish-desc">
                    {lang === "ms" ? item.descMs : item.descEn}
                  </div>
                )}
                <div className="dish-foot">
                  <span className="dish-price num">{formatMYR(item.priceSen)}</span>
                  {out && <span className="tag tag-out">{t("sold_out")}</span>}
                  {item.tags.includes("best") && (
                    <span className="tag tag-best">{t("best")}</span>
                  )}
                  {item.tags.includes("hot") && (
                    <span className="tag tag-hot">{t("hot")}</span>
                  )}
                  {item.tags.includes("halal") && (
                    <span className="tag tag-halal">Halal</span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <p className="helper">{t("helper")}</p>
    </div>
  );
}
