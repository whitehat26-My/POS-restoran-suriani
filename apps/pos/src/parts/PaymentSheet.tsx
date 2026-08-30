import { useState } from "react";
import { formatMYR, roundToNearest5Sen, type Sen } from "@suriani/core/money";

import type { BillSheet } from "../api";

/**
 * Taking the money.
 *
 * Built for one hand on a counter with a queue behind it, so: a keypad rather
 * than a keyboard, the amount already filled in with what is owed, and the
 * change in the largest type on the screen — that is the number the cashier
 * reads out loud and counts back.
 *
 * Splitting is this same sheet used twice. There is no separate split mode
 * because a bill takes payments until it is settled, so "RM 20 from him" is
 * just a smaller number typed into the same box.
 */

/** What the counter reaches for. Anything else gets typed. */
const QUICK: Sen[] = [500, 1000, 2000, 5000, 10_000];

export type Method = "cash" | "duitnow_qr";

export function PaymentSheet({
  bill,
  outletName,
  onClose,
  onPay,
}: {
  bill: NonNullable<BillSheet["session"]> & { tableLabel: string };
  outletName: string;
  onClose: () => void;
  onPay: (input: {
    method: Method;
    /** Absent settles the rest — the server works out how much that is. */
    amountSen?: Sen;
    tenderedSen?: Sen;
    reference?: string;
  }) => Promise<void>;
}) {
  const due = bill.outstandingSen;
  const [method, setMethod] = useState<Method>("cash");
  // Empty means "the whole thing", which is the overwhelmingly common case
  // and saves the cashier typing a number the till already knows.
  const [partial, setPartial] = useState("");
  const [tendered, setTendered] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const partialSen = partial ? Math.round(Number(partial) * 100) : null;
  const splitting = partialSen !== null && partialSen > 0 && partialSen < due;
  const askedSen = splitting ? partialSen : due;

  // Only a cash payment that clears the bill is rounded — the rule is about
  // the total of a bill over the counter, not about every amount that passes
  // through a drawer.
  const payableSen =
    method === "cash" && !splitting ? roundToNearest5Sen(askedSen) : askedSen;
  const roundingSen = payableSen - askedSen;

  const tenderedSen = tendered ? Math.round(Number(tendered) * 100) : null;
  const changeSen = tenderedSen === null ? null : tenderedSen - payableSen;
  const short = changeSen !== null && changeSen < 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onPay({
        method,
        ...(splitting ? { amountSen: partialSen } : {}),
        ...(method === "cash" && tenderedSen !== null
          ? { tenderedSen }
          : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal merekod bayaran");
      setBusy(false);
    }
  };

  const tapDigit = (digit: string) => {
    setTendered((prev) => {
      if (digit === "⌫") return prev.slice(0, -1);
      if (digit === "." && prev.includes(".")) return prev;
      // Two decimal places is the most a ringgit has.
      if (prev.includes(".") && prev.split(".")[1]!.length >= 2) return prev;
      return prev + digit;
    });
  };

  return (
    <div className="veil" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="sheet-title">
            Bayaran · {bill.tableLabel}
            <small>{outletName}</small>
          </span>
          <button className="sheet-x" onClick={onClose} aria-label="Tutup">
            ×
          </button>
        </div>

        <div className="sheet-scroll" data-testid="payment">
          <div className="pay-due">
            <span>Perlu dibayar</span>
            <strong className="num" data-testid="pay-due">
              {formatMYR(payableSen)}
            </strong>
          </div>
          {bill.paidSen > 0 && (
            <p className="pay-note">
              Sudah dibayar {formatMYR(bill.paidSen)} daripada{" "}
              {formatMYR(bill.totalSen - bill.discountSen)}.
            </p>
          )}
          {roundingSen !== 0 && (
            <p className="pay-note" data-testid="pay-rounding">
              Pembundaran tunai {formatMYR(roundingSen)} — syiling 1 sen sudah
              tiada.
            </p>
          )}

          <div className="opt-row-group">
            {(["cash", "duitnow_qr"] as const).map((m) => (
              <button
                key={m}
                className="opt"
                aria-pressed={method === m}
                data-testid={`method-${m}`}
                onClick={() => setMethod(m)}
              >
                <span className="opt-mark" />
                <span className="opt-label">
                  {m === "cash" ? "Tunai" : "DuitNow QR"}
                </span>
              </button>
            ))}
          </div>

          {method === "cash" ? (
            <>
              <div className="pay-tendered">
                <span>Diterima</span>
                <strong className="num">
                  {tendered ? formatMYR(tenderedSen ?? 0) : "—"}
                </strong>
              </div>

              <div className="quick-row">
                {QUICK.map((sen) => (
                  <button
                    key={sen}
                    className="mini"
                    onClick={() => setTendered((sen / 100).toFixed(0))}
                  >
                    {formatMYR(sen).replace("RM ", "")}
                  </button>
                ))}
                <button
                  className="mini"
                  data-testid="tender-exact"
                  onClick={() => setTendered((payableSen / 100).toFixed(2))}
                >
                  Cukup
                </button>
              </div>

              <div className="keypad">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map(
                  (key) => (
                    <button key={key} onClick={() => tapDigit(key)}>
                      {key}
                    </button>
                  ),
                )}
              </div>

              {changeSen !== null && (
                <div className={`pay-change ${short ? "is-short" : ""}`}>
                  <span>{short ? "Kurang" : "Baki"}</span>
                  {/* The biggest number on the screen: it is the one the
                      cashier counts back into somebody's hand. */}
                  <strong className="num" data-testid="pay-change">
                    {formatMYR(Math.abs(changeSen))}
                  </strong>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="pay-note">
                Pelanggan mengimbas kod QR DuitNow di kaunter dan menunjukkan
                pengesahan. Tekan sahkan hanya selepas melihatnya.
              </p>
              <label className="setup-field">
                <span>Rujukan (jika ada)</span>
                <input
                  className="field"
                  autoCapitalize="off"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
            </>
          )}

          <label className="setup-field">
            <span>Bayar sebahagian sahaja (kosongkan untuk penuh)</span>
            <input
              className="field"
              inputMode="decimal"
              placeholder={(due / 100).toFixed(2)}
              data-testid="pay-partial"
              value={partial}
              onChange={(e) => setPartial(e.target.value)}
            />
          </label>

          {error && <div className="login-err">{error}</div>}
        </div>

        <div className="sheet-foot">
          <button className="btn btn-quiet" onClick={onClose}>
            Kembali
          </button>
          <button
            className="btn btn-accent"
            data-testid="pay-confirm"
            disabled={busy || short || payableSen <= 0}
            onClick={() => void submit()}
          >
            {busy
              ? "Sekejap…"
              : splitting
                ? `Terima ${formatMYR(payableSen)}`
                : `Sahkan ${formatMYR(payableSen)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
