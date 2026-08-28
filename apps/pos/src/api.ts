/**
 * Staff client. Auth rides the HttpOnly session cookie set by login — the
 * till never stores a token anywhere scripts can read.
 */
import type { Sen } from "@suriani/core/money";

import { authedFetch, setAuthToken } from "./base";

export interface Outlet {
  id: string;
  name: string;
}

export type Role = "owner" | "manager" | "cashier";

export interface DayRow {
  date: string;
  salesSen: Sen;
  orderCount: number;
  billCount: number;
  itemCount: number;
}

export interface DaySummary extends DayRow {
  byHour: { hour: number; salesSen: Sen; orderCount: number }[];
  byCategory: {
    categoryId: string;
    nameMs: string;
    nameEn: string;
    salesSen: Sen;
    qty: number;
  }[];
  byItem: {
    menuItemId: string;
    nameMs: string;
    nameEn: string;
    salesSen: Sen;
    qty: number;
  }[];
}

export interface Station {
  id: string;
  name: string;
  /** "kitchen" | "drinks" | "counter" — what kind of paper comes out. */
  target: string;
  enabled: number;
  isDefault: number;
  sortOrder: number;
}

export interface Zone {
  id: string;
  nameMs: string;
  nameEn: string;
  sortOrder: number;
}

export interface FloorTable {
  id: string;
  label: string;
  zoneId: string | null;
  capacity: number | null;
  sortOrder: number;
  status: string;
  session: {
    id: string;
    openedAt: number;
    status: string;
    totalSen: Sen;
    orderCount: number;
  } | null;
}

export interface TicketLine {
  qty: number;
  nameMs: string;
  nameEn: string;
  modifiers: { label: string; priceDeltaSen: Sen }[];
  notes: string | null;
}

export interface Ticket {
  id: string;
  sessionId: string;
  tableId: string;
  tableLabel: string;
  placedAt: number;
  status: string;
  source: string;
  totalSen: Sen;
  lines: TicketLine[];
}

export interface MenuOption {
  id: string;
  labelMs: string;
  labelEn: string;
  priceDeltaSen: Sen;
}

export interface MenuGroup {
  id: string;
  nameMs: string;
  nameEn: string;
  minSelect: number;
  maxSelect: number;
  options: MenuOption[];
}

export interface MenuItem {
  id: string;
  categoryId: string;
  nameMs: string;
  nameEn: string;
  priceSen: Sen;
  isAvailable: number;
  modifierGroups: MenuGroup[];
}

export interface MenuCategory {
  id: string;
  nameMs: string;
  nameEn: string;
  sortOrder: number;
}

export interface BillSheet {
  table: { id: string; label: string };
  session: {
    id: string;
    openedAt: number;
    status: string;
    totalSen: Sen;
    /** Plates on the table: what the counter wants to know first. */
    itemCount: number;
    orders: {
      id: string;
      placedAt: number;
      status: string;
      source: string;
      lines: {
        nameMs: string;
        nameEn: string;
        qty: number;
        lineSen: Sen;
        modifiers: { label: string; priceDeltaSen: Sen }[];
        notes: string | null;
      }[];
    }[];
  } | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  login: async (phone: string, pin: string) => {
    const result = await authedFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, pin }),
    }).then(
      json<{ token: string; user: { id: string; name: string; role: string } }>,
    );
    // The browser also gets an HttpOnly cookie and would work without this.
    // The tablet is cross-origin, so the token is the only thing it has.
    setAuthToken(result.token);
    return result;
  },

  outlets: () =>
    authedFetch("/api/outlets").then(json<{ role: Role; outlets: Outlet[] }>),

  floor: (outletId: string) =>
    authedFetch(`/api/outlets/${outletId}/floor`).then(
      json<{ zones: Zone[]; tables: FloorTable[] }>,
    ),

  orders: (outletId: string) =>
    authedFetch(`/api/outlets/${outletId}/orders`).then(json<{ orders: Ticket[] }>),

  menu: (outletId: string) =>
    authedFetch(`/api/outlets/${outletId}/menu`).then(
      json<{ categories: MenuCategory[]; items: MenuItem[] }>,
    ),

  bill: (outletId: string, tableId: string) =>
    authedFetch(`/api/outlets/${outletId}/tables/${tableId}/bill`).then(
      json<BillSheet>,
    ),

  dailySales: (outletId: string, days = 30) =>
    authedFetch(`/api/outlets/${outletId}/reports/daily?days=${days}`).then(
      json<{ days: DayRow[] }>,
    ),

  daySummary: (outletId: string, date: string) =>
    authedFetch(`/api/outlets/${outletId}/reports/daily/${date}`).then(
      json<DaySummary>,
    ),

  printReceipt: (outletId: string, sessionId: string) =>
    authedFetch(`/api/outlets/${outletId}/sessions/${sessionId}/receipt`, {
      method: "POST",
    }).then(json<{ ok: boolean; jobId: string; totalSen: Sen; itemCount: number }>),

  closeSession: (outletId: string, sessionId: string) =>
    authedFetch(`/api/outlets/${outletId}/sessions/${sessionId}/close`, {
      method: "POST",
    }).then(json<{ ok: boolean }>),

  stations: (outletId: string) =>
    authedFetch(`/api/outlets/${outletId}/print/stations`).then(
      json<{ stations: Station[] }>,
    ),

  /**
   * Mint an agent credential for this tablet.
   *
   * The token comes back once and is never readable again — only its hash is
   * stored — so the caller has to keep it or register another.
   */
  registerAgent: (outletId: string, name: string) =>
    authedFetch(`/api/outlets/${outletId}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then(json<{ deviceId: string; token: string }>),

};

/*
 * Counter orders, serve and 86 are deliberately absent here.
 *
 * They go through the outbox in offline.ts instead — one path whether the
 * line is up or down, so the offline case is the case that runs every day
 * rather than a rarely-exercised branch that only matters during an outage.
 */

export interface PrintHealth {
  queued: number;
  failed: number;
  stalled: boolean;
  oldestQueuedMs: number | null;
  recent: {
    id: string;
    status: string;
    target: string;
    tableLabel: string;
    attempts: number;
    lastError: string | null;
  }[];
}

export const printApi = {
  health: (outletId: string) =>
    authedFetch(`/api/outlets/${outletId}/print/health`).then(json<PrintHealth>),

  reprint: (outletId: string, jobId: string) =>
    authedFetch(`/api/outlets/${outletId}/print/jobs/${jobId}/reprint`, {
      method: "POST",
    }).then(json<{ ok: boolean }>),
};
