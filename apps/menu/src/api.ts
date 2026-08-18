/**
 * Typed client for the customer endpoints. The QR token in the URL is the
 * only authorisation — there is no login on this surface.
 */

export interface MenuOption {
  id: string;
  labelMs: string;
  labelEn: string;
  priceDeltaSen: number;
}

export interface MenuModifierGroup {
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
  descMs: string | null;
  descEn: string | null;
  priceSen: number;
  tags: string[];
  isAvailable: number;
  prepMinutes: number;
  modifierGroups: MenuModifierGroup[];
}

export interface MenuCategory {
  id: string;
  nameMs: string;
  nameEn: string;
  sortOrder: number;
}

export interface TablePage {
  outlet: { name: string };
  table: { label: string };
  menu: { categories: MenuCategory[]; items: MenuItem[] };
}

export interface PlacedOrder {
  orderId: string;
  totalSen: number;
  duplicate: boolean;
}

export class TableNotFoundError extends Error {}

export async function fetchTablePage(
  outletId: string,
  qrToken: string,
): Promise<TablePage> {
  const res = await fetch(`/api/t/${outletId}/${qrToken}`);
  if (res.status === 404) throw new TableNotFoundError();
  if (!res.ok) throw new Error(`menu fetch failed: ${res.status}`);
  return res.json();
}

export interface OrderLineInput {
  menuItemId: string;
  qty: number;
  notes?: string;
  modifierOptionIds?: string[];
}

export async function placeOrder(
  outletId: string,
  qrToken: string,
  lines: OrderLineInput[],
  clientUlid: string,
): Promise<PlacedOrder> {
  const res = await fetch(`/api/t/${outletId}/${qrToken}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines, clientUlid }),
  });
  if (res.status === 404) throw new TableNotFoundError();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `order failed: ${res.status}`);
  }
  return res.json();
}

export interface SessionStatus {
  menuVersion: number;
  table: { label: string; status: string };
  session: {
    status: string;
    totalSen: number;
    orders: { id: string; status: string; placedAt: number }[];
  } | null;
}

export async function fetchStatus(
  outletId: string,
  qrToken: string,
): Promise<SessionStatus> {
  const res = await fetch(`/api/t/${outletId}/${qrToken}/status`);
  if (res.status === 404) throw new TableNotFoundError();
  if (!res.ok) throw new Error(`status failed: ${res.status}`);
  return res.json();
}

export async function requestBill(outletId: string, qrToken: string) {
  const res = await fetch(`/api/t/${outletId}/${qrToken}/bill-request`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`bill request failed: ${res.status}`);
}

export async function callWaiter(outletId: string, qrToken: string) {
  const res = await fetch(`/api/t/${outletId}/${qrToken}/call-waiter`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`call failed: ${res.status}`);
}
