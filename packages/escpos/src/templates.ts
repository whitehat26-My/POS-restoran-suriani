/**
 * Ticket layouts.
 *
 * Rendered on the server, never on the device, so a layout fix ships with a
 * deploy instead of requiring someone to update software installed in a
 * restaurant. It also means every docket the kitchen will ever see is under
 * byte-level test.
 */
import { EscPos, wrap } from "./index";

/** 42 columns is standard for 80mm paper at Font A. */
const WIDTH = 42;

export interface TicketLine {
  qty: number;
  name: string;
  /** Resolved option labels — "Tambah telur", "Kurang pedas". */
  modifiers: string[];
  notes: string | null;
}

export interface KitchenTicket {
  outletName: string;
  stationName: string;
  tableLabel: string;
  /** Short human code the till and the slip share, for reprints. */
  orderCode: string;
  placedAt: Date;
  lines: TicketLine[];
  reprint?: boolean;
}

function timeOf(at: Date): string {
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * The kitchen docket.
 *
 * Deliberately carries no prices: a cook does not need them and they crowd the
 * slip. The table label is double-height and double-width because it is read
 * at arm's length across a hot kitchen, often at a glance.
 */
export function renderKitchenTicket(ticket: KitchenTicket): Uint8Array {
  const p = new EscPos().init();

  p.align("center");
  if (ticket.reprint) {
    p.bold(true).line("*** CETAK SEMULA ***").bold(false);
  }
  p.line(ticket.stationName.toUpperCase());
  p.size(1, 1);

  p.align("center").size(2, 2).bold(true);
  p.line(ticket.tableLabel.toUpperCase());
  p.bold(false).size(1, 1);

  p.align("center").line(`${ticket.orderCode}   ${timeOf(ticket.placedAt)}`);
  p.align("left").rule(WIDTH);

  for (const line of ticket.lines) {
    // Quantity in double height: the number that decides how many plates
    // leave the kitchen should be the hardest thing on the slip to misread.
    const qty = `${line.qty}x `;
    const nameWidth = WIDTH - qty.length;
    const wrapped = wrap(line.name.toUpperCase(), nameWidth);

    p.size(1, 2).bold(true);
    p.line(qty + wrapped[0]);
    for (const extra of wrapped.slice(1)) {
      p.line(" ".repeat(qty.length) + extra);
    }
    p.bold(false).size(1, 1);

    for (const modifier of line.modifiers) {
      p.line(`    + ${modifier}`);
    }
    if (line.notes) {
      for (const noteLine of wrap(line.notes, WIDTH - 8)) {
        p.line(`    ** ${noteLine}`);
      }
    }
    p.feed(1);
  }

  p.rule(WIDTH);
  p.align("center").line(ticket.outletName);
  return p.cut().bytes();
}

export interface ReceiptLine {
  qty: number;
  name: string;
  modifiers: { label: string; priceDeltaSen: number }[];
  lineSen: number;
}

export interface Receipt {
  outletName: string;
  tableLabel: string;
  orderCode: string;
  paidAt: Date;
  lines: ReceiptLine[];
  totalSen: number;
  /** cash | duitnow_qr | gateway — drives the drawer kick. */
  method: string;
  cashReceivedSen?: number;
}

function money(sen: number): string {
  const negative = sen < 0;
  const abs = Math.abs(sen);
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * The counter receipt. Phase 6 uses this unchanged for payments; it lands now
 * so the layout is settled and tested before money depends on it.
 */
export function renderReceipt(receipt: Receipt): Uint8Array {
  const p = new EscPos().init();

  p.align("center").bold(true).size(2, 2);
  p.line(receipt.outletName.toUpperCase());
  p.size(1, 1).bold(false);
  p.line(`${receipt.tableLabel}   ${receipt.orderCode}`);
  p.line(receipt.paidAt.toISOString().slice(0, 16).replace("T", " "));
  p.align("left").rule(WIDTH);

  for (const line of receipt.lines) {
    const label = `${line.qty}x ${line.name}`;
    const wrapped = wrap(label, WIDTH - 10);
    p.columns(wrapped[0]!, money(line.lineSen), WIDTH);
    for (const extra of wrapped.slice(1)) p.line(`   ${extra}`);
    for (const modifier of line.modifiers) {
      p.columns(
        `   + ${modifier.label}`,
        modifier.priceDeltaSen ? money(modifier.priceDeltaSen) : "",
        WIDTH,
      );
    }
  }

  p.rule(WIDTH);
  p.size(1, 2).bold(true);
  p.columns("JUMLAH", `RM ${money(receipt.totalSen)}`, WIDTH / 2);
  p.bold(false).size(1, 1);

  const methodLabel =
    receipt.method === "cash"
      ? "TUNAI"
      : receipt.method === "duitnow_qr"
        ? "DUITNOW QR"
        : receipt.method.toUpperCase();
  p.columns("Bayaran", methodLabel, WIDTH);
  if (receipt.cashReceivedSen !== undefined) {
    p.columns("Diterima", money(receipt.cashReceivedSen), WIDTH);
    p.columns("Baki", money(receipt.cashReceivedSen - receipt.totalSen), WIDTH);
  }

  p.feed(1).align("center").line("Terima kasih!").line("Jumpa lagi");
  p.cut();

  // The drawer only opens for cash. A kick on a QR payment would have the
  // till springing open with nothing to put in it.
  if (receipt.method === "cash") p.drawerKick();

  return p.bytes();
}
