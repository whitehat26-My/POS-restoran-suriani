import { useState } from "react";
import { formatMYR } from "@suriani/core/money";

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
  const latest = placed[placed.length - 1];

  return (
    <div className="scroll">
      {latest && (
        <StatusCard
          t={t}
          placed={placed}
          stage={stage}
          billRequested={billRequested}
          waiterCalled={waiterCalled}
          onBill={onBill}
          onWaiter={onWaiter}
        />
      )}

      <nav className="cat-rail">
        {categories.map((c) => (
          <button
            key={c.id}
            aria-pressed={c.id === cat}
            onClick={() => setCat(c.id)}
          >
            {lang === "ms" ? c.nameMs : c.nameEn}
          </button>
        ))}
      </nav>

      <div className="menu-list">
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
                <DishArt itemId={item.id} />
              </div>
              <div>
                <div className="dish-name">
                  {lang === "ms" ? item.nameMs : item.nameEn}
                </div>
                <div className="dish-desc">
                  {lang === "ms" ? item.descMs : item.descEn}
                </div>
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
