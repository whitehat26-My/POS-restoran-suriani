/**
 * The rule that decides which printer a dish goes to.
 *
 * It lives in @suriani/core because two machines apply it: the Worker when it
 * queues print jobs, and the tablet when the internet is down and it prints
 * the docket itself. A cook holding a slip cannot tell which one produced it,
 * so these tests are as much about the tablet as about the server.
 */
import { describe, expect, it } from "vitest";

import {
  fallbackStation,
  groupLinesByStation,
  type StationLike,
} from "@suriani/core/stations";

const KITCHEN: StationLike = {
  id: "st_kitchen",
  name: "Dapur",
  target: "kitchen",
  enabled: 1,
  isDefault: 1,
};
const DRINKS: StationLike = {
  id: "st_drinks",
  name: "Minuman",
  target: "drinks",
  enabled: 1,
  isDefault: 0,
};

const STATIONS = [KITCHEN, DRINKS];
const ROUTES = [
  { stationId: "st_kitchen", categoryId: "cat_nasilemak" },
  { stationId: "st_drinks", categoryId: "cat_minum" },
];

type Line = { menuItemId: string };
const group = (lines: Line[], categoryByItem: Map<string, string>, stations = STATIONS) =>
  groupLinesByStation(lines, {
    stations,
    routes: ROUTES,
    categoryByItem,
    menuItemIdOf: (l) => l.menuItemId,
  });

describe("station grouping", () => {
  it("splits a mixed order into one docket per station", () => {
    const result = group(
      [{ menuItemId: "nasi" }, { menuItemId: "teh" }, { menuItemId: "nasi2" }],
      new Map([
        ["nasi", "cat_nasilemak"],
        ["teh", "cat_minum"],
        ["nasi2", "cat_nasilemak"],
      ]),
    );

    expect(result).toHaveLength(2);
    const kitchen = result.find((g) => g.station.id === "st_kitchen")!;
    const drinks = result.find((g) => g.station.id === "st_drinks")!;
    // Each slip carries only its own lines — the drinks counter must not be
    // handed a slip listing food it is not making.
    expect(kitchen.lines.map((l) => l.menuItemId)).toEqual(["nasi", "nasi2"]);
    expect(drinks.lines.map((l) => l.menuItemId)).toEqual(["teh"]);
  });

  it("still prints a category nobody routed", () => {
    // The alternative is that adding a category silently stops its dishes
    // reaching a kitchen, and nobody finds out until a table has waited
    // twenty minutes for food nobody started cooking.
    const result = group([{ menuItemId: "burger" }], new Map([["burger", "cat_burger"]]));
    expect(result).toHaveLength(1);
    expect(result[0]!.station.id).toBe("st_kitchen");
  });

  it("still prints a dish it has never heard of", () => {
    // The tablet's cached menu can be a few minutes behind the server's.
    const result = group([{ menuItemId: "itm_brand_new" }], new Map());
    expect(result[0]!.station.id).toBe("st_kitchen");
  });

  it("ignores a disabled station", () => {
    const off = [{ ...DRINKS, enabled: 0 }, KITCHEN];
    const result = group([{ menuItemId: "teh" }], new Map([["teh", "cat_minum"]]), off);
    // Routed to a station that is switched off, so it falls back rather than
    // vanishing.
    expect(result).toHaveLength(1);
    expect(result[0]!.station.id).toBe("st_kitchen");
  });

  it("prints nothing when there is no station at all", () => {
    expect(group([{ menuItemId: "nasi" }], new Map(), [])).toEqual([]);
  });

  it("prefers the default, then a kitchen, then whatever exists", () => {
    expect(fallbackStation(STATIONS)!.id).toBe("st_kitchen");
    expect(
      fallbackStation([{ ...DRINKS }, { ...KITCHEN, isDefault: 0 }])!.id,
    ).toBe("st_kitchen");
    expect(fallbackStation([{ ...DRINKS, target: "counter" }])!.id).toBe("st_drinks");
    expect(fallbackStation([])).toBeUndefined();
  });
});
