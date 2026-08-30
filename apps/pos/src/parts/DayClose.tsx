import { useCallback, useEffect, useState } from "react";
import { formatMYR } from "@suriani/core/money";

import { api, type DayMoney } from "../api";

/**
 * Counting the drawer.
 *
 * The one screen that can tell somebody the money is wrong before the
 * month's accounts do. It shows what the till thinks should be in the drawer,
 * takes what is actually in it, and prints the difference whether or not the
 * difference is comfortable — a close that only records agreeable numbers is
 * worth nothing.
 *
 * Open to any staff, deliberately. Whoever is on the counter at closing time
 * is the one who counts, and the protection that matters is the audit log
 * naming them, not a role gate that has the owner driving over.
 */
export function DayClose({
  outletId,
  onSay,
}: {
  outletId: string;
  onSay: (msg: string) => void;
}) {
  const [day, setDay] = useState<DayMoney | null>(null);
  const [float, setFloat] = useState("");
  const [counted, setCounted] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () => api.day(outletId).then(setDay, () => onSay("Gagal memuat rekod hari")),
    [outletId, onSay],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const saveFloat = async () => {
    const sen = Math.round(Number(float) * 100);
    if (!Number.isInteger(sen) || sen < 0) {
      onSay("Jumlah tidak sah");
      return;
    }
    setBusy(true);
    try {
      await api.openDay(outletId, sen);
      await load();
      setFloat("");
      onSay(`Wang permulaan ${formatMYR(sen)} direkod`);
    } catch {
      onSay("Gagal — hari mungkin sudah ditutup");
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    const sen = Math.round(Number(counted) * 100);
    if (!Number.isInteger(sen) || sen < 0) {
      onSay("Jumlah tidak sah");
      return;
    }
    setBusy(true);
    try {
      const result = await api.closeDay(outletId, sen);
      await load();
      onSay(
        result.varianceSen === 0
          ? "Seimbang — laci tepat"
          : `${result.varianceSen > 0 ? "Lebih" : "Kurang"} ${formatMYR(Math.abs(result.varianceSen))}`,
      );
    } catch {
      onSay("Gagal menutup hari");
    } finally {
      setBusy(false);
    }
  };

  if (!day) return <div className="setup" />;

  const closing = day.closing;
  const expected = closing?.expectedCashSen ?? 0;
  const variance = closing?.varianceSen ?? null;

  return (
    <div className="setup" data-testid="day-close">
      <section className="setup-card">
        <h2>Hari ini · {day.date}</h2>

        <div className="stat-row">
          <div className="stat">
            <span className="stat-label">Kutipan</span>
            <span className="stat-value num" data-testid="collected">
              {formatMYR(day.collectedSen)}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Tunai</span>
            <span className="stat-value num">{formatMYR(day.cashSen)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Diskaun</span>
            <span className="stat-value num">{formatMYR(day.discountSen)}</span>
          </div>
        </div>

        {day.byMethod.length === 0 ? (
          <p className="empty">Belum ada bayaran hari ini.</p>
        ) : (
          day.byMethod.map((m) => (
            <div className="bill-line" key={m.method}>
              <span className="grow">
                {m.method === "cash" ? "Tunai" : "DuitNow QR"}
                <span className="ticket-note"> {m.count} bayaran</span>
              </span>
              <span className="num">{formatMYR(m.totalSen)}</span>
            </div>
          ))
        )}
      </section>

      <section className="setup-card">
        <h2>Laci</h2>
        <p className="setup-help">
          Wang permulaan pagi tadi, campur setiap bayaran tunai hari ini.
          Bayaran DuitNow tidak pernah masuk laci, jadi ia tidak dikira di sini.
        </p>

        <div className="bill-line">
          <span className="grow">Wang permulaan</span>
          <span className="num">{formatMYR(closing?.openingFloatSen ?? 0)}</span>
        </div>
        <div className="bill-line">
          <span className="grow">Tunai diterima</span>
          <span className="num">{formatMYR(day.cashSen)}</span>
        </div>
        <div className="bill-total">
          <span>Sepatutnya ada</span>
          <span className="num" data-testid="expected-cash">
            {formatMYR(expected)}
          </span>
        </div>

        {closing?.closedAt ? (
          <>
            <div className="bill-line">
              <span className="grow">Dikira</span>
              <span className="num">{formatMYR(closing.countedCashSen ?? 0)}</span>
            </div>
            <div
              className={`bill-total ${variance ? "is-variance" : ""}`}
              data-testid="variance"
            >
              <span>
                {variance === 0 ? "Seimbang" : variance! > 0 ? "Lebih" : "Kurang"}
              </span>
              <span className="num">{formatMYR(Math.abs(variance ?? 0))}</span>
            </div>
            <p className="setup-help">
              Hari sudah ditutup. Wang permulaan tidak boleh diubah selepas ini
              — kalau boleh, beza laci menjadi apa sahaja yang dikehendaki.
            </p>
          </>
        ) : (
          <>
            <label className="setup-field">
              <span>Wang permulaan (RM)</span>
              <input
                className="field"
                inputMode="decimal"
                placeholder={((closing?.openingFloatSen ?? 0) / 100).toFixed(2)}
                value={float}
                onChange={(e) => setFloat(e.target.value)}
              />
            </label>
            <div className="setup-row">
              <button className="mini" disabled={busy} onClick={() => void saveFloat()}>
                Simpan wang permulaan
              </button>
            </div>

            <label className="setup-field">
              <span>Tunai dikira sekarang (RM)</span>
              <input
                className="field"
                inputMode="decimal"
                data-testid="counted-cash"
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
              />
            </label>
            <div className="setup-row">
              <button
                className="btn btn-accent"
                disabled={busy || !counted}
                data-testid="close-day"
                onClick={() => void close()}
              >
                {busy ? "Sekejap…" : "Tutup hari"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
