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
  itemCount?: number;
  /**
   * cash | duitnow_qr | gateway — drives the drawer kick.
   *
   * Absent means the bill has not been settled yet: the customer asked for it,
   * the cashier printed it, and they will pay at the counter. That slip must
   * not claim a payment method it does not have, and must not kick a drawer
   * with nothing to put in it.
   */
  method?: string;
  cashReceivedSen?: number;
  /** Stamps SALINAN, so a second copy is never mistaken for a second sale. */
  reprint?: boolean;
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
  const paid = receipt.method !== undefined;
  const p = new EscPos().init();

  p.align("center");
  if (receipt.reprint) {
    p.bold(true).line("*** SALINAN ***").bold(false);
  }
  p.bold(true).size(2, 2);
  p.line(receipt.outletName.toUpperCase());
  p.size(1, 1).bold(false);
  p.line(paid ? "RESIT" : "BIL");
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
  if (receipt.itemCount !== undefined) {
    p.columns("Bilangan hidangan", String(receipt.itemCount), WIDTH);
  }
  p.size(1, 2).bold(true);
  p.columns("JUMLAH", `RM ${money(receipt.totalSen)}`, WIDTH / 2);
  p.bold(false).size(1, 1);

  if (paid) {
    const methodLabel =
      receipt.method === "cash"
        ? "TUNAI"
        : receipt.method === "duitnow_qr"
          ? "DUITNOW QR"
          : receipt.method!.toUpperCase();
    p.columns("Bayaran", methodLabel, WIDTH);
    if (receipt.cashReceivedSen !== undefined) {
      p.columns("Diterima", money(receipt.cashReceivedSen), WIDTH);
      p.columns("Baki", money(receipt.cashReceivedSen - receipt.totalSen), WIDTH);
    }
  }

  p.feed(1).align("center");
  if (paid) {
    p.line("Terima kasih!").line("Jumpa lagi");
  } else {
    p.line("Sila jelaskan di kaunter").line("Terima kasih!");
  }
  p.cut();

  // The drawer only opens for cash actually taken. A kick on a QR payment —
  // or on a bill nobody has paid yet — has the till springing open with
  // nothing to put in it.
  if (receipt.method === "cash") p.drawerKick();

  return p.bytes();
}

/**
 * The setup slip.
 *
 * The one docket rendered on the tablet rather than the server, because it
 * exists to answer a question the server cannot: can *this* device reach
 * *that* printer? During install nothing has been ordered yet, so there is no
 * real docket to send, and the point is to see paper come out before the
 * restaurant opens rather than during service.
 *
 * It says which station it came out of, because the commonest install mistake
 * is two printers swapped — the kitchen slip going to the counter is only
 * obvious if the slip names itself.
 */
export interface TestSlip {
  outletName: string;
  /** "kitchen" | "drinks" | "counter" — as the till labels the station. */
  stationName: string;
  at: Date;
}

export function renderTestSlip(slip: TestSlip): Uint8Array {
  const p = new EscPos();
  p.init().align("center");

  p.size(2, 2).bold(true).line("UJIAN").bold(false).size(1, 1);
  p.line(slip.outletName);
  p.feed(1);

  p.size(1, 2).line(slip.stationName.toUpperCase()).size(1, 1);
  p.feed(1);

  p.line(
    `${slip.at.getFullYear()}-${String(slip.at.getMonth() + 1).padStart(2, "0")}-` +
      `${String(slip.at.getDate()).padStart(2, "0")} ${timeOf(slip.at)}`,
  );
  p.feed(1);
  p.line("Pencetak ini sudah sedia.");
  p.cut();

  return p.bytes();
}
