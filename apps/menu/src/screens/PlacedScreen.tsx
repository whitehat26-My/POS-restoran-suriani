import { formatMYR } from "@suriani/core/money";

import type { Lang, Key } from "../i18n";
import type { PlacedSummary } from "../cart";

/**
 * Static confirmation. The track sits at "Diterima" — it starts moving on its
 * own in Phase 3, when the POS exists to move it. Until then this screen
 * promises nothing it cannot show.
 */
export function PlacedScreen({
  t,
  placed,
  onMore,
}: {
  t: (k: Key) => string;
  lang: Lang;
  placed: PlacedSummary[];
  onMore: () => void;
}) {
  const latest = placed[placed.length - 1];
  const sessionTotal = placed.reduce((s, o) => s + o.totalSen, 0);

  return (
    <div className="scroll">
      <div className="sent-hero">
        <div className="sent-mark">✓</div>
        <div className="sent-title">{t("sent_title")}</div>
        <div className="sent-body">{t("sent_body")}</div>
      </div>

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
              <span className="num">{formatMYR(sessionTotal)}</span>
            </div>
          </div>
        </div>
      )}

      <div className="page">
        <button className="btn btn-block" onClick={onMore}>
          {t("order_more")}
        </button>
      </div>
    </div>
  );
}
