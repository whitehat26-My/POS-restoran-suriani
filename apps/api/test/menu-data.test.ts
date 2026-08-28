/**
 * The transcription's proof.
 *
 * `seed-data.ts` is a hand transcription of a seven-page printed menu. A typo
 * in one of a hundred and forty-seven prices is invisible in review, costs a
 * real customer real money, and nothing else in this suite would catch it. So
 * the counts and a spread of spot prices are asserted straight off the card.
 *
 * These are data tests, not behaviour tests: they run in milliseconds and they
 * are the reason a menu edit is safe to make.
 */
import { describe, expect, it } from "vitest";

import { shortLabel } from "@suriani/core/menu";

import {
  SEED_CATEGORIES,
  SEED_ITEMS,
  SEED_MODIFIER_GROUPS,
  SEED_STATIONS,
} from "../src/seed-data";

/** Section sizes as printed. "26 PILIHAN" over Nasi Goreng is the card's own claim. */
const EXPECTED_COUNTS: Record<string, number> = {
  cat_hainan: 6,
  cat_nasilemak: 8,
  cat_setnasi: 16,
  cat_mee: 9,
  cat_nasigoreng: 26,
  cat_western: 6,
  cat_pasta: 9,
  cat_side: 7,
  cat_indo: 6,
  cat_sarapan: 5,
  cat_tambahan: 7,
  cat_roti: 17,
  cat_burger: 0,
  cat_minum: 25,
};

const byId = new Map(SEED_ITEMS.map((i) => [i.id, i]));

describe("the printed menu", () => {
  it("has every section the card has, in the card's order", () => {
    expect(SEED_CATEGORIES.map((c) => c.id)).toEqual(Object.keys(EXPECTED_COUNTS));
    expect(SEED_CATEGORIES.map((c) => c.sortOrder)).toEqual(
      SEED_CATEGORIES.map((_, i) => i),
    );
  });

  it("has the right number of dishes in each section", () => {
    const counted: Record<string, number> = {};
    for (const c of SEED_CATEGORIES) counted[c.id] = 0;
    for (const i of SEED_ITEMS) counted[i.categoryId] = (counted[i.categoryId] ?? 0) + 1;
    expect(counted).toEqual(EXPECTED_COUNTS);
    expect(SEED_ITEMS).toHaveLength(147);
  });

  it("prices the dishes the card prices", () => {
    const spot: Record<string, number> = {
      itm_nl_biasa: 600,
      itm_hainan_mix: 1600,
      itm_set_suptulang: 1400,
      itm_mee_kungfu: 1000,
      itm_ng_kampung: 800,
      itm_ng_vegetarian: 700,
      itm_west_lambchop: 1690,
      itm_pasta_chickengrillcarbonara: 1890,
      itm_side_meatball: 1190,
      itm_indo_dagingpenyet: 1300,
      itm_sarapan_rotibakar: 300,
      itm_tmb_telurmata: 200,
      itm_roti_kosong: 180,
      itm_min_tehtarik: 250,
      itm_min_airsmall: 150,
    };
    for (const [id, priceSen] of Object.entries(spot)) {
      expect(byId.get(id)?.priceSen, id).toBe(priceSen);
    }
  });

  it("has no duplicate ids anywhere", () => {
    const ids = [
      ...SEED_CATEGORIES.map((c) => c.id),
      ...SEED_ITEMS.map((i) => i.id),
      ...SEED_MODIFIER_GROUPS.map((g) => g.id),
      ...SEED_MODIFIER_GROUPS.flatMap((g) => g.options.map((o) => o.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no free food and no orphan rows", () => {
    const categoryIds = new Set(SEED_CATEGORIES.map((c) => c.id));
    for (const i of SEED_ITEMS) {
      expect(i.priceSen, i.id).toBeGreaterThan(0);
      expect(Number.isInteger(i.priceSen), i.id).toBe(true);
      expect(categoryIds.has(i.categoryId), i.id).toBe(true);
      expect(i.nameMs.length, i.id).toBeGreaterThan(0);
      expect(i.nameEn.length, i.id).toBeGreaterThan(0);
    }
    for (const g of SEED_MODIFIER_GROUPS) {
      expect(byId.has(g.menuItemId), g.id).toBe(true);
      expect(g.options.length, g.id).toBeGreaterThan(0);
    }
  });

  it("is printable in full ASCII", () => {
    // The ESC/POS encoder folds accents but cannot render arbitrary Unicode;
    // a dish name that degrades to "?" on a docket is a dish nobody can cook.
    for (const i of SEED_ITEMS) {
      expect(i.nameMs.normalize("NFD").replace(/[̀-ͯ]/g, ""), i.id)
        .toMatch(/^[\x20-\x7e]*$/);
    }
  });
});

describe("the RM 0.50 rule", () => {
  it("charges it once, never twice", () => {
    // Modelled as one single-select group per drink. Two independent +50
    // options would stack to RM 1.00 for an iced takeaway drink, which is not
    // what the owner charges — so the cap has to be structural.
    const drinkGroups = SEED_MODIFIER_GROUPS.filter((g) =>
      g.menuItemId.startsWith("itm_min_"),
    );
    expect(drinkGroups.length).toBe(25);

    for (const g of drinkGroups) {
      expect(g.minSelect, g.id).toBe(1);
      expect(g.maxSelect, g.id).toBe(1);
      for (const o of g.options) {
        expect([0, undefined, 50], `${g.id}/${o.id}`).toContain(o.priceDeltaSen);
      }
    }
  });

  it("gives every drink exactly one group, and no food any", () => {
    const withGroup = new Set(SEED_MODIFIER_GROUPS.map((g) => g.menuItemId));
    for (const i of SEED_ITEMS.filter((x) => x.categoryId === "cat_minum")) {
      expect(withGroup.has(i.id), i.id).toBe(true);
    }
    // Takeaway is a drinks charge only; food carries no surcharge option.
    const food = SEED_MODIFIER_GROUPS.filter(
      (g) => !g.menuItemId.startsWith("itm_min_"),
    );
    for (const g of food) {
      expect(byId.get(g.menuItemId)?.categoryId, g.id).toBe("cat_mee");
      for (const o of g.options) {
        expect(o.priceDeltaSen ?? 0, `${g.id}/${o.id}`).toBe(0);
      }
    }
  });

  it("does not charge for icing something already cold", () => {
    for (const id of ["itm_min_softdrinks", "itm_min_airsmall", "itm_min_milodinasour"]) {
      const g = SEED_MODIFIER_GROUPS.find((x) => x.menuItemId === id);
      expect(g?.options.map((o) => o.labelMs), id).toEqual(["Makan sini", "Bungkus"]);
    }
  });
});

describe("the noodle section", () => {
  it("asks which noodle and goreng or sup, both free and both required", () => {
    const noodles = SEED_ITEMS.filter((i) => i.categoryId === "cat_mee");
    expect(noodles).toHaveLength(9);

    for (const i of noodles) {
      const groups = SEED_MODIFIER_GROUPS.filter((g) => g.menuItemId === i.id);
      expect(groups.map((g) => g.nameMs), i.id).toEqual([
        "Pilih mee",
        "Goreng atau sup?",
      ]);
      expect(groups[0]!.options.map((o) => o.labelMs)).toEqual([
        "Mee",
        "Kuetiau",
        "Bihun",
        "Maggi",
      ]);
      expect(groups[1]!.options.map((o) => o.labelMs)).toEqual(["Goreng", "Sup"]);
    }
  });
});

describe("printing", () => {
  it("routes every category, and keeps a default for the ones nobody routed", () => {
    const routed = new Set(SEED_STATIONS.flatMap((s) => s.categoryIds ?? []));
    for (const c of SEED_CATEGORIES) {
      expect(routed.has(c.id), c.id).toBe(true);
    }
    // The rule that makes a category added tomorrow safe.
    expect(SEED_STATIONS.filter((s) => s.isDefault)).toHaveLength(1);
    expect(SEED_STATIONS.find((s) => s.isDefault)?.target).toBe("kitchen");
    expect(SEED_STATIONS.find((s) => s.categoryIds?.includes("cat_minum"))?.target)
      .toBe("drinks");
  });
});

describe("shortLabel", () => {
  const nameOf = new Map(SEED_CATEGORIES.map((c) => [c.id, c.nameMs]));
  const short = (id: string) => {
    const item = byId.get(id)!;
    return shortLabel(item.nameMs, nameOf.get(item.categoryId)!);
  };

  it("drops the heading the customer can already see", () => {
    expect(short("itm_ng_kampung")).toBe("Kampung");
    expect(short("itm_nl_sambalsotong")).toBe("Sambal Sotong");
    expect(short("itm_set_suptulang")).toBe("Sup Tulang");
    expect(short("itm_roti_telurcili")).toBe("Telur Cili");
    expect(short("itm_hainan_steam")).toBe("Steam");
  });

  it("leaves a name alone when the heading is not part of it", () => {
    // The category is "Mee / Kuetiau / Bihun / Maggi"; the dish is "Mee Kungfu".
    expect(short("itm_mee_kungfu")).toBe("Kungfu");
    expect(short("itm_min_tehtarik")).toBe("Teh Tarik");
    expect(short("itm_west_lambchop")).toBe("Lamb Chop");
    expect(short("itm_hainan_taugeh")).toBe("Taugeh");
    expect(short("itm_tmb_telurmata")).toBe("Telur Mata");
  });

  it("never shortens a name to nothing", () => {
    for (const item of SEED_ITEMS) {
      const label = shortLabel(item.nameMs, nameOf.get(item.categoryId)!);
      expect(label.length, item.id).toBeGreaterThan(0);
      expect(item.nameMs.endsWith(label), item.id).toBe(true);
    }
  });

  it("is exact about the boundary rather than matching a bare prefix", () => {
    expect(shortLabel("Nasi Goreng Kampung", "Nasi")).toBe("Goreng Kampung");
    expect(shortLabel("Nasi Lemak", "Nasi Lemak")).toBe("Nasi Lemak");
    expect(shortLabel("Rotiprata", "Roti")).toBe("Rotiprata");
    expect(shortLabel("Teh Tarik", "Minuman")).toBe("Teh Tarik");
  });
});
