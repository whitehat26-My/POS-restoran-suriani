import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMYR } from "@suriani/core/money";
import { ulid } from "@suriani/core/ids";

import {
  api,
  printApi,
  type PrintHealth,
  type FloorTable,
  type MenuCategory,
  type MenuItem,
  type Outlet,
  type Ticket,
  type Zone,
} from "../api";
import { openLive, type LiveState } from "../live";
import { BillSheet } from "./BillSheet";
import { ItemConfig, type ConfiguredLine } from "./ItemConfig";

export function Till({ outlets }: { outlets: Outlet[] }) {
  const [outletId, setOutletId] = useState(outlets[0]!.id);
  const outlet = outlets.find((o) => o.id === outletId)!;

  const [live, setLive] = useState<LiveState>("connecting");
  const [zones, setZones] = useState<Zone[]>([]);
  const [tables, setTables] = useState<FloorTable[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [waiterTables, setWaiterTables] = useState<Set<string>>(new Set());
  const [billTable, setBillTable] = useState<string | null>(null);
  const [configItem, setConfigItem] = useState<MenuItem | null>(null);
  const [cart, setCart] = useState<ConfiguredLine[]>([]);
  const [pickTable, setPickTable] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [printHealth, setPrintHealth] = useState<PrintHealth | null>(null);
  const toastTimer = useRef<number>(undefined);

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // Feed + menu load on outlet switch; floor arrives with the WS snapshot.
  useEffect(() => {
    api.orders(outletId).then((r) =>
      setTickets(r.orders.filter((o) => o.status !== "voided").slice(0, 60)),
    );
    api.menu(outletId).then((r) => {
      setCategories(r.categories);
      setItems(r.items);
    });
    setCart([]);
    setBillTable(null);
  }, [outletId]);

  // The live socket. Snapshot replaces; deltas adjust.
  useEffect(() => {
    const handle = openLive(
      outletId,
      (event) => {
        switch (event.type) {
          case "snapshot": {
            setZones(event.zones as Zone[]);
            setTables(event.tables as FloorTable[]);
            break;
          }
          case "order.placed": {
            const orderId = event.orderId as string;
            setTickets((prev) =>
              prev.some((x) => x.id === orderId)
                ? prev
                : [
                    {
                      id: event.orderId as string,
                      sessionId: event.sessionId as string,
                      tableId: event.tableId as string,
                      tableLabel: event.tableLabel as string,
                      placedAt: event.placedAt as number,
                      status: "placed",
                      source: event.source as string,
                      totalSen: event.totalSen as number,
                      lines: event.lines as Ticket["lines"],
                    },
                    ...prev,
                  ],
            );
            setTables((prev) =>
              prev.map((tb) =>
                tb.id === event.tableId
                  ? {
                      ...tb,
                      status: "ordering",
                      session: tb.session
                        ? {
                            ...tb.session,
                            totalSen:
                              tb.session.totalSen + (event.totalSen as number),
                            orderCount: tb.session.orderCount + 1,
                          }
                        : {
                            id: event.sessionId as string,
                            openedAt: event.placedAt as number,
                            status: "open",
                            totalSen: event.totalSen as number,
                            orderCount: 1,
                          },
                    }
                  : tb,
              ),
            );
            break;
          }
          case "order.served": {
            setTickets((prev) =>
              prev.map((t) =>
                t.id === event.orderId ? { ...t, status: "served" } : t,
              ),
            );
            setTables((prev) =>
              prev.map((tb) =>
                tb.id === event.tableId && tb.status === "ordering"
                  ? { ...tb, status: "eating" }
                  : tb,
              ),
            );
            break;
          }
          case "bill.requested": {
            setTables((prev) =>
              prev.map((tb) =>
                tb.id === event.tableId
                  ? {
                      ...tb,
                      status: "bill_requested",
                      session: tb.session
                        ? { ...tb.session, status: "bill_requested" }
                        : tb.session,
                    }
                  : tb,
              ),
            );
            break;
          }
          case "waiter.called": {
            setWaiterTables((prev) => new Set(prev).add(event.tableId as string));
            say(`🔔 ${event.tableLabel as string} panggil pelayan`);
            window.setTimeout(() => {
              setWaiterTables((prev) => {
                const next = new Set(prev);
                next.delete(event.tableId as string);
                return next;
              });
            }, 60_000);
            break;
          }
          case "session.closed": {
            setTables((prev) =>
              prev.map((tb) =>
                tb.id === event.tableId
                  ? { ...tb, status: "empty", session: null }
                  : tb,
              ),
            );
            setTickets((prev) =>
              prev.filter((t) => t.sessionId !== event.sessionId),
            );
            break;
          }
          case "print.queued":
          case "print.printed":
            window.dispatchEvent(new Event("suriani:print"));
            break;
          case "print.failed": {
            window.dispatchEvent(new Event("suriani:print"));
            say(`🖨️ Cetakan GAGAL — ${event.tableLabel as string}`);
            break;
          }
          case "item.availability": {
            setItems((prev) =>
              prev.map((i) =>
                i.id === event.itemId
                  ? { ...i, isAvailable: event.available ? 1 : 0 }
                  : i,
              ),
            );
            break;
          }
        }
      },
      setLive,
    );
    return () => handle.close();
  }, [outletId, say]);

  // Printer health. Polled rather than pushed because it summarises a queue
  // rather than reporting an instant, and refreshed at once when a print
  // event arrives so a failure never waits for the next tick.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      printApi
        .health(outletId)
        .then((h) => !cancelled && setPrintHealth(h))
        .catch(() => {});
    void load();
    const timer = window.setInterval(load, 15_000);
    const onPrint = () => void load();
    window.addEventListener("suriani:print", onPrint);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("suriani:print", onPrint);
    };
  }, [outletId]);

  const tablesByZone = useMemo(() => {
    const map = new Map<string | null, FloorTable[]>();
    for (const t of tables) {
      const list = map.get(t.zoneId) ?? [];
      list.push(t);
      map.set(t.zoneId, list);
    }
    return map;
  }, [tables]);

  const pending = tickets.filter((t) => t.status === "placed");
  const cartTotal = cart.reduce((s, l) => s + l.lineSen, 0);

  const submitCart = async (tableId: string) => {
    setPickTable(false);
    try {
      await api.placeCounterOrder(
        outletId,
        tableId,
        cart.map((l) => ({
          menuItemId: l.menuItemId,
          qty: l.qty,
          notes: l.notes,
          modifierOptionIds: l.optionIds.length ? l.optionIds : undefined,
        })),
        ulid(),
      );
      setCart([]);
      say("Pesanan kaunter dihantar");
    } catch (err) {
      say(`Gagal: ${(err as Error).message}`);
    }
  };

  const toggle86 = async (item: MenuItem) => {
    const next = item.isAvailable === 0;
    try {
      await api.setAvailability(outletId, item.id, next);
      say(next ? `${item.nameMs} kembali dijual` : `${item.nameMs} — habis`);
    } catch {
      say("Gagal menukar status item");
    }
  };

  return (
    <div className="till">
      <div className="bar">
        <div className="bar-title">
          Suriani POS
          <small>{outlet.name}</small>
        </div>
        <div className="bar-right">
          {outlets.length > 1 &&
            outlets.map((o) => (
              <button
                key={o.id}
                className="pill"
                style={o.id === outletId ? { borderColor: "var(--enamel-lift)" } : undefined}
                onClick={() => setOutletId(o.id)}
              >
                {o.name.replace("Suriani ", "")}
              </button>
            ))}
          <span className="pill">
            <span className={`dot ${live === "live" ? "dot-ok" : "dot-warn"}`} />
            {live === "live" ? "Langsung" : "Menyambung…"}
          </span>
          {printHealth && (
            <span className="pill">
              <span
                className={`dot ${
                  printHealth.failed > 0 || printHealth.stalled
                    ? "dot-bad"
                    : printHealth.queued > 0
                      ? "dot-warn"
                      : "dot-ok"
                }`}
              />
              {printHealth.failed > 0
                ? `Pencetak: ${printHealth.failed} gagal`
                : printHealth.stalled
                  ? "Pencetak tersekat"
                  : printHealth.queued > 0
                    ? `Mencetak ${printHealth.queued}`
                    : "Pencetak OK"}
            </span>
          )}
        </div>
      </div>

      {printHealth && (printHealth.failed > 0 || printHealth.stalled) && (
        <div className="print-alarm" role="alert">
          <div className="print-alarm-head">
            {printHealth.stalled && printHealth.failed === 0
              ? "🖨️ Tiada cetakan keluar — periksa pencetak / ejen"
              : "🖨️ Cetakan dapur GAGAL"}
          </div>
          {printHealth.recent
            .filter((j) => j.status === "failed")
            .slice(0, 4)
            .map((j) => (
              <div className="print-alarm-row" key={j.id}>
                <span className="grow">
                  {j.tableLabel} · {j.target}
                  {j.lastError ? ` · ${j.lastError}` : ""}
                </span>
                <button
                  className="mini mini-go"
                  style={{ flex: "none", padding: "6px 12px" }}
                  onClick={() =>
                    printApi
                      .reprint(outletId, j.id)
                      .then(() => say("Cetak semula dihantar"))
                      .catch(() => say("Gagal cetak semula"))
                  }
                >
                  Cetak semula
                </button>
              </div>
            ))}
        </div>
      )}

      <div className="body">
        <section className="col">
          <div className="col-head">Pelan meja</div>
          <div className="col-scroll">
            {[...zones, { id: null as unknown as string, nameMs: zones.length ? "Lain-lain" : "", nameEn: "", sortOrder: 999 }]
              .filter((z) => (tablesByZone.get(z.id ?? null) ?? []).length > 0)
              .map((z) => (
                <div key={z.id ?? "none"}>
                  {z.nameMs && <div className="zone-name">{z.nameMs}</div>}
                  <div className="floor">
                    {(tablesByZone.get(z.id ?? null) ?? []).map((t) => (
                      <button
                        key={t.id}
                        className={`tbl ${waiterTables.has(t.id) ? "is-waiter" : ""}`}
                        data-state={t.status}
                        data-label={t.label}
                        onClick={() => setBillTable(t.id)}
                      >
                        <span className="tbl-code">{t.label.replace("Meja ", "M")}</span>
                        <span className="tbl-meta num">
                          {t.session ? formatMYR(t.session.totalSen) : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </section>

        <section className="col">
          <div className="col-head">Pesanan masuk</div>
          <div className="col-scroll" data-testid="feed">
            {pending.length === 0 && <p className="empty">Tiada pesanan menunggu.</p>}
            {pending.map((t) => (
              <article className="ticket" data-status={t.status} key={t.id}>
                <div className="ticket-head">
                  <span className="ticket-tbl">
                    {t.tableLabel}
                    {t.source === "counter" ? " · kaunter" : ""}
                  </span>
                  <span className="ticket-time">
                    {new Date(t.placedAt).toLocaleTimeString("ms-MY", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className="ticket-lines">
                  {t.lines.map((l, i) => (
                    <div className="ticket-line" key={i}>
                      <span className="ticket-qty">{l.qty}×</span>
                      <span>
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
                    </div>
                  ))}
                </div>
                <div className="ticket-acts">
                  <button
                    className="mini mini-go"
                    onClick={() =>
                      api.serve(outletId, t.id).catch(() => say("Gagal"))
                    }
                  >
                    Sudah dihidang
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="col">
          <div className="col-head">Menu · pesanan kaunter · 86</div>
          <div className="col-scroll">
            {categories.map((c) => (
              <div key={c.id}>
                <div className="zone-name">{c.nameMs}</div>
                {items
                  .filter((i) => i.categoryId === c.id)
                  .map((i) => (
                    <div className={`mi ${i.isAvailable === 0 ? "is-86" : ""}`} key={i.id}>
                      <button
                        className="mi-name"
                        disabled={i.isAvailable === 0}
                        onClick={() => setConfigItem(i)}
                      >
                        {i.nameMs}
                      </button>
                      <span className="mi-price num">{formatMYR(i.priceSen)}</span>
                      <button
                        className={`mi-86 ${i.isAvailable === 0 ? "is-on" : ""}`}
                        onClick={() => void toggle86(i)}
                      >
                        {i.isAvailable === 0 ? "HABIS" : "86"}
                      </button>
                    </div>
                  ))}
              </div>
            ))}
          </div>
          {cart.length > 0 && (
            <div style={{ padding: "12px 16px", borderTop: "1px solid var(--pos-edge)" }}>
              <button className="btn btn-accent" style={{ width: "100%" }} onClick={() => setPickTable(true)}>
                Hantar {cart.length} item · <span className="num">{formatMYR(cartTotal)}</span>
              </button>
            </div>
          )}
        </section>
      </div>

      {billTable && (
        <BillSheet
          outletId={outletId}
          tableId={billTable}
          onClose={() => setBillTable(null)}
          onSay={say}
        />
      )}

      {configItem && (
        <ItemConfig
          item={configItem}
          onClose={() => setConfigItem(null)}
          onAdd={(line) => {
            setCart((prev) => [...prev, line]);
            setConfigItem(null);
          }}
        />
      )}

      {pickTable && (
        <div className="veil" onClick={() => setPickTable(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <span className="sheet-title">Hantar ke meja mana?</span>
              <button className="sheet-x" onClick={() => setPickTable(false)}>×</button>
            </div>
            <div className="sheet-scroll">
              <div className="floor">
                {tables.map((t) => (
                  <button key={t.id} className="tbl" data-state={t.status} onClick={() => void submitCart(t.id)}>
                    <span className="tbl-code">{t.label.replace("Meja ", "M")}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
