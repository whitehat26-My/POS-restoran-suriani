import { formatMYR } from "@suriani/core/money";

import type { TablePage } from "../api";
import type { Lang, Key } from "../i18n";
import { cartTotalSen, type CartState } from "../cart";

export function CartScreen({
  page,
  lang,
  t,
  cart,
  sending,
  onRemove,
  onQty,
  onBack,
  onSubmit,
}: {
  page: TablePage;
  lang: Lang;
  t: (k: Key) => string;
  cart: CartState;
  sending: boolean;
  onRemove: (lineId: string) => void;
  onQty: (lineId: string, qty: number) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const items = new Map(page.menu.items.map((i) => [i.id, i]));
  const totalSen = cartTotalSen(cart.lines, page.menu.items);

  return (
    <div className="scroll">
      <div className="page">
        <button className="btn btn-ghost" onClick={onBack}>
          ← {t("back_menu")}
        </button>
        <h1 className="page-title">{t("your_cart")}</h1>

        {cart.lines.length === 0 && <p className="helper">{t("empty_cart")}</p>}

        {cart.lines.map((line) => {
          const item = items.get(line.menuItemId);
          if (!item) return null;
          const optionLabels = item.modifierGroups.flatMap((g) =>
            g.options
              .filter((o) => line.optionIds.includes(o.id))
              .map((o) => (lang === "ms" ? o.labelMs : o.labelEn)),
          );
          const deltas = item.modifierGroups.flatMap((g) =>
            g.options
              .filter((o) => line.optionIds.includes(o.id))
              .map((o) => o.priceDeltaSen),
          );
          const lineSen =
            (item.priceSen + deltas.reduce((s, d) => s + d, 0)) * line.qty;

          return (
            <div className="line-item" key={line.lineId}>
              <span className="line-qty num">{line.qty}×</span>
              <div className="line-body">
                <div className="line-name">
                  {lang === "ms" ? item.nameMs : item.nameEn}
                </div>
                {(optionLabels.length > 0 || line.notes) && (
                  <div className="line-opts">
                    {[...optionLabels, line.notes].filter(Boolean).join(" · ")}
                  </div>
                )}
                {/* Getting the count wrong is as common as getting the dish
                    wrong, and deleting the line to re-add it loses the options
                    and the note that went with it. */}
                <div className="line-actions">
                  <div className="line-stepper">
                    <button
                      aria-label={t("qty_less")}
                      onClick={() => onQty(line.lineId, line.qty - 1)}
                    >
                      −
                    </button>
                    <span className="num">{line.qty}</span>
                    <button
                      aria-label={t("qty_more")}
                      onClick={() => onQty(line.lineId, line.qty + 1)}
                    >
                      +
                    </button>
                  </div>
                  <button
                    className="line-remove"
                    onClick={() => onRemove(line.lineId)}
                  >
                    {t("remove")}
                  </button>
                </div>
              </div>
              <span className="line-sen num">{formatMYR(lineSen)}</span>
            </div>
          );
        })}

        {cart.lines.length > 0 && (
          <>
            <div className="total-row">
              <span>{t("total")}</span>
              <span className="num">{formatMYR(totalSen)}</span>
            </div>
            <button
              className="btn btn-accent btn-block"
              disabled={sending}
              onClick={onSubmit}
            >
              {sending ? t("placing") : t("place")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
