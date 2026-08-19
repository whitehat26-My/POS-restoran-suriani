import { useEffect, useState } from "react";
import { formatMYR } from "@suriani/core/money";

import { api, type DayRow, type DaySummary } from "../api";

/**
 * The owner's daily record.
 *
 * Deliberately says *Jualan* rather than "untung": the system knows what the
 * restaurant took, not what the ingredients cost, and a number labelled profit
 * that is really revenue is a number that gets believed and then acted on.
 * Cost prices per dish are a Phase 7 job; until they exist this is takings.
 */
export function Records({
  outletId,
  outletName,
  onSay,
}: {
  outletId: string;
  outletName: string;
  onSay: (msg: string) => void;
}) {
  const [days, setDays] = useState<DayRow[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [summary, setSummary] = useState<DaySummary | null>(null);

  useEffect(() => {
    setDays(null);
    setPicked(null);
    setSummary(null);
    api
      .dailySales(outletId, 30)
      .then((r) => {
        setDays(r.days);
        setPicked(r.days[0]?.date ?? null);
      })
      .catch(() => onSay("Gagal memuat rekod harian"));
  }, [outletId, onSay]);

  useEffect(() => {
    if (!picked) return;
    setSummary(null);
    api
      .daySummary(outletId, picked)
      .then(setSummary)
      .catch(() => onSay("Gagal memuat butiran hari"));
  }, [outletId, picked, onSay]);

  const total = (days ?? []).reduce((sum, d) => sum + d.salesSen, 0);
  const peak = Math.max(1, ...(summary?.byHour ?? []).map((h) => h.salesSen));

  return (
    <div className="body body-records">
      <section className="col">
        <div className="col-head">Rekod harian · 30 hari</div>
        <div className="col-scroll" data-testid="day-list">
          {days === null && <p className="empty">Memuat…</p>}
          {days?.length === 0 && (
            <p className="empty">Belum ada jualan direkodkan.</p>
          )}
          {days?.map((d) => (
            <button
              key={d.date}
              className="day-row"
              aria-pressed={d.date === picked}
              onClick={() => setPicked(d.date)}
            >
              <span className="day-date">
                {formatDay(d.date)}
                <small>
                  {d.billCount} bil · {d.itemCount} hidangan
                </small>
              </span>
              <span className="day-sales num">{formatMYR(d.salesSen)}</span>
            </button>
          ))}
          {days && days.length > 0 && (
            <div className="day-total">
              <span>Jumlah 30 hari</span>
              <span className="num">{formatMYR(total)}</span>
            </div>
          )}
        </div>
      </section>

      <section className="col">
        <div className="col-head">
          {picked ? formatDay(picked) : "Pilih satu hari"} · {outletName}
        </div>
        <div className="col-scroll" data-testid="day-detail">
          {picked && !summary && <p className="empty">Memuat…</p>}
          {summary && (
            <>
              <div className="stat-row">
                <div className="stat">
                  <span className="stat-label">Jualan</span>
                  <span className="stat-value num">
                    {formatMYR(summary.salesSen)}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Bil</span>
                  <span className="stat-value num">{summary.billCount}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Hidangan</span>
                  <span className="stat-value num">{summary.itemCount}</span>
                </div>
              </div>
              <p className="stat-note">
                Jualan, bukan untung — sistem belum tahu kos bahan.
              </p>

              <div className="zone-name">Mengikut jam</div>
              {summary.byHour.length === 0 && (
                <p className="empty">Tiada jualan hari ini.</p>
              )}
              {summary.byHour.map((h) => (
                <div className="hour-row" key={h.hour}>
                  <span className="hour-label num">
                    {String(h.hour).padStart(2, "0")}:00
                  </span>
                  <span className="hour-bar">
                    <span
                      className="hour-fill"
                      style={{ width: `${(h.salesSen / peak) * 100}%` }}
                    />
                  </span>
                  <span className="hour-sales num">
                    {formatMYR(h.salesSen)}
                  </span>
                </div>
              ))}

              <div className="zone-name">Hidangan paling laris</div>
              {summary.byItem.slice(0, 12).map((i) => (
                <div className="bill-line" key={i.menuItemId}>
                  <span className="ticket-qty num">{i.qty}×</span>
                  <span className="grow">{i.nameMs}</span>
                  <span className="num">{formatMYR(i.salesSen)}</span>
                </div>
              ))}

              <div className="zone-name">Mengikut kategori</div>
              {summary.byCategory.map((c) => (
                <div className="bill-line" key={c.categoryId}>
                  <span className="ticket-qty num">{c.qty}×</span>
                  <span className="grow">{c.nameMs}</span>
                  <span className="num">{formatMYR(c.salesSen)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/** "2026-08-18" → "18 Ogos 2026" — the owner reads dates, not ISO strings. */
function formatDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("ms-MY", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
