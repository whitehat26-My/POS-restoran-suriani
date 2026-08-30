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
  /** Cash: what the customer handed over. */
  cashReceivedSen?: number;
  /** What was handed back. Derived from the tender when absent. */
  changeSen?: number;
  /** Monotonic per outlet, printed so a slip can be found again. */
  receiptNo?: number;
  /** Taken off the bill without anybody paying it. */
  discountSen?: number;
  /** The 5 sen cash adjustment, signed. */
  roundingSen?: number;
  /** This payment's own amount. Only differs from the total on a split. */
  paidSen?: number;
  /**
   * Still owed after this payment.
   *
   * Above zero turns the slip into a part-payment receipt: the header says
   * BAYARAN SEPARA and the balance is printed, so somebody who has paid their
   * share of a split has paper proving it and the table knows what is left.
   */
  balanceSen?: number;
  /** Stamps SALINAN, so a second copy is never mistaken for a second sale. */
  reprint?: boolean;
}

function money(sen: number): string {
  const negative = sen < 0;
  const abs = Math.abs(sen);
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * The counter slip, in its three forms.
 *
 * No method: an unpaid BIL, printed because the customer asked for it.
 * A method and a balance: BAYARAN SEPARA, somebody's share of a split.
 * A method and no balance: a RESIT, and the bill is closed.
 */
export function renderReceipt(receipt: Receipt): Uint8Array {
  const paid = receipt.method !== undefined;
  const partial = paid && (receipt.balanceSen ?? 0) > 0;
  // What was actually owed: the food, less any discount, plus the cash
  // rounding. Change is worked out against this rather than against the
  // total, because a discounted or rounded bill would otherwise hand back
  // the wrong money.
  const dueSen =
    receipt.totalSen - (receipt.discountSen ?? 0) + (receipt.roundingSen ?? 0);
  const p = new EscPos().init();

  p.align("center");
  if (receipt.reprint) {
    p.bold(true).line("*** SALINAN ***").bold(false);
  }
  p.bold(true).size(2, 2);
  p.line(receipt.outletName.toUpperCase());
  p.size(1, 1).bold(false);
  p.line(partial ? "BAYARAN SEPARA" : paid ? "RESIT" : "BIL");
  p.line(`${receipt.tableLabel}   ${receipt.orderCode}`);
  if (receipt.receiptNo !== undefined) {
    p.line(`No. ${String(receipt.receiptNo).padStart(6, "0")}`);
  }
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

  // A discount and a rounding adjustment are both printed as their own line
  // rather than folded into the total. A customer who is given RM 5 off
  // should be able to see that they were, and a two sen rounding that is
  // invisible on paper is two sen nobody can account for later.
  if (receipt.discountSen) {
    p.columns("Diskaun", money(-receipt.discountSen), WIDTH);
  }
  if (receipt.roundingSen) {
    p.columns("Pembundaran", money(receipt.roundingSen), WIDTH);
  }
  if (dueSen !== receipt.totalSen) {
    p.columns("Perlu dibayar", money(dueSen), WIDTH);
  }

  if (paid) {
    const methodLabel =
      receipt.method === "cash"
        ? "TUNAI"
        : receipt.method === "duitnow_qr"
          ? "DUITNOW QR"
          : receipt.method!.toUpperCase();
    p.columns("Bayaran", methodLabel, WIDTH);
    if (receipt.paidSen !== undefined && receipt.paidSen !== dueSen) {
      p.columns("Dibayar", money(receipt.paidSen), WIDTH);
    }
    if (receipt.cashReceivedSen !== undefined) {
      p.columns("Diterima", money(receipt.cashReceivedSen), WIDTH);
      p.columns(
        "Baki",
        money(receipt.changeSen ?? receipt.cashReceivedSen - dueSen),
        WIDTH,
      );
    }
    if (partial) {
      p.size(1, 2).bold(true);
      p.columns("BELUM JELAS", money(receipt.balanceSen!), WIDTH / 2);
      p.bold(false).size(1, 1);
    }
  }

  p.feed(1).align("center");
  if (partial) {
    p.line("Baki sila jelaskan di kaunter");
  } else if (paid) {
    p.line("Terima kasih!").line("Jumpa lagi");
  } else {
    p.line("Sila jelaskan di kaunter").line("Terima kasih!");
  }
  p.cut();

  // The drawer opens for cash actually taken, including a part-payment: the
  // cashier is holding money either way and it has to go somewhere. A kick on
  // a QR payment — or on a bill nobody has paid yet — has the till springing
  // open with nothing to put in it.
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

/**
 * The end-of-day slip.
 *
 * The only piece of paper in this system that answers "is the money right".
 * It is printed after the drawer has been counted, so it does not kick — and
 * it prints the variance whether or not the variance is comfortable, because
 * a closing slip that only prints when the numbers agree is worth nothing.
 */
export interface ShiftReport {
  outletName: string;
  /** YYYY-MM-DD in the restaurant's own timezone, not UTC. */
  date: string;
  closedAt: Date;
  openingFloatSen: number;
  /** Cash taken, DuitNow taken, and anything else, in the order printed. */
  byMethod: { method: string; totalSen: number; count: number }[];
  discountSen: number;
  /** Ordered, before discounts. */
  salesSen: number;
  expectedCashSen: number;
  countedCashSen?: number;
  closedBy?: string;
}

export function renderShiftReport(report: ShiftReport): Uint8Array {
  const p = new EscPos().init();

  p.align("center").bold(true).size(2, 2);
  p.line(report.outletName.toUpperCase());
  p.size(1, 1);
  p.line("TUTUP HARI").bold(false);
  p.line(report.date);
  p.line(report.closedAt.toISOString().slice(0, 16).replace("T", " "));
  p.align("left").rule(WIDTH);

  p.columns("Jualan", money(report.salesSen), WIDTH);
  if (report.discountSen) {
    p.columns("Diskaun", money(-report.discountSen), WIDTH);
  }
  p.rule(WIDTH);

  for (const entry of report.byMethod) {
    const label =
      entry.method === "cash"
        ? "Tunai"
        : entry.method === "duitnow_qr"
          ? "DuitNow QR"
          : entry.method;
    p.columns(`${label} (${entry.count})`, money(entry.totalSen), WIDTH);
  }

  p.rule(WIDTH);
  p.columns("Wang permulaan", money(report.openingFloatSen), WIDTH);
  p.columns("Tunai sepatutnya", money(report.expectedCashSen), WIDTH);

  if (report.countedCashSen !== undefined) {
    p.columns("Tunai dikira", money(report.countedCashSen), WIDTH);
    const variance = report.countedCashSen - report.expectedCashSen;
    p.size(1, 2).bold(true);
    // Named rather than left as a bare number: "beza" on its own reads as an
    // arithmetic result, and this is the line somebody has to act on.
    p.columns(
      variance === 0 ? "SEIMBANG" : variance > 0 ? "LEBIH" : "KURANG",
      money(variance),
      WIDTH / 2,
    );
    p.bold(false).size(1, 1);
  } else {
    p.line("Belum dikira");
  }

  if (report.closedBy) {
    p.feed(1).line(`Ditutup oleh: ${report.closedBy}`);
  }
  p.cut();

  // No drawer kick. It was already open to be counted, and a till that
  // springs open after the money is bagged is a till nobody wants.
  return p.bytes();
}
