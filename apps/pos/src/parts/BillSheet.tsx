import { useCallback, useEffect, useState } from "react";
import { formatMYR, type Sen } from "@suriani/core/money";

import { api, type BillSheet as Bill } from "../api";
import { PaymentSheet, type Method } from "./PaymentSheet";

/**
 * One table's open bill: what is on it, what has been paid, and the two ways
 * money comes off it — a payment or a discount.
 *
 * Every action here goes through the outbox rather than straight to the
 * server. That is new in Phase 6 and it closes the last hole in the offline
 * promise: taking money is the most common thing a cashier does, and until
 * now it was the one thing that stopped working when the line did.
 */
export function BillSheet({
  outletId,
  outletName,
  tableId,
  onClose,
  onSay,
  onPay,
  onDiscount,
  onAddOrder,
}: {
  outletId: string;
  outletName: string;
  tableId: string;
  onClose: () => void;
  onSay: (msg: string) => void;
  /** Writes a payment.record op and prints the slip. */
  onPay: (input: {
    sessionId: string;
    method: Method;
    amountSen?: Sen;
    tenderedSen?: Sen;
    reference?: string;
    expectedDueSen: Sen;
  }) => Promise<{ settled: boolean; balanceSen: Sen }>;
  onDiscount: (input: {
    sessionId: string;
    amountSen: Sen;
    reason: string;
  }) => Promise<void>;
  /** Aim the order pad at this table and get out of the way. */
  onAddOrder: (table: { id: string; label: string }) => void;
}) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [closing, setClosing] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [paying, setPaying] = useState(false);

  const load = useCallback(
    () => api.bill(outletId, tableId).then(setBill, () => onSay("Gagal memuat bil")),
    [outletId, tableId, onSay],
  );

  useEffect(() => {
    void load();
  }, [load]);

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

  /**
   * Free the table without taking money.
   *
   * Payments front this now, so reaching for it means something unusual
   * happened — a walkout, or a bill settled outside the system. It stays
   * because those happen, and it is audit-logged so a table freed with money
   * still owing is visible rather than silent. The confirmation names the
   * amount being written off.
   */
  const close = async () => {
    if (!bill?.session) return;
    const owed = bill.session.outstandingSen;
    if (
      owed > 0 &&
      !window.confirm(
        `Tutup ${bill.table.label} tanpa bayaran? ${formatMYR(owed)} masih belum dijelaskan.`,
      )
    ) {
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

  /** A discount is refused without a reason, here as well as on the server. */
  const discount = async () => {
    if (!bill?.session) return;
    const raw = window.prompt(
      `Diskaun untuk ${bill.table.label} (RM). Baki ${formatMYR(bill.session.outstandingSen)}.`,
    );
    if (!raw) return;
    const amountSen = Math.round(Number(raw) * 100);
    if (!Number.isInteger(amountSen) || amountSen <= 0) {
      onSay("Jumlah diskaun tidak sah");
      return;
    }
    const reason = window.prompt("Sebab diskaun? (wajib)");
    if (!reason?.trim()) {
      onSay("Diskaun perlu sebab");
      return;
    }
    try {
      await onDiscount({ sessionId: bill.session.id, amountSen, reason: reason.trim() });
      await load();
      onSay(`Diskaun ${formatMYR(amountSen)} direkod`);
    } catch {
      onSay("Gagal merekod diskaun");
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
              {formatMYR(bill.session.outstandingSen)}
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
            <>
              <div className="bill-total">
                <span>Jumlah</span>
                <span className="num">{formatMYR(bill.session.totalSen)}</span>
              </div>
              {bill.session.discounts.map((d) => (
                <div className="bill-line" key={d.id}>
                  <span className="grow">
                    Diskaun
                    <span className="ticket-note"> {d.reason}</span>
                  </span>
                  <span className="num">{formatMYR(-d.amountSen)}</span>
                </div>
              ))}
              {bill.session.payments.map((p) => (
                <div className="bill-line" key={p.id}>
                  <span className="grow">
                    {p.method === "cash" ? "Tunai" : "DuitNow QR"}
                    {p.receiptNo !== null && (
                      <span className="ticket-note">
                        {" "}
                        resit {String(p.receiptNo).padStart(6, "0")}
                      </span>
                    )}
                  </span>
                  <span className="num">{formatMYR(-p.amountSen)}</span>
                </div>
              ))}
              {(bill.session.paidSen > 0 || bill.session.discountSen > 0) && (
                <div className="bill-total" data-testid="bill-outstanding">
                  <span>Baki</span>
                  <span className="num">{formatMYR(bill.session.outstandingSen)}</span>
                </div>
              )}
            </>
          )}
        </div>
        {bill?.session && (
          <>
            <div className="sheet-foot">
              {/* The commonest thing a cashier does at an occupied table is
                  add to it — someone wants another teh. One tap aims the pad
                  and closes the sheet. */}
              <button
                className="btn btn-quiet"
                data-testid="add-order"
                onClick={() => {
                  onAddOrder({ id: bill.table.id, label: bill.table.label });
                  onClose();
                }}
              >
                Tambah pesanan
              </button>
              <button
                className="btn btn-quiet"
                disabled={printing}
                data-testid="print-receipt"
                onClick={() => void print()}
              >
                {printing ? "Menghantar…" : "Cetak bil"}
              </button>
              <button className="btn btn-quiet" onClick={() => void discount()}>
                Diskaun
              </button>
              <button
                className="btn btn-accent"
                data-testid="take-payment"
                onClick={() => setPaying(true)}
              >
                Bayar {formatMYR(bill.session.outstandingSen)}
              </button>
            </div>
            <div className="sheet-foot">
              <button className="btn btn-quiet" onClick={onClose}>
                Kembali
              </button>
              <button
                className="btn btn-quiet"
                disabled={closing}
                onClick={() => void close()}
              >
                Tutup tanpa bayaran
              </button>
            </div>
          </>
        )}
      </div>

      {paying && bill?.session && (
        <PaymentSheet
          bill={{ ...bill.session, tableLabel: bill.table.label }}
          outletName={outletName}
          onClose={() => setPaying(false)}
          onPay={async (input) => {
            const result = await onPay({
              sessionId: bill.session!.id,
              expectedDueSen: bill.session!.outstandingSen,
              ...input,
            });
            setPaying(false);

            // Acted on what the till already worked out, not on a refetch.
            // The op is durable but the outbox drains asynchronously, so
            // asking the server would leave the sheet showing an unpaid bill
            // for as long as the round trip took — and forever with the line
            // down, which is the case this whole path exists for.
            if (result.settled) {
              onClose();
              return;
            }
            setBill((prev) =>
              prev?.session
                ? {
                    ...prev,
                    session: {
                      ...prev.session,
                      paidSen: prev.session.totalSen - prev.session.discountSen - result.balanceSen,
                      outstandingSen: result.balanceSen,
                    },
                  }
                : prev,
            );
          }}
        />
      )}
    </div>
  );
}
