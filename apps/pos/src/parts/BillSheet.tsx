import { useEffect, useState } from "react";
import { formatMYR } from "@suriani/core/money";

import { api, type BillSheet as Bill } from "../api";

/** One table's open bill: what is on it, printed for the customer, then closed. */
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
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    api.bill(outletId, tableId).then(setBill, () => onSay("Gagal memuat bil"));
  }, [outletId, tableId, onSay]);

  const print = async () => {
    if (!bill?.session) return;
    setPrinting(true);
    try {
      await api.printReceipt(outletId, bill.session.id);
      onSay(`Bil ${bill.table.label} dihantar ke pencetak`);
    } catch {
      // The printer-health pill and the red banner carry the detail; this
      // toast only has to tell the cashier the tap did not land.
      onSay("Gagal menghantar bil ke pencetak");
    } finally {
      setPrinting(false);
    }
  };

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

        {bill?.session && (
          <div className="bill-strip" data-testid="bill-strip">
            <span className="bill-strip-count num">
              {bill.session.itemCount}
            </span>
            <span className="bill-strip-label">
              {bill.session.itemCount === 1 ? "hidangan" : "hidangan"}
              <small>
                {bill.session.orders.length} pesanan ·{" "}
                {bill.session.status === "bill_requested"
                  ? "minta bil"
                  : "masih makan"}
              </small>
            </span>
            <span className="bill-strip-total num">
              {formatMYR(bill.session.totalSen)}
            </span>
          </div>
        )}

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
            <button
              className="btn btn-quiet"
              disabled={printing}
              data-testid="print-receipt"
              onClick={() => void print()}
            >
              {printing ? "Menghantar…" : "Cetak resit"}
            </button>
            <button className="btn btn-accent" disabled={closing} onClick={() => void close()}>
              Tutup bil
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
