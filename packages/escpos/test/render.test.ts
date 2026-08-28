/**
 * Golden byte tests.
 *
 * A docket is only correct if the exact bytes are correct: a wrong cut command
 * leaves slips joined, a wrong drawer pulse opens a till nobody asked to open.
 * Asserting rendered text alone would miss both.
 */
import { describe, expect, it } from "vitest";

import { EscPos, wrap } from "../src/index";
import { renderKitchenTicket, renderReceipt } from "../src/templates";

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
