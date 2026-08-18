import { useMemo, useState } from "react";
import { formatMYR, lineTotalSen } from "@suriani/core/money";

import type { MenuItem } from "../api";

export interface ConfiguredLine {
  menuItemId: string;
  nameMs: string;
  qty: number;
  optionIds: string[];
  notes?: string;
  lineSen: number;
}

/** Options + quantity for one counter-order item. Same rules as the phone. */
export function ItemConfig({
  item,
  onClose,
  onAdd,
}: {
  item: MenuItem;
  onClose: () => void;
  onAdd: (line: ConfiguredLine) => void;
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
      setChosen([...rest, optionId]);
    } else if (mine.length < maxSelect) {
      setChosen([...rest, ...mine, optionId]);
    }
  };

  const satisfied = item.modifierGroups.every((g) => {
    const inGroup = new Set(g.options.map((o) => o.id));
    const n = chosen.filter((id) => inGroup.has(id)).length;
    return n >= g.minSelect && n <= g.maxSelect;
  });

  const lineSen = useMemo(() => {
    const modifiers = item.modifierGroups.flatMap((g) =>
      g.options
        .filter((o) => chosen.includes(o.id))
        .map((o) => ({ label: o.labelMs, priceDeltaSen: o.priceDeltaSen })),
    );
    return lineTotalSen(item.priceSen, qty, modifiers);
  }, [item, qty, chosen]);

  return (
    <div className="veil" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="sheet-title">{item.nameMs}</span>
          <button className="sheet-x" onClick={onClose}>×</button>
        </div>
        <div className="sheet-scroll">
          {item.modifierGroups.map((g) => (
            <div key={g.id}>
              <div className="zone-name">
                {g.nameMs}
                {g.minSelect > 0 ? " · wajib" : ""}
              </div>
              {g.options.map((o) => (
                <button
                  key={o.id}
                  className="opt-row"
                  aria-pressed={chosen.includes(o.id)}
                  onClick={() => toggle(g.id, o.id, g.maxSelect)}
                >
                  <span className="grow">{o.labelMs}</span>
                  {o.priceDeltaSen !== 0 && (
                    <span className="num">+{formatMYR(o.priceDeltaSen)}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
          <input
            className="field"
            style={{ width: "100%", marginTop: 10 }}
            placeholder="Nota dapur"
            value={notes}
            maxLength={120}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="qty-row">
            <button onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
            <span className="num" style={{ fontWeight: 700 }}>{qty}</span>
            <button onClick={() => setQty(Math.min(20, qty + 1))}>+</button>
          </div>
        </div>
        <div className="sheet-foot">
          <button
            className="btn"
            disabled={!satisfied}
            onClick={() =>
              onAdd({
                menuItemId: item.id,
                nameMs: item.nameMs,
                qty,
                optionIds: chosen,
                notes: notes.trim() || undefined,
                lineSen,
              })
            }
          >
            Tambah · <span className="num">{formatMYR(lineSen)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
