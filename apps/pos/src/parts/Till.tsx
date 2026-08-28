import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMYR } from "@suriani/core/money";
import { shortLabel } from "@suriani/core/menu";

import {
  api,
  printApi,
  type PrintHealth,
  type FloorTable,
  type MenuCategory,
  type MenuItem,
  type Outlet,
  type Role,
  type Ticket,
  type Zone,
} from "../api";
import { openLive, type LiveState } from "../live";
import { openOfflineTill, type OfflineTill } from "../offline";
import { openLocalServer, type LocalOrderRecord, type LocalServer } from "../local";
import { startLocalServer, type RunningServer } from "../localbridge";
import {
  isTablet,
  loadAgent,
  printOrderDockets,
  printPendingJobs,
  sendHeartbeat,
} from "../print";
import { BillSheet } from "./BillSheet";
import { Devices } from "./Devices";
import { ItemConfig, type ConfiguredLine } from "./ItemConfig";
import { Records } from "./Records";

export function Till({ outlets, role }: { outlets: Outlet[]; role: Role }) {
  const [outletId, setOutletId] = useState(outlets[0]!.id);
  const outlet = outlets.find((o) => o.id === outletId)!;

  // The daily record is the owner's, not the counter's. Hidden rather than
  // shown-and-403'd, because a button that always fails is worse than no
  // button — but the server gate is what actually enforces it.
  const manages = role === "owner" || role === "manager";
  const [view, setView] = useState<"floor" | "records" | "devices">("floor");

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
  // 147 dishes in one scroll is unusable at a counter mid-service.
  const [menuQuery, setMenuQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [printHealth, setPrintHealth] = useState<PrintHealth | null>(null);
  const [pendingOps, setPendingOps] = useState(0);
  const [queueStuck, setQueueStuck] = useState(false);
  const offline = useRef<OfflineTill | null>(null);
  const local = useRef<LocalServer | null>(null);
  // Orders taken on customers' phones through the tablet's own server, which
  // the till has not yet seen come back from the cloud. During an outage this
  // is the only place they appear, and a cashier who cannot see what the
  // kitchen is cooking is a cashier who cannot run the floor.
  const [localOrders, setLocalOrders] = useState<LocalOrderRecord[]>([]);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const toastTimer = useRef<number>(undefined);

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // The outbox. Every action the cashier takes is written here before it is
  // sent, so pulling the plug between the tap and the request loses nothing
  // and an outage costs latency rather than orders.
  useEffect(() => {
    const till = openOfflineTill(
      outletId,
      (_state, report) => {
        setPendingOps(report.pending);
        setQueueStuck(report.pending > 0);
      },
      (rejected) => {
        // An op the server will never accept: the table was archived, the
        // dish deleted. It is dropped so the queue behind it keeps moving,
        // but the cashier has to be told, because a customer is waiting.
        say(`⚠️ ${rejected.length} tindakan ditolak — sila semak`);
      },
    );
    offline.current = till;
    if (!till.durable) {
      say("Amaran: simpanan luar talian tidak tersedia pada peranti ini");
    }
    void till.pending().then(setPendingOps);
    return () => {
      till.stop();
      offline.current = null;
    };
  }, [outletId, say]);

  // The tablet is its own print agent.
  //
  // In a browser this never runs: a WebView cannot open a socket to a printer,
  // which is the entire reason the till is a native app. On the tablet it
  // claims its own jobs and prints them over the LAN, falling back to
  // Bluetooth when the router dies — the one failure mode a cloud POS cannot
  // survive.
  //
  // Three seconds, and no back-off on failure: a job that cannot print is
  // already walking the server's own retry schedule, and the kitchen waiting
  // an extra round because the till decided to be polite is the wrong trade.
  useEffect(() => {
    if (!isTablet()) return;

    let stopped = false;
    let sinceHeartbeat = 0;
    const round = async () => {
      // Read fresh every round rather than capturing it: registering or
      // forgetting the agent on the Peranti tab then takes effect within
      // three seconds, instead of leaving the till printing with a
      // credential the installer thinks they just removed.
      const agent = loadAgent();
      if (!agent) return;
      try {
        await printPendingJobs(agent.token);
      } catch {
        // Unreachable server. The queue is on the server, so nothing is lost
        // and the next round picks it up; the print-health pill is what tells
        // the cashier the kitchen has gone quiet.
      }
      // Roughly once a minute, so the control plane can tell an unplugged
      // printer from a tablet that has been off since Tuesday.
      if (++sinceHeartbeat >= 20) {
        sinceHeartbeat = 0;
        await sendHeartbeat(agent.token);
      }
    };

    void round();
    const timer = window.setInterval(() => {
      if (!stopped) void round();
    }, 3_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // The agent credential is per device, not per outlet: restarting the loop
    // on an outlet switch would achieve nothing.
  }, []);

  // The tablet's own web server, and the cache that makes it possible.
  //
  // Opened in a browser too, deliberately. Nothing listens on a socket there,
  // but the cache refresh and the ordering path are the same code, so the
  // parts that decide what a customer can do are exercised on every dev run
  // rather than only inside an APK.
  useEffect(() => {
    const till = offline.current;
    if (!till) return;
    const server = openLocalServer(outlet, till, (records, added) => {
      setLocalOrders([...records].reverse());
      if (added) say(`📱 ${added.tableLabel} pesan dari telefon`);
    });
    local.current = server;

    // Listen, if there is a socket to listen on.
    //
    // Always, never only during an outage. There is no mode to detect and no
    // switchover to fail at the worst possible moment — there are simply two
    // doors into the menu and both are open all day, which also means the
    // local one is exercised every day rather than first thing in a crisis.
    let listening: RunningServer | null = null;
    if (isTablet()) {
      startLocalServer(server.handle).then(
        (running) => {
          listening = running;
          setLocalUrl(running.url);
        },
        () => {
          // Not on WiFi, or the service was refused. The till is unaffected;
          // only the outage door failed to open, and the Peranti tab says so.
          setLocalUrl(null);
        },
      );
    }

    return () => {
      void listening?.stop();
      server.stop();
      local.current = null;
    };
    // outlet.id is what identifies the cache; the name only labels a docket.
  }, [outlet, say]);

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

  const q = menuQuery.trim().toLowerCase();
  const shown = q
    ? items.filter(
        (i) =>
          i.nameMs.toLowerCase().includes(q) || i.nameEn.toLowerCase().includes(q),
      )
    : items;

  const submitCart = async (tableId: string) => {
    setPickTable(false);
    const till = offline.current;
    if (!till) return;

    const table = tables.find((t) => t.id === tableId);
    const snapshot = local.current?.cache();

    // The tablet prints its own dockets, whether or not the line is up.
    //
    // It is the print agent for this restaurant, so routing an order it took
    // itself through the cloud only hands the job back to this device. Doing
    // it directly is faster, and — the reason it matters — it is the same
    // path during an outage, so it is exercised every day rather than only in
    // the emergency it exists for. In a browser there is no printer to reach,
    // this reports failure, and the server queues the docket exactly as it
    // always has.
    let printed = { ok: false };
    if (table && snapshot) {
      printed = await printOrderDockets({
        outletName: outlet.name,
        tableLabel: table.label,
        orderCode: `#${Date.now().toString(36).slice(-5).toUpperCase()}`,
        placedAt: new Date(),
        lines: cart.map((l) => ({
          menuItemId: l.menuItemId,
          qty: l.qty,
          name: l.nameMs,
          modifiers: l.optionLabels,
          notes: l.notes ?? null,
        })),
        stations: local.current!.stations(),
        categoryByItem: new Map(snapshot.items.map((i) => [i.id, i.categoryId])),
      });
    }

    await till.perform({
      kind: "order.place",
      tableId,
      lines: cart.map((l) => ({
        menuItemId: l.menuItemId,
        qty: l.qty,
        notes: l.notes,
        modifierOptionIds: l.optionIds.length ? l.optionIds : undefined,
      })),
      expectedTotalSen: cartTotal,
      printedLocally: printed.ok,
    });
    setCart([]);
    setPendingOps(await till.pending());
    // The order exists on this tablet either way. It reaches the kitchen now
    // if the line is up, and the moment it returns if it is not.
    say(printed.ok ? "Pesanan kaunter dicetak" : "Pesanan kaunter direkod");
  };

  const toggle86 = async (item: MenuItem) => {
    const next = item.isAvailable === 0;
    const till = offline.current;
    if (!till) return;
    // Optimistic: the cashier is looking at an empty pot, so the menu column
    // should agree with them immediately rather than after a round trip.
    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, isAvailable: next ? 1 : 0 } : i)),
    );
    await till.perform({
      kind: "item.availability",
      itemId: item.id,
      available: next,
    });
    setPendingOps(await till.pending());
    say(next ? `${item.nameMs} kembali dijual` : `${item.nameMs} — habis`);
  };

  return (
    <div className="till">
      <div className="bar">
        <div className="bar-title">
          Suriani POS
          <small>{outlet.name}</small>
        </div>
        <div className="bar-right">
          {manages && (
            <>
              <button
                className="pill"
                aria-pressed={view === "floor"}
                onClick={() => setView("floor")}
              >
                Kaunter
              </button>
              <button
                className="pill"
                aria-pressed={view === "records"}
                data-testid="tab-records"
                onClick={() => setView("records")}
              >
                Rekod
              </button>
              <button
                className="pill"
                aria-pressed={view === "devices"}
                data-testid="tab-devices"
                onClick={() => setView("devices")}
              >
                Peranti
              </button>
            </>
          )}
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
          {pendingOps > 0 && (
            <button
              className="pill"
              data-testid="outbox-pill"
              title="Tindakan menunggu dihantar. Tekan untuk cuba lagi."
              onClick={() => offline.current?.nudge()}
            >
              <span className={`dot ${queueStuck ? "dot-warn" : "dot-ok"}`} />
              {pendingOps} menunggu
            </button>
          )}
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

      {view === "records" ? (
        <Records outletId={outletId} outletName={outlet.name} onSay={say} />
      ) : view === "devices" ? (
        <Devices
          outletId={outletId}
          outletName={outlet.name}
          localUrl={localUrl}
          onSay={say}
        />
      ) : (
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
            {pending.length === 0 && localOrders.length === 0 && (
              <p className="empty">Tiada pesanan menunggu.</p>
            )}

            {/* Orders taken on a customer's phone through this tablet, before
                the server has confirmed them. During an outage they exist
                nowhere else, and a cashier who cannot see what the kitchen is
                cooking cannot run the floor. They disappear on their own once
                the op syncs and the server's real ticket takes over. */}
            {localOrders.map((r) => (
              <article className="ticket is-local" key={r.clientUlid}>
                <div className="ticket-head">
                  <span className="ticket-tbl">
                    {r.tableLabel} · telefon
                    {r.printed ? "" : " · TIDAK BERCETAK"}
                  </span>
                  <span className="ticket-time">
                    {new Date(r.placedAt).toLocaleTimeString("ms-MY", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className="ticket-lines">
                  {r.lines.map((l, i) => (
                    <div className="ticket-line" key={i}>
                      <span className="ticket-qty">{l.qty}×</span>
                      <span>
                        {l.name}
                        {(l.modifiers.length > 0 || l.notes) && (
                          <span className="ticket-note">
                            {" "}
                            {[...l.modifiers, l.notes].filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="ticket-acts">
                  <span className="ticket-note">
                    Menunggu talian · {formatMYR(r.totalSen)}
                  </span>
                </div>
              </article>
            ))}

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
                    onClick={() => {
                      // Optimistic, then queued: a plate that has left the
                      // kitchen has left it whether the wifi agrees or not.
                      setTickets((prev) =>
                        prev.map((x) =>
                          x.id === t.id ? { ...x, status: "served" } : x,
                        ),
                      );
                      void offline.current
                        ?.perform({ kind: "order.serve", orderId: t.id })
                        .then(async () =>
                          setPendingOps((await offline.current?.pending()) ?? 0),
                        );
                    }}
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
          <input
            className="menu-search"
            placeholder="Cari hidangan…"
            value={menuQuery}
            data-testid="menu-search"
            onChange={(e) => setMenuQuery(e.target.value)}
          />
          <div className="col-scroll">
            {shown.length === 0 && <p className="empty">Tiada hidangan sepadan.</p>}
            {categories.map((c) => {
              const inCategory = shown.filter((i) => i.categoryId === c.id);
              if (inCategory.length === 0) return null;
              return (
                <div key={c.id}>
                  <div className="zone-name">{c.nameMs}</div>
                  {inCategory.map((i) => (
                    <div className={`mi ${i.isAvailable === 0 ? "is-86" : ""}`} key={i.id}>
                      <button
                        className="mi-name"
                        disabled={i.isAvailable === 0}
                        onClick={() => setConfigItem(i)}
                        title={i.nameMs}
                      >
                        {shortLabel(i.nameMs, c.nameMs)}
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
              );
            })}
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
      )}

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
