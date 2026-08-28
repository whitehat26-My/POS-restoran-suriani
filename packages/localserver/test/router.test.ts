/**
 * What the tablet will and will not do for a stranger on the shop's WiFi.
 *
 * This server listens on a network customers share, over plain HTTP, with no
 * login of any kind. Its safety is not a guard somewhere — it is the fact
 * that the dangerous routes do not exist. These tests assert both halves:
 * that the four allowed things work, and that a long list of things nobody
 * should be able to reach return 404 from a route table that has never heard
 * of them.
 */
import { describe, expect, it, beforeEach } from "vitest";

import { RateLimiter } from "../src/limit";
import { createRouter, priceLines } from "../src/router";
import type {
  CachedItem,
  LocalPorts,
  LocalRequest,
  OutletCache,
  PlacedLocally,
} from "../src/types";

const TEH: CachedItem = {
  id: "itm_min_tehtarik",
  categoryId: "cat_minum",
  nameMs: "Teh Tarik",
  nameEn: "Pulled Tea",
  descMs: null,
  descEn: null,
  priceSen: 250,
  tags: [],
  isAvailable: 1,
  prepMinutes: 5,
  modifierGroups: [
    {
      id: "mg_tehtarik_suhu",
      nameMs: "Panas, ais atau bungkus?",
      nameEn: "Hot, iced or takeaway?",
      minSelect: 1,
      maxSelect: 1,
      options: [
        { id: "mo_tehtarik_panas", labelMs: "Panas", labelEn: "Hot", priceDeltaSen: 0 },
        { id: "mo_tehtarik_ais", labelMs: "Ais", labelEn: "Iced", priceDeltaSen: 50 },
        {
          id: "mo_tehtarik_bksais",
          labelMs: "Bungkus (ais)",
          labelEn: "Takeaway (iced)",
          priceDeltaSen: 50,
        },
      ],
    },
  ],
};

const NASI: CachedItem = {
  id: "itm_nl_biasa",
  categoryId: "cat_nasilemak",
  nameMs: "Nasi Lemak Biasa",
  nameEn: "Plain Nasi Lemak",
  descMs: null,
  descEn: null,
  priceSen: 600,
  tags: [],
  isAvailable: 1,
  prepMinutes: 10,
  modifierGroups: [],
};

const HABIS: CachedItem = { ...NASI, id: "itm_nl_habis", isAvailable: 0 };

const CACHE: OutletCache = {
  outletId: "out_imbi",
  outletName: "Suriani Jalan Imbi (HQ)",
  menuVersion: 7,
  categories: [
    { id: "cat_nasilemak", nameMs: "Nasi Lemak", nameEn: "Nasi Lemak", sortOrder: 0 },
    { id: "cat_minum", nameMs: "Minuman", nameEn: "Drinks", sortOrder: 1 },
  ],
  items: [TEH, NASI, HABIS],
  tables: [
    { id: "tbl_1", label: "Meja 01", qrToken: "TOKEN_ONE_AAAAAAAAAAAAAAAAAAAA" },
    { id: "tbl_2", label: "Meja 02", qrToken: "TOKEN_TWO_BBBBBBBBBBBBBBBBBBBB" },
  ],
  cachedAt: 1_700_000_000_000,
};

const TOKEN = CACHE.tables[0]!.qrToken;

function ports(overrides: Partial<LocalPorts> = {}): LocalPorts & {
  placed: { lines: unknown; clientUlid: string; tableId: string }[];
} {
  const placed: { lines: unknown; clientUlid: string; tableId: string }[] = [];
  return {
    placed,
    cache: () => CACHE,
    placeOrder: async ({ table, lines, clientUlid }): Promise<PlacedLocally> => {
      placed.push({ lines, clientUlid, tableId: table.id });
      return {
        orderId: `ord_${placed.length}`,
        totalSen: priceLines(CACHE.items, lines),
        duplicate: false,
      };
    },
    status: async () => ({ totalSen: 0, orders: [] }),
    now: () => 1_700_000_100_000,
    ...overrides,
  };
}

const req = (over: Partial<LocalRequest>): LocalRequest => ({
  method: "GET",
  path: "/",
  query: {},
  ip: "192.168.1.77",
  ...over,
});

const orderBody = (lines: unknown, clientUlid = "01J000000000000000000000") =>
  JSON.stringify({ lines, clientUlid });

describe("what the local server serves", () => {
  let handle: ReturnType<typeof createRouter>;
  let p: ReturnType<typeof ports>;
  beforeEach(() => {
    p = ports();
    handle = createRouter({ ports: p });
  });

  it("serves the customer app at a table's URL", async () => {
    const res = await handle(req({ path: `/t/out_imbi/${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ asset: "index.html" });
  });

  it("serves the menu and the table's own label", async () => {
    const res = await handle(req({ path: `/api/t/out_imbi/${TOKEN}` }));
    expect(res.status).toBe(200);
    const body = (res.body as { json: Record<string, unknown> }).json;
    expect(body.table).toEqual({ label: "Meja 01" });
    expect(body.outlet).toEqual({ name: "Suriani Jalan Imbi (HQ)" });
    expect((body.menu as { items: unknown[] }).items).toHaveLength(3);
    // The customer app reads this to explain why two buttons are missing.
    expect(body.local).toBe(true);
  });

  it("takes an order and hands it to the till's own store", async () => {
    const res = await handle(
      req({
        method: "POST",
        path: `/api/t/out_imbi/${TOKEN}/orders`,
        body: orderBody([
          { menuItemId: "itm_nl_biasa", qty: 2, notes: "kurang pedas" },
        ]),
      }),
    );

    expect(res.status).toBe(201);
    expect(p.placed).toHaveLength(1);
    expect(p.placed[0]!.tableId).toBe("tbl_1");
    expect((res.body as { json: PlacedLocally }).json.totalSen).toBe(1200);
  });
});

describe("what it refuses", () => {
  const handle = createRouter({ ports: ports() });

  it.each([
    ["the floor plan", "/api/outlets/out_imbi/floor"],
    ["the daily record", "/api/outlets/out_imbi/reports/daily"],
    ["a bill", "/api/outlets/out_imbi/sessions/ses_1"],
    ["login", "/api/auth/login"],
    ["the print queue", "/api/agent/jobs"],
    ["the outlet list", "/api/outlets"],
    ["a bill request", `/api/t/out_imbi/${TOKEN}/bill-request`],
    ["a waiter call", `/api/t/out_imbi/${TOKEN}/call-waiter`],
    ["anything deeper", `/api/t/out_imbi/${TOKEN}/status/extra`],
  ])("has never heard of %s", async (_name, path) => {
    // Not "blocks" — there is no route here to block. The POS surface was
    // never written into this table, so there is nothing to leave switched on
    // by mistake.
    expect((await handle(req({ path }))).status).toBe(404);
    expect((await handle(req({ method: "POST", path, body: "{}" }))).status).toBe(404);
  });

  it("refuses another outlet's id even with a token it holds", async () => {
    const res = await handle(req({ path: `/api/t/out_hotelleo/${TOKEN}` }));
    expect(res.status).toBe(404);
  });

  it("answers an unknown token exactly as it answers an unknown outlet", async () => {
    const badToken = await handle(req({ path: "/api/t/out_imbi/NOPE" }));
    const badOutlet = await handle(req({ path: `/api/t/out_nope/${TOKEN}` }));
    // Identical, so this server cannot be used to find out which outlet ids
    // and which tables are real.
    expect(badToken).toEqual(badOutlet);
    expect(badToken.status).toBe(404);
  });

  it("cannot be walked out of the assets directory", async () => {
    for (const path of [
      "/assets/../../capacitor.config.json",
      "/assets/..%2f..%2fsecrets",
      "/assets/sub/dir/file.js",
      "/assets/",
      "/assets/.env",
    ]) {
      expect((await handle(req({ path }))).status).toBe(404);
    }
    expect((await handle(req({ path: "/assets/index-ABC123.js" }))).body).toEqual({
      asset: "assets/index-ABC123.js",
    });
  });

  it("serves nothing at all over POST that is not an order", async () => {
    const res = await handle(
      req({ method: "POST", path: `/api/t/out_imbi/${TOKEN}`, body: "{}" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("order validation, which during an outage is the only validation", () => {
  let handle: ReturnType<typeof createRouter>;
  beforeEach(() => {
    handle = createRouter({ ports: ports() });
  });

  const post = (lines: unknown, ulid?: string) =>
    handle(
      req({
        method: "POST",
        path: `/api/t/out_imbi/${TOKEN}/orders`,
        body: orderBody(lines, ulid),
      }),
    );

  const errorOf = (res: { body: unknown }) =>
    (res.body as { json: { error?: string } }).json.error;

  it("prices the RM 0.50 rule from its own cache, not from the phone", async () => {
    const res = await post([
      {
        menuItemId: "itm_min_tehtarik",
        qty: 1,
        modifierOptionIds: ["mo_tehtarik_bksais"],
      },
    ]);
    // An iced takeaway teh tarik is RM 3.00, charged once.
    expect((res.body as { json: PlacedLocally }).json.totalSen).toBe(300);
  });

  it("ignores a price sent by the phone", async () => {
    const res = await post([
      {
        menuItemId: "itm_min_tehtarik",
        qty: 1,
        modifierOptionIds: ["mo_tehtarik_panas"],
        // The Phase 2b forged-price attempt, aimed at the tablet this time.
        priceSen: 1,
        modifiers: [{ label: "Diskaun", priceDeltaSen: -10_000 }],
      },
    ]);
    expect((res.body as { json: PlacedLocally }).json.totalSen).toBe(250);
  });

  it("refuses an option belonging to a different dish", async () => {
    const res = await post([
      { menuItemId: "itm_nl_biasa", qty: 1, modifierOptionIds: ["mo_tehtarik_ais"] },
    ]);
    expect(errorOf(res)).toBe("unknown_option");
  });

  it("refuses a drink with panas-or-ais unanswered", async () => {
    expect(errorOf(await post([{ menuItemId: "itm_min_tehtarik", qty: 1 }]))).toBe(
      "option_required",
    );
  });

  it("refuses two answers to a single-select group", async () => {
    const res = await post([
      {
        menuItemId: "itm_min_tehtarik",
        qty: 1,
        modifierOptionIds: ["mo_tehtarik_ais", "mo_tehtarik_panas"],
      },
    ]);
    expect(errorOf(res)).toBe("too_many_options");
  });

  it("refuses a dish the cashier has 86'd", async () => {
    expect(errorOf(await post([{ menuItemId: "itm_nl_habis", qty: 1 }]))).toBe(
      "unavailable",
    );
  });

  it.each([
    ["an unknown dish", [{ menuItemId: "itm_nope", qty: 1 }], "unknown_item"],
    ["no lines", [], "empty_order"],
    ["a zero quantity", [{ menuItemId: "itm_nl_biasa", qty: 0 }], "bad_qty"],
    ["a negative quantity", [{ menuItemId: "itm_nl_biasa", qty: -3 }], "bad_qty"],
    ["a fractional quantity", [{ menuItemId: "itm_nl_biasa", qty: 1.5 }], "bad_qty"],
    ["a silly quantity", [{ menuItemId: "itm_nl_biasa", qty: 999 }], "bad_qty"],
  ])("refuses %s", async (_name, lines, expected) => {
    expect(errorOf(await post(lines))).toBe(expected);
  });

  it("refuses an order with no client ulid, because retries would double it", async () => {
    expect(errorOf(await post([{ menuItemId: "itm_nl_biasa", qty: 1 }], "x"))).toBe(
      "missing_client_ulid",
    );
  });

  it("refuses a body that is not JSON", async () => {
    const res = await handle(
      req({
        method: "POST",
        path: `/api/t/out_imbi/${TOKEN}/orders`,
        body: "not json at all",
      }),
    );
    expect(errorOf(res)).toBe("bad_body");
  });

  it("trims a note rather than storing whatever was pasted in", async () => {
    const p = ports();
    const res = await createRouter({ ports: p })(
      req({
        method: "POST",
        path: `/api/t/out_imbi/${TOKEN}/orders`,
        body: orderBody([
          { menuItemId: "itm_nl_biasa", qty: 1, notes: "x".repeat(5000) },
        ]),
      }),
    );
    expect(res.status).toBe(201);
    const line = (p.placed[0]!.lines as { notes: string }[])[0]!;
    expect(line.notes).toHaveLength(120);
  });
});

describe("a tablet that has never been online", () => {
  it("says it is not ready rather than that the table does not exist", async () => {
    const handle = createRouter({ ports: ports({ cache: () => null }) });
    const res = await handle(req({ path: `/api/t/out_imbi/${TOKEN}` }));
    // A 404 would send a customer at a real table looking for staff to fix
    // the wrong problem.
    expect(res.status).toBe(503);
  });
});

describe("rate limiting", () => {
  it("stops one phone spending the whole tablet on order attempts", async () => {
    let clock = 0;
    const handle = createRouter({
      ports: ports({ now: () => clock }),
      writeLimit: new RateLimiter(3, 3),
    });
    const fire = () =>
      handle(
        req({
          method: "POST",
          path: `/api/t/out_imbi/${TOKEN}/orders`,
          body: orderBody([{ menuItemId: "itm_nl_biasa", qty: 1 }]),
        }),
      );

    expect((await fire()).status).toBe(201);
    expect((await fire()).status).toBe(201);
    expect((await fire()).status).toBe(201);
    expect((await fire()).status).toBe(429);

    // And it refills, so a real customer ordering a second round later is not
    // still locked out.
    clock += 60_000;
    expect((await fire()).status).toBe(201);
  });

  it("counts each phone separately", async () => {
    const handle = createRouter({
      ports: ports({ now: () => 0 }),
      readLimit: new RateLimiter(1, 1),
    });
    const one = await handle(req({ path: `/api/t/out_imbi/${TOKEN}`, ip: "10.0.0.1" }));
    const again = await handle(req({ path: `/api/t/out_imbi/${TOKEN}`, ip: "10.0.0.1" }));
    const other = await handle(req({ path: `/api/t/out_imbi/${TOKEN}`, ip: "10.0.0.2" }));

    expect(one.status).toBe(200);
    expect(again.status).toBe(429);
    expect(other.status).toBe(200);
  });

  it("does not let a client hammering the door lock itself out forever", async () => {
    // A refusal still moves the bucket's clock. Without that, a phone in a
    // retry loop resets its own refill on every attempt and never recovers.
    const limiter = new RateLimiter(1, 60);
    expect(limiter.take("phone", 0)).toBe(true);
    for (let t = 100; t < 1000; t += 100) limiter.take("phone", t);
    expect(limiter.take("phone", 1_100)).toBe(true);
  });

  it("forgets phones that left hours ago", () => {
    const limiter = new RateLimiter(10, 10);
    limiter.take("a", 0);
    limiter.take("b", 0);
    limiter.take("c", 9 * 60_000);
    limiter.sweep(10 * 60_000 + 1);
    expect(limiter.size).toBe(1);
  });
});
