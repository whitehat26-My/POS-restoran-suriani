import { useState } from "react";
import { formatMYR } from "@suriani/core/money";

import type { MenuItem, TablePage } from "../api";
import type { Lang, Key } from "../i18n";
import type { PlacedSummary } from "../cart";
import { DishArt } from "../art";

export function MenuScreen({
  page,
  lang,
  t,
  placed,
  onPick,
}: {
  page: TablePage;
  lang: Lang;
  t: (k: Key) => string;
  placed: PlacedSummary[];
  onPick: (item: MenuItem) => void;
}) {
  const categories = page.menu.categories;
  const [cat, setCat] = useState(categories[0]?.id ?? "");
  const items = page.menu.items.filter((i) => i.categoryId === cat);
  const latest = placed[placed.length - 1];

  return (
    <div className="scroll">
      {latest && (
        <div className="status-card">
          <div className="status-head">
            <strong>{t("st_title")}</strong>
            <span className="status-eta num">
              {t("st_eta")} {latest.etaMin} {t("min")}
            </span>
          </div>
          <div className="track">
            <span className="now" />
            <span />
            <span />
          </div>
          <div className="track-labels">
            <span>{t("st_1")}</span>
            <span>{t("st_2")}</span>
            <span>{t("st_3")}</span>
          </div>
          <div className="status-items">
            {placed.flatMap((o) =>
              o.lines.map((l, i) => (
                <div className="status-item" key={`${o.orderId}_${i}`}>
                  <span>
                    {l.qty}× {l.name}
                  </span>
                </div>
              )),
            )}
            <div className="status-item">
              <span>{t("total")}</span>
              <span className="num">
                {formatMYR(placed.reduce((s, o) => s + o.totalSen, 0))}
              </span>
            </div>
          </div>
        </div>
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
