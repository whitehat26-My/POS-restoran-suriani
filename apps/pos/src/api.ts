/**
 * Staff client. Auth rides the HttpOnly session cookie set by login — the
 * till never stores a token anywhere scripts can read.
 */
import type { Sen } from "@suriani/core/money";

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
  login: (phone: string, pin: string) =>
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, pin }),
    }).then(json<{ user: { id: string; name: string; role: string } }>),

  outlets: () =>
    fetch("/api/outlets").then(json<{ role: Role; outlets: Outlet[] }>),

  floor: (outletId: string) =>
    fetch(`/api/outlets/${outletId}/floor`).then(
      json<{ zones: Zone[]; tables: FloorTable[] }>,
    ),

  orders: (outletId: string) =>
    fetch(`/api/outlets/${outletId}/orders`).then(json<{ orders: Ticket[] }>),

  menu: (outletId: string) =>
    fetch(`/api/outlets/${outletId}/menu`).then(
      json<{ categories: MenuCategory[]; items: MenuItem[] }>,
    ),

  bill: (outletId: string, tableId: string) =>
    fetch(`/api/outlets/${outletId}/tables/${tableId}/bill`).then(
      json<BillSheet>,
    ),

  serve: (outletId: string, orderId: string) =>
    fetch(`/api/outlets/${outletId}/orders/${orderId}/served`, {
      method: "POST",
    }).then(json<{ ok: boolean }>),

  dailySales: (outletId: string, days = 30) =>
    fetch(`/api/outlets/${outletId}/reports/daily?days=${days}`).then(
      json<{ days: DayRow[] }>,
    ),

  daySummary: (outletId: string, date: string) =>
    fetch(`/api/outlets/${outletId}/reports/daily/${date}`).then(
      json<DaySummary>,
    ),

  printReceipt: (outletId: string, sessionId: string) =>
    fetch(`/api/outlets/${outletId}/sessions/${sessionId}/receipt`, {
      method: "POST",
    }).then(json<{ ok: boolean; jobId: string; totalSen: Sen; itemCount: number }>),

  closeSession: (outletId: string, sessionId: string) =>
    fetch(`/api/outlets/${outletId}/sessions/${sessionId}/close`, {
      method: "POST",
    }).then(json<{ ok: boolean }>),

  setAvailability: (outletId: string, itemId: string, available: boolean) =>
    fetch(`/api/outlets/${outletId}/items/${itemId}/availability`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ available }),
    }).then(json<{ ok: boolean }>),

  placeCounterOrder: (
    outletId: string,
    tableId: string,
    lines: {
      menuItemId: string;
      qty: number;
      notes?: string;
      modifierOptionIds?: string[];
    }[],
    clientUlid: string,
  ) =>
    fetch(`/api/outlets/${outletId}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tableId, lines, clientUlid }),
    }).then(json<{ orderId: string; totalSen: Sen }>),
};

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
    fetch(`/api/outlets/${outletId}/print/health`).then(json<PrintHealth>),

  reprint: (outletId: string, jobId: string) =>
    fetch(`/api/outlets/${outletId}/print/jobs/${jobId}/reprint`, {
      method: "POST",
    }).then(json<{ ok: boolean }>),
};
