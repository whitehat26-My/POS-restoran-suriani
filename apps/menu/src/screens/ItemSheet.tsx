import { useMemo, useState } from "react";
import { formatMYR, lineTotalSen } from "@suriani/core/money";

import type { MenuItem } from "../api";
import type { Lang, Key } from "../i18n";
import { DishArt } from "../art";

/**
 * Bottom sheet for one dish: options, quantity, a note for the kitchen.
 *
 * Radio behaviour when a group allows one choice, checkboxes when it allows
 * several. Add is disabled until every required group is satisfied, so the
 * server's option_required rejection is a backstop rather than the UX.
 */
export function ItemSheet({
  item,
  lang,
  t,
  onClose,
  onAdd,
}: {
  item: MenuItem;
  lang: Lang;
  t: (k: Key) => string;
  onClose: () => void;
  onAdd: (item: MenuItem, qty: number, optionIds: string[], notes?: string) => void;
}) {
  const [qty, setQty] = useState(1);
  const [chosen, setChosen] = useState<string[]>([]);
  const [notes, setNotes] = useState("");

  const toggle = (groupId: string, optionId: string, maxSelect: number) => {
    const group = item.modifierGroups.find((g) => g.id === groupId);
    if (!group) return;
    const inGroup = new Set(group.options.map((o) => o.id));
    const mine = chosen.filter((id) => inGroup.has(id));
    const rest = chosen.filter((id) => !inGroup.has(id));

    if (mine.includes(optionId)) {
      setChosen([...rest, ...mine.filter((id) => id !== optionId)]);
    } else if (maxSelect === 1) {
      setChosen([...rest, optionId]); // radio: replace
    } else if (mine.length < maxSelect) {
      setChosen([...rest, ...mine, optionId]);
    }
  };

  const satisfied = item.modifierGroups.every((g) => {
    const inGroup = new Set(g.options.map((o) => o.id));
    const n = chosen.filter((id) => inGroup.has(id)).length;
    return n >= g.minSelect && n <= g.maxSelect;
  });

  const totalSen = useMemo(() => {
    const modifiers = item.modifierGroups.flatMap((g) =>
      g.options
        .filter((o) => chosen.includes(o.id))
        .map((o) => ({ label: o.labelMs, priceDeltaSen: o.priceDeltaSen })),
    );
    return lineTotalSen(item.priceSen, qty, modifiers);
  }, [item, qty, chosen]);

  return (
    <div className="sheet-veil" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grab" />
        <div className="sheet-head">
          <div className="sheet-art">
            <DishArt itemId={item.id} />
          </div>
          <div>
            <div className="sheet-name">
              {lang === "ms" ? item.nameMs : item.nameEn}
            </div>
            <div className="sheet-price num">{formatMYR(item.priceSen)}</div>
          </div>
        </div>

        {item.modifierGroups.map((g) => (
          <div className="group" key={g.id}>
            <div className="group-head">
              <span className="group-name">
                {lang === "ms" ? g.nameMs : g.nameEn}
              </span>
              <span className={`group-rule ${g.minSelect > 0 ? "is-required" : ""}`}>
                {g.minSelect > 0
                  ? t("required")
                  : `${t("choose_upto")} ${g.maxSelect}`}
              </span>
            </div>
            {g.options.map((o) => (
              <button
                key={o.id}
                className="opt"
                aria-pressed={chosen.includes(o.id)}
                onClick={() => toggle(g.id, o.id, g.maxSelect)}
              >
                <span className="opt-mark" />
                <span className="opt-label">
                  {lang === "ms" ? o.labelMs : o.labelEn}
                </span>
                {o.priceDeltaSen !== 0 && (
                  <span className="opt-delta num">
                    +{formatMYR(o.priceDeltaSen)}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}

        <input
          className="notes-input"
          placeholder={t("notes_ph")}
          value={notes}
          maxLength={120}
          onChange={(e) => setNotes(e.target.value)}
        />

        <div className="sheet-foot">
          <div className="stepper" aria-label={t("qty")}>
            <button onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
            <span className="num">{qty}</span>
            <button onClick={() => setQty(Math.min(20, qty + 1))}>+</button>
          </div>
          <button
            className="btn sheet-add"
            disabled={!satisfied}
            onClick={() => onAdd(item, qty, chosen, notes.trim() || undefined)}
          >
            {t("add")} · <span className="num">{formatMYR(totalSen)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
