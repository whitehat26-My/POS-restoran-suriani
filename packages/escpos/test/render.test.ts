/**
 * Golden byte tests.
 *
 * A docket is only correct if the exact bytes are correct: a wrong cut command
 * leaves slips joined, a wrong drawer pulse opens a till nobody asked to open.
 * Asserting rendered text alone would miss both.
 */
import { describe, expect, it } from "vitest";

import { EscPos, wrap } from "../src/index";
import {
  renderKitchenTicket,
  renderReceipt,
  renderShiftReport,
  renderTestSlip,
} from "../src/templates";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function includesSequence(haystack: Uint8Array, needle: number[]): boolean {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

describe("encoder", () => {
  it("starts with ESC @ so the printer is in a known state", () => {
    const bytes = new EscPos().init().text("hi").bytes();
    expect([...bytes.slice(0, 2)]).toEqual([0x1b, 0x40]);
  });

  it("packs GS ! size as width and height nibbles", () => {
    // width 2, height 2 → ((2-1)<<4) | (2-1) = 0x11
    expect([...new EscPos().size(2, 2).bytes()]).toEqual([0x1d, 0x21, 0x11]);
    expect([...new EscPos().size(1, 2).bytes()]).toEqual([0x1d, 0x21, 0x01]);
  });

  it("replaces non-ASCII rather than emitting raw high bytes", () => {
    // A smart quote pasted into a menu name must not desynchronise a printer.
    const bytes = new EscPos().text("Grandma’s “nasi” – pedas").bytes();
    expect(decode(bytes)).toBe(`Grandma's "nasi" - pedas`);
    expect([...bytes].every((b) => b >= 0x20 && b <= 0x7e)).toBe(true);
  });

  it("wraps on word boundaries", () => {
    expect(wrap("Nasi Lemak Ayam Berempah", 12)).toEqual([
      "Nasi Lemak",
      "Ayam",
      "Berempah",
    ]);
  });
});

const ticket = {
  outletName: "Suriani Jalan Imbi",
  stationName: "Dapur",
  tableLabel: "Meja 05",
  orderCode: "#1842",
  placedAt: new Date("2026-08-18T12:34:00Z"),
  lines: [
    {
      qty: 2,
      name: "Nasi Lemak Ayam Berempah",
      modifiers: ["Tambah telur"],
      notes: "kurang pedas",
    },
  ],
};

describe("kitchen docket", () => {
  it("carries the modifiers and the note to the cook", () => {
    // The Phase 1 payload dropped these, which means wrong food. This test
    // exists so that defect cannot come back.
    const text = decode(renderKitchenTicket(ticket));
    expect(text).toContain("Tambah telur");
    expect(text).toContain("kurang pedas");
    expect(text).toContain("2x NASI LEMAK");
  });

  it("shows no prices — a cook does not need them", () => {
    const text = decode(renderKitchenTicket(ticket));
    expect(text).not.toContain("RM");
    expect(text).not.toMatch(/\d+\.\d{2}/);
  });

  it("prints the table label double-height and double-width", () => {
    const bytes = renderKitchenTicket(ticket);
    const text = decode(bytes);
    const sizeUp = text.indexOf("MEJA 05");
    expect(sizeUp).toBeGreaterThan(-1);
    expect(includesSequence(bytes, [0x1d, 0x21, 0x11])).toBe(true);
  });

  it("ends with a partial cut", () => {
    const bytes = renderKitchenTicket(ticket);
    expect([...bytes.slice(-3)]).toEqual([0x1d, 0x56, 0x01]);
  });

  it("never kicks the cash drawer", () => {
    // A kitchen docket opening the till would be alarming and wrong.
    expect(includesSequence(renderKitchenTicket(ticket), [0x1b, 0x70])).toBe(false);
  });

  it("marks a reprint so nobody cooks it twice", () => {
    const text = decode(renderKitchenTicket({ ...ticket, reprint: true }));
    expect(text).toContain("CETAK SEMULA");
  });
});

const receipt = {
  outletName: "Suriani Jalan Imbi",
  tableLabel: "Meja 05",
  orderCode: "#1842",
  paidAt: new Date("2026-08-18T12:40:00Z"),
  lines: [
    {
      qty: 2,
      name: "Nasi Lemak Ayam Berempah",
      modifiers: [{ label: "Tambah telur", priceDeltaSen: 150 }],
      lineSen: 2700,
    },
  ],
  totalSen: 2700,
  method: "cash",
  cashReceivedSen: 5000,
};

describe("counter receipt", () => {
  it("itemises with prices and totals in ringgit", () => {
    const text = decode(renderReceipt(receipt));
    expect(text).toContain("27.00");
    expect(text).toContain("JUMLAH");
    expect(text).toContain("TUNAI");
  });

  it("shows change for cash", () => {
    const text = decode(renderReceipt(receipt));
    expect(text).toContain("50.00");
    expect(text).toContain("23.00");
  });

  it("kicks the drawer for cash and only for cash", () => {
    const kick = [0x1b, 0x70, 0x00, 0x19, 0xfa];
    expect(includesSequence(renderReceipt(receipt), kick)).toBe(true);
    expect(
      includesSequence(
        renderReceipt({ ...receipt, method: "duitnow_qr", cashReceivedSen: undefined }),
        kick,
      ),
    ).toBe(false);
  });

  // The slip the counter prints when a table taps "Minta Bil": the customer
  // has not paid yet, so it must not claim a payment method and must not open
  // a drawer that has nothing to receive.
  it("prints an unpaid bill when no method is set", () => {
    const bill = {
      ...receipt,
      method: undefined,
      cashReceivedSen: undefined,
      itemCount: 3,
    };
    const text = decode(renderReceipt(bill));

    expect(text).toContain("BIL");
    expect(text).not.toContain("RESIT");
    expect(text).not.toContain("TUNAI");
    expect(text).not.toContain("Bayaran");
    expect(text).toContain("Sila jelaskan di kaunter");
    expect(text).toContain("27.00");
    expect(text).toContain("Bilangan hidangan");

    const kick = [0x1b, 0x70, 0x00, 0x19, 0xfa];
    expect(includesSequence(renderReceipt(bill), kick)).toBe(false);
  });

  it("stamps a reprint as a copy", () => {
    expect(decode(renderReceipt({ ...receipt, reprint: true }))).toContain(
      "SALINAN",
    );
    expect(decode(renderReceipt(receipt))).not.toContain("SALINAN");
  });
});

describe("text encoding", () => {
  it("folds accents to a letter a cook can read", () => {
    const text = decode(
      renderKitchenTicket({
        ...ticket,
        lines: [{ qty: 1, name: "Nescafé", modifiers: ["crème"], notes: "señor" }],
      }),
    );
    expect(text).toContain("NESCAFE");
    expect(text).toContain("creme");
    expect(text).toContain("senor");
    expect(text).not.toContain("?");
  });

  it("still refuses to emit a raw high byte", () => {
    const bytes = renderKitchenTicket({
      ...ticket,
      lines: [{ qty: 1, name: "Nasi 🍚 Lemak", modifiers: [], notes: null }],
    });
    expect(bytes.every((b) => b <= 0x7f)).toBe(true);
  });
});

describe("setup slip", () => {
  const slip = renderTestSlip({
    outletName: "Suriani Hotel Leo",
    stationName: "Dapur",
    at: new Date(2026, 7, 28, 9, 5),
  });

  it("names the station, because swapped printers are the commonest mistake", () => {
    // Uppercased on the slip so it reads across a kitchen at arm's length.
    expect(decode(slip)).toContain("DAPUR");
    expect(decode(slip)).toContain("Suriani Hotel Leo");
  });

  it("cuts, so the installer can tear off a slip and move on", () => {
    expect(includesSequence(slip, [0x1d, 0x56, 1])).toBe(true);
  });

  it("never kicks the drawer — a test print is not a sale", () => {
    expect(includesSequence(slip, [0x1b, 0x70])).toBe(false);
  });
});

describe("a receipt that says money changed hands", () => {
  const bill = {
    outletName: "Suriani Jalan Imbi (HQ)",
    tableLabel: "Meja 01",
    orderCode: "#A1B2C",
    paidAt: new Date(2026, 7, 28, 20, 15),
    lines: [
      { qty: 2, name: "Nasi Lemak Ayam Goreng", modifiers: [], lineSen: 1800 },
      {
        qty: 1,
        name: "Teh Tarik",
        modifiers: [{ label: "Bungkus (ais)", priceDeltaSen: 50 }],
        lineSen: 300,
      },
    ],
    totalSen: 2100,
  };

  it("prints the receipt number, so a slip can be found again", () => {
    const bytes = renderReceipt({ ...bill, method: "cash", receiptNo: 42 });
    // Zero-padded: a column of receipt numbers that lines up is easier to
    // scan than one that does not.
    expect(decode(bytes)).toContain("No. 000042");
  });

  it("shows a discount as its own line, not folded into the total", () => {
    const bytes = renderReceipt({
      ...bill,
      method: "cash",
      discountSen: 500,
      cashReceivedSen: 2000,
    });
    const text = decode(bytes);
    // A customer given RM 5 off should be able to see that they were.
    expect(text).toContain("Diskaun");
    expect(text).toContain("-5.00");
    expect(text).toContain("Perlu dibayar");
    expect(text).toContain("16.00");
    // And the change is worked out against what was owed, not the total.
    expect(text).toContain("Baki");
    expect(text).toContain("4.00");
  });

  it("prints the cash rounding rather than absorbing it", () => {
    const bytes = renderReceipt({
      ...bill,
      totalSen: 2102,
      method: "cash",
      roundingSen: -2,
      cashReceivedSen: 5000,
    });
    const text = decode(bytes);
    expect(text).toContain("Pembundaran");
    expect(text).toContain("-0.02");
    expect(text).toContain("21.00");
    // Two sen that is invisible on paper is two sen nobody can account for.
    expect(text).toContain("29.00");
  });

  it("turns a part payment into its own slip, with the balance owing", () => {
    const bytes = renderReceipt({
      ...bill,
      method: "cash",
      paidSen: 1000,
      cashReceivedSen: 1000,
      changeSen: 0,
      balanceSen: 1100,
    });
    const text = decode(bytes);
    expect(text).toContain("BAYARAN SEPARA");
    expect(text).not.toContain("RESIT");
    expect(text).toContain("BELUM JELAS");
    expect(text).toContain("11.00");
    expect(text).toContain("Baki sila jelaskan di kaunter");
  });

  it("kicks the drawer for a part payment in cash too", () => {
    // The cashier is holding money either way, and it has to go somewhere.
    const partial = renderReceipt({
      ...bill,
      method: "cash",
      paidSen: 1000,
      balanceSen: 1100,
    });
    expect(includesSequence(partial, [0x1b, 0x70])).toBe(true);

    const byQr = renderReceipt({
      ...bill,
      method: "duitnow_qr",
      paidSen: 1000,
      balanceSen: 1100,
    });
    expect(includesSequence(byQr, [0x1b, 0x70])).toBe(false);
  });

  it("still prints an unpaid bill when there is no method", () => {
    // The Phase 4b behaviour, unchanged by any of the above.
    const text = decode(renderReceipt({ ...bill, itemCount: 3 }));
    expect(text).toContain("BIL");
    expect(text).not.toContain("RESIT");
    expect(text).not.toContain("Bayaran");
    expect(text).toContain("Sila jelaskan di kaunter");
  });
});

describe("the end-of-day slip", () => {
  const base = {
    outletName: "Suriani Jalan Imbi (HQ)",
    date: "2026-08-28",
    closedAt: new Date(2026, 7, 28, 23, 30),
    openingFloatSen: 20000,
    byMethod: [
      { method: "cash", totalSen: 11860, count: 14 },
      { method: "duitnow_qr", totalSen: 6400, count: 5 },
    ],
    discountSen: 500,
    salesSen: 18760,
    expectedCashSen: 31860,
  };

  it("names a balanced drawer rather than printing a bare zero", () => {
    const text = decode(renderShiftReport({ ...base, countedCashSen: 31860 }));
    expect(text).toContain("SEIMBANG");
    expect(text).toContain("Tunai sepatutnya");
    expect(text).toContain("318.60");
  });

  it("prints a short drawer as short, because that is the point of it", () => {
    const text = decode(renderShiftReport({ ...base, countedCashSen: 31800 }));
    expect(text).toContain("KURANG");
    expect(text).toContain("-0.60");
  });

  it("says over when the drawer is over", () => {
    const text = decode(renderShiftReport({ ...base, countedCashSen: 31900 }));
    expect(text).toContain("LEBIH");
    expect(text).toContain("0.40");
  });

  it("breaks the day down by how the money came in", () => {
    const text = decode(renderShiftReport({ ...base, countedCashSen: 31860 }));
    expect(text).toContain("Tunai (14)");
    expect(text).toContain("DuitNow QR (5)");
    expect(text).toContain("Diskaun");
  });

  it("never kicks the drawer — it was already open to be counted", () => {
    const bytes = renderShiftReport({ ...base, countedCashSen: 31860 });
    expect(includesSequence(bytes, [0x1b, 0x70])).toBe(false);
    expect(includesSequence(bytes, [0x1d, 0x56, 1])).toBe(true);
  });
});
