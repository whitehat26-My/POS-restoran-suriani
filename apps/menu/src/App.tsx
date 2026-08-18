import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMYR } from "@suriani/core/money";

import {
  callWaiter,
  fetchStatus,
  fetchTablePage,
  placeOrder,
  requestBill,
  TableNotFoundError,
  type MenuItem,
  type TablePage,
} from "./api";
import {
  appendPlaced,
  cartTotalSen,
  clearCart,
  ensurePendingUlid,
  loadCart,
  loadPlaced,
  newLine,
  saveCart,
  type CartState,
  type PlacedSummary,
} from "./cart";
import { initialLang, makeT, persistLang, type Lang, type Key } from "./i18n";
import { MenuScreen } from "./screens/MenuScreen";
import { ItemSheet } from "./screens/ItemSheet";
import { CartScreen } from "./screens/CartScreen";
import { PlacedScreen } from "./screens/PlacedScreen";

/** /t/:outletId/:qrToken — the URL printed on the table card. */
function parsePath(): { outletId: string; qrToken: string } | null {
  const m = location.pathname.match(/^\/t\/([^/]+)\/([^/]+)\/?$/);
  return m ? { outletId: m[1]!, qrToken: m[2]! } : null;
}

type View = "menu" | "cart" | "placed";

export function App() {
  const path = useMemo(parsePath, []);
  const [lang, setLang] = useState<Lang>(initialLang);
  const t = useMemo(() => makeT(lang), [lang]);

  const [page, setPage] = useState<TablePage | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [offline, setOffline] = useState(false);

  const [cart, setCart] = useState<CartState>({ lines: [], pendingUlid: null });
  const [placed, setPlaced] = useState<PlacedSummary[]>([]);
  const [view, setView] = useState<View>("menu");
  const [activeItem, setActiveItem] = useState<MenuItem | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Key | null>(null);
  const [stage, setStage] = useState<1 | 2 | 3>(1);
  const [billRequested, setBillRequested] = useState(false);
  const [waiterCalled, setWaiterCalled] = useState(false);
  const menuVersionRef = useRef<number | null>(null);

  useEffect(() => {
    if (!path) {
      setNotFound(true);
      return;
    }
    setCart(loadCart(path.qrToken));
    setPlaced(loadPlaced(path.qrToken));
    fetchTablePage(path.outletId, path.qrToken)
      .then((p) => {
        setPage(p);
        setOffline(false);
      })
      .catch((err) => {
        if (err instanceof TableNotFoundError) setNotFound(true);
        // A network failure with a service-worker cache still resolves the
        // fetch; reaching here means we are offline with nothing cached.
        else setOffline(true);
      });
  }, [path]);

  // The status poll: every ~12s while an order exists and the tab is
  // visible. Cheap on purpose — a WebSocket per customer phone would open a
  // long-lived surface to strangers and buy nothing at this cadence.
  useEffect(() => {
    if (!path || placed.length === 0) return;

    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const status = await fetchStatus(path.outletId, path.qrToken);
        if (cancelled) return;

        if (status.session) {
          const orders = status.session.orders;
          const allServed =
            orders.length > 0 && orders.every((o) => o.status === "served");
          const anyCooking = orders.some((o) => o.status === "printed");
          setStage(allServed ? 3 : anyCooking ? 2 : 1);
          setBillRequested(status.session.status === "bill_requested");
        }

        // A moved menuVersion means the kedai changed something — an item
        // 86'd, a price fixed. Refetch quietly so this phone matches reality.
        if (
          menuVersionRef.current !== null &&
          status.menuVersion !== menuVersionRef.current
        ) {
          fetchTablePage(path.outletId, path.qrToken).then(setPage, () => {});
        }
        menuVersionRef.current = status.menuVersion;
      } catch {
        /* a failed poll is silence, not an error banner */
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [path, placed.length]);

  const doBill = useCallback(() => {
    if (!path) return;
    requestBill(path.outletId, path.qrToken)
      .then(() => setBillRequested(true))
      .catch(() => setError("error_generic"));
  }, [path]);

  const doWaiter = useCallback(() => {
    if (!path) return;
    callWaiter(path.outletId, path.qrToken)
      .then(() => {
        setWaiterCalled(true);
        window.setTimeout(() => setWaiterCalled(false), 60_000);
      })
      .catch(() => setError("error_generic"));
  }, [path]);

  const switchLang = useCallback((next: Lang) => {
    persistLang(next);
    setLang(next);
    document.documentElement.lang = next;
  }, []);

  const updateCart = useCallback(
    (next: CartState) => {
      setCart(next);
      if (path) saveCart(path.qrToken, next);
    },
    [path],
  );

  const addLine = useCallback(
    (item: MenuItem, qty: number, optionIds: string[], notes?: string) => {
      updateCart({
        ...cart,
        lines: [...cart.lines, newLine(item, qty, optionIds, notes)],
      });
      setActiveItem(null);
    },
    [cart, updateCart],
  );

  const submit = useCallback(async () => {
    if (!path || !page || cart.lines.length === 0 || sending) return;
    setSending(true);
    setError(null);

    // Minted once and persisted; a retry reuses it, so the server can never
    // be tricked into two orders by a double tap or a flaky connection.
    const clientUlid = ensurePendingUlid(cart);
    updateCart({ ...cart, pendingUlid: clientUlid });

    try {
      const result = await placeOrder(
        path.outletId,
        path.qrToken,
        cart.lines.map((l) => ({
          menuItemId: l.menuItemId,
          qty: l.qty,
          notes: l.notes,
          modifierOptionIds: l.optionIds.length ? l.optionIds : undefined,
        })),
        clientUlid,
      );

      const items = new Map(page.menu.items.map((i) => [i.id, i]));
      const summary: PlacedSummary = {
        orderId: result.orderId,
        totalSen: result.totalSen,
        at: Date.now(),
        etaMin: Math.max(
          ...cart.lines.map((l) => items.get(l.menuItemId)?.prepMinutes ?? 10),
        ),
        lines: cart.lines.map((l) => {
          const item = items.get(l.menuItemId);
          return {
            name: lang === "ms" ? item?.nameMs ?? "?" : item?.nameEn ?? "?",
            qty: l.qty,
            sen: 0,
          };
        }),
      };
      setPlaced(appendPlaced(path.qrToken, summary));
      clearCart(path.qrToken);
      setCart({ lines: [], pendingUlid: null });
      setView("placed");
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message === "option_required" || message === "too_many_options") {
        setError("error_option_required");
      } else if (message === "unavailable") {
        setError("error_unavailable");
        // The menu moved under us — refresh so the 86'd item disappears.
        fetchTablePage(path.outletId, path.qrToken).then(setPage, () => {});
      } else {
        setError("error_generic");
      }
    } finally {
      setSending(false);
    }
  }, [path, page, cart, sending, lang, updateCart]);

  if (notFound) {
    return (
      <div className="app">
        <div className="notfound">
          <h1>{t("not_found_title")}</h1>
          <p>{t("not_found_body")}</p>
        </div>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="app">
        {offline && <div className="offline-note">{t("offline_note")}</div>}
      </div>
    );
  }

  const totalSen = cartTotalSen(cart.lines, page.menu.items);
  const count = cart.lines.reduce((n, l) => n + l.qty, 0);

  return (
    <div className="app">
      <header className="top">
        <div className="top-row">
          <div>
            <div className="shop">{page.outlet.name}</div>
            <div className="table-tag">
              <span className="num">{page.table.label}</span>
            </div>
          </div>
          <div className="lang-swap" role="group" aria-label="Language">
            <button aria-pressed={lang === "ms"} onClick={() => switchLang("ms")}>
              BM
            </button>
            <button aria-pressed={lang === "en"} onClick={() => switchLang("en")}>
              EN
            </button>
          </div>
        </div>
      </header>

      {offline && <div className="offline-note">{t("offline_note")}</div>}
      {error && <div className="error-note" role="alert">{t(error)}</div>}

      {view === "menu" && (
        <MenuScreen
          page={page}
          lang={lang}
          t={t}
          placed={placed}
          stage={stage}
          billRequested={billRequested}
          waiterCalled={waiterCalled}
          onBill={doBill}
          onWaiter={doWaiter}
          onPick={setActiveItem}
        />
      )}
      {view === "cart" && (
        <CartScreen
          page={page}
          lang={lang}
          t={t}
          cart={cart}
          sending={sending}
          onRemove={(lineId) =>
            updateCart({ ...cart, lines: cart.lines.filter((l) => l.lineId !== lineId) })
          }
          onBack={() => setView("menu")}
          onSubmit={submit}
        />
      )}
      {view === "placed" && (
        <PlacedScreen
          t={t}
          lang={lang}
          placed={placed}
          stage={stage}
          billRequested={billRequested}
          waiterCalled={waiterCalled}
          onBill={doBill}
          onWaiter={doWaiter}
          onMore={() => setView("menu")}
        />
      )}

      {view === "menu" && (
        <div className={`cart-bar ${count > 0 ? "is-up" : ""}`}>
          <div className="cart-count num">{count}</div>
          <div className="cart-total">
            <small>{t("cart_label")}</small>
            <strong className="num">{formatMYR(totalSen)}</strong>
          </div>
          <button className="btn btn-accent" onClick={() => setView("cart")}>
            {t("view_cart")}
          </button>
        </div>
      )}

      {activeItem && (
        <ItemSheet
          item={activeItem}
          lang={lang}
          t={t}
          onClose={() => setActiveItem(null)}
          onAdd={addLine}
        />
      )}
    </div>
  );
}
