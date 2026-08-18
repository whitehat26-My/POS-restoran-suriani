import { useEffect, useState } from "react";
import { formatMYR } from "@suriani/core/money";

import { api, type BillSheet as Bill } from "../api";

/** One table's open bill: every order, every line, close when settled. */
export function BillSheet({
  outletId,
  tableId,
  onClose,
  onSay,
}: {
  outletId: string;
  tableId: string;
  onClose: () => void;
  onSay: (msg: string) => void;
}) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    api.bill(outletId, tableId).then(setBill, () => onSay("Gagal memuat bil"));
  }, [outletId, tableId, onSay]);

  const close = async () => {
    if (!bill?.session) return;
    // Phase 6 puts payment recording in front of this. Until then closing is
    // explicit and audit-logged, never a silent tap.
    if (!window.confirm(`Tutup bil ${bill.table.label} — ${formatMYR(bill.session.totalSen)}?`)) {
      return;
    }
    setClosing(true);
    try {
      await api.closeSession(outletId, bill.session.id);
      onSay(`${bill.table.label} ditutup`);
      onClose();
    } catch {
      onSay("Gagal menutup bil");
      setClosing(false);
    }
  };

  return (
    <div className="veil" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="sheet-title">{bill?.table.label ?? "…"}</span>
          <button className="sheet-x" onClick={onClose}>×</button>
        </div>
        <div className="sheet-scroll" data-testid="bill">
          {bill && !bill.session && <p className="empty">Tiada bil terbuka.</p>}
          {bill?.session?.orders.map((o) => (
            <div className="bill-order" key={o.id}>
              <div className="bill-order-head">
                <span>
                  {new Date(o.placedAt).toLocaleTimeString("ms-MY", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {o.source === "counter" ? " · kaunter" : ""}
                </span>
                <span>{o.status === "served" ? "✓ dihidang" : o.status}</span>
              </div>
              {o.lines.map((l, i) => (
                <div className="bill-line" key={i}>
                  <span className="ticket-qty num">{l.qty}×</span>
                  <span className="grow">
                    {l.nameMs}
                    {(l.modifiers.length > 0 || l.notes) && (
                      <span className="ticket-note">
                        {" "}
                        {[...l.modifiers.map((m) => m.label), l.notes]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </span>
                  <span className="num">{formatMYR(l.lineSen)}</span>
                </div>
              ))}
            </div>
          ))}
          {bill?.session && (
            <div className="bill-total">
              <span>Jumlah</span>
              <span className="num">{formatMYR(bill.session.totalSen)}</span>
            </div>
          )}
        </div>
        {bill?.session && (
          <div className="sheet-foot">
            <button className="btn btn-quiet" onClick={onClose}>Kembali</button>
            <button className="btn btn-accent" disabled={closing} onClick={() => void close()}>
              Tutup bil
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
