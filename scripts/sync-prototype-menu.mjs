#!/usr/bin/env node
/**
 * Push the real menu into the Phase 0 prototype.
 *
 * The prototype is a standalone file you can open by double-clicking, which is
 * exactly why it is the first thing anyone looks at — and exactly why a stale
 * one is worse than none. It cannot import TypeScript, so rather than keeping
 * a second copy of the menu by hand, this generates its menu block from
 * `apps/api/src/seed-data.ts`, between markers, on demand.
 *
 *   node scripts/sync-prototype-menu.mjs [--check]
 *
 * --check exits non-zero if the prototype is out of date, so CI can say so.
 */
import { readFileSync, writeFileSync } from "node:fs";

const { SEED_CATEGORIES, SEED_ITEMS, SEED_MODIFIER_GROUPS } = await import(
  "../apps/api/src/seed-data.ts"
);

const FILE = new URL("../design/prototype.html", import.meta.url);
const START = "/* <<< GENERATED MENU — node scripts/sync-prototype-menu.mjs >>> */";
const END = "/* <<< END GENERATED MENU >>> */";

/**
 * Which drawing each section gets.
 *
 * Matches apps/menu/src/art.tsx. Nobody is drawing a hundred and forty-seven
 * plates, and every dish in a section looks broadly alike anyway.
 */
const ART_BY_CATEGORY = {
  cat_hainan: "ayam",
  cat_nasilemak: "nasilemak",
  cat_setnasi: "nasigoreng",
  cat_mee: "meegoreng",
  cat_nasigoreng: "nasigoreng",
  cat_western: "ayam",
  cat_pasta: "meegoreng",
  cat_side: "ayam",
  cat_indo: "nasilemak",
  cat_sarapan: "roti",
  cat_tambahan: "ayam",
  cat_roti: "roti",
  cat_burger: "ayam",
  cat_minum: "tehtarik",
};
const ART_BY_ITEM = {
  itm_min_kopio: "kopi",
  itm_min_kopisusu: "kopi",
  itm_min_cam: "kopi",
  itm_min_nescafe: "kopi",
  itm_min_nescafeo: "kopi",
  itm_min_milo: "milo",
  itm_min_milodinasour: "milo",
  itm_min_neslo: "milo",
  itm_min_horlick: "milo",
};

const groupsByItem = new Map();
for (const group of SEED_MODIFIER_GROUPS) {
  const list = groupsByItem.get(group.menuItemId) ?? [];
  list.push(group);
  groupsByItem.set(group.menuItemId, list);
}

const j = (value) => JSON.stringify(value);

const cats = SEED_CATEGORIES.map(
  (c) => `  { id: ${j(c.id)}, ms: ${j(c.nameMs)}, en: ${j(c.nameEn)} }`,
).join(",\n");

const items = SEED_ITEMS.map((item) => {
  const groups = (groupsByItem.get(item.id) ?? []).map((g) => ({
    ms: g.nameMs,
    en: g.nameEn,
    min: g.minSelect ?? 0,
    max: g.maxSelect ?? 1,
    options: g.options.map((o) => ({
      ms: o.labelMs,
      en: o.labelEn,
      sen: o.priceDeltaSen ?? 0,
    })),
  }));
  const parts = [
    `id: ${j(item.id)}`,
    `cat: ${j(item.categoryId)}`,
    `art: ${j(ART_BY_ITEM[item.id] ?? ART_BY_CATEGORY[item.categoryId] ?? "nasilemak")}`,
    `sen: ${item.priceSen}`,
    `prep: ${item.prepMinutes ?? 10}`,
    `ms: ${j(item.nameMs)}`,
    `en: ${j(item.nameEn)}`,
    `tags: ${j(item.tags ?? [])}`,
  ];
  if (groups.length) parts.push(`groups: ${j(groups)}`);
  return `  { ${parts.join(", ")} }`;
}).join(",\n");

const block = `${START}
/* Generated from apps/api/src/seed-data.ts — the same menu the real app
   serves. Do not hand-edit; run the script. */
const CATS = [
${cats}
];

const MENU = [
${items}
];
${END}`;

const html = readFileSync(FILE, "utf8");
const startAt = html.indexOf(START);
const endAt = html.indexOf(END);
if (startAt === -1 || endAt === -1) {
  console.error(
    "Markers not found in design/prototype.html.\n" +
      `Expected ${START} ... ${END} around the CATS/MENU block.`,
  );
  process.exit(2);
}

const next =
  html.slice(0, startAt) + block + html.slice(endAt + END.length);

if (process.argv.includes("--check")) {
  if (next !== html) {
    console.error(
      "design/prototype.html is out of date with the menu.\n" +
        "Run: node scripts/sync-prototype-menu.mjs",
    );
    process.exit(1);
  }
  console.log("prototype menu is up to date");
} else {
  writeFileSync(FILE, next);
  console.log(
    `prototype menu updated: ${SEED_CATEGORIES.length} categories, ` +
      `${SEED_ITEMS.length} dishes`,
  );
}
