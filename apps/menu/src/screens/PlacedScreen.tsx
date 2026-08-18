import type { Lang, Key } from "../i18n";
import type { PlacedSummary } from "../cart";
import { StatusCard } from "../StatusCard";

/**
 * Static confirmation. The track sits at "Diterima" — it starts moving on its
 * own in Phase 3, when the POS exists to move it. Until then this screen
 * promises nothing it cannot show.
 */
export function PlacedScreen({
  t,
  placed,
  stage,
  billRequested,
  waiterCalled,
  onBill,
  onWaiter,
  onMore,
}: {
  t: (k: Key) => string;
  lang: Lang;
  placed: PlacedSummary[];
  stage: 1 | 2 | 3;
  billRequested: boolean;
  waiterCalled: boolean;
  onBill: () => void;
  onWaiter: () => void;
  onMore: () => void;
}) {
  const latest = placed[placed.length - 1];

  return (
    <div className="scroll">
      <div className="sent-hero">
        <div className="sent-mark">✓</div>
        <div className="sent-title">{t("sent_title")}</div>
        <div className="sent-body">{t("sent_body")}</div>
      </div>

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

      <div className="page">
        <button className="btn btn-block" onClick={onMore}>
          {t("order_more")}
        </button>
      </div>
    </div>
  );
}
