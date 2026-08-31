import { formatMYR } from "@suriani/core/money";

import type { Key } from "./i18n";
import type { PlacedSummary } from "./cart";

/**
 * The live card: the Diterima → Sedang dimasak → Dihidang track, driven by the
 * status poll, plus the two buttons that ring the till.
 */
export function StatusCard({
  t,
  placed,
  stage,
  billRequested,
  waiterCalled,
  onBill,
  onWaiter,
  local = false,
}: {
  t: (k: Key) => string;
  placed: PlacedSummary[];
  /** 1 received · 2 cooking · 3 served */
  stage: 1 | 2 | 3;
  billRequested: boolean;
  waiterCalled: boolean;
  onBill: () => void;
  onWaiter: () => void;
  /** Served by the tablet, which does not carry the two buttons below. */
  local?: boolean;
}) {
  const latest = placed[placed.length - 1];
  if (!latest) return null;
  const total = placed.reduce((s, o) => s + o.totalSen, 0);

  return (
    <div className="status-card">
      <div className="status-head">
        <strong>{t("st_title")}</strong>
        {stage < 3 && (
          <span className="status-eta num">
            {t("st_eta")} {latest.etaMin} {t("min")}
          </span>
        )}
      </div>
      <div className="track">
        <span className={stage === 1 ? "now" : "done"} />
        <span className={stage === 2 ? "now" : stage > 2 ? "done" : ""} />
        <span className={stage === 3 ? "done" : ""} />
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
          <span className="num">{formatMYR(total)}</span>
        </div>
      </div>
      <div className="status-acts">
        {local ? (
          <p className="status-note">{t("local_counter")}</p>
        ) : (
          <>
        {billRequested ? (
          <p className="status-note">{t("bill_requested")}</p>
        ) : (
          <button className="btn-card" onClick={onBill}>
            {t("minta_bil")}
          </button>
        )}
        {waiterCalled ? (
          <p className="status-note">{t("waiter_called")}</p>
        ) : (
          <button className="btn-card btn-card-ghost" onClick={onWaiter}>
            {t("call_waiter")}
          </button>
        )}
          </>
        )}
      </div>
    </div>
  );
}
