/**
 * Restoran Suriani's menu, transcribed from the printed card.
 *
 * Both sides of the menu, in printed order: side A is Nasi & Mee, side B is
 * Western & Minuman. 147 dishes across 13 sections, plus an empty Burger
 * section the owner is keeping for later.
 *
 * Two rules the card states that this file has to enforce:
 *
 *  1. "MINUMAN SEJUK & BUNGKUS (TAKE AWAY) DIKENAKAN CAJ TAMBAHAN RM 0.50" —
 *     and it is capped, not stacked: an iced takeaway drink is +50 sen, not
 *     +100. Modelled as ONE single-select group per drink rather than two
 *     independent +50 options, which makes the cap structural. You cannot
 *     pick two things, so two charges cannot happen.
 *
 *  2. The noodle section is headed "MEE / KUETIAU / BIHUN / MAGGI" over
 *     "GORENG / SUP" — those headings are choices, not decoration. Nine
 *     dishes with two free required choices, rather than seventy-two rows.
 *
 * Dish names are stored in full ("Nasi Goreng Kampung") because Susu, Milo,
 * Telur Mata and Ayam Goreng each appear in two sections at two prices, and a
 * docket reading "1x Susu" for a Roti Susu is a real mis-serve. The customer
 * app shortens them against the heading on screen — see shortLabel() in
 * @suriani/core.
 *
 * Prices are integer sen. Both branches share this master menu; per-outlet
 * price and availability overrides arrive in Phase 7.
 */
import type {
  SeedCategory,
  SeedItem,
  SeedModifierGroup,
} from "./outlet/OutletDO";

export const SEED_CATEGORIES: SeedCategory[] = [
  // ---- SEBELAH A · Nasi & Mee ----
  { id: "cat_hainan", nameMs: "Nasi Ayam Hainan", nameEn: "Hainanese Chicken Rice", sortOrder: 0 },
  { id: "cat_nasilemak", nameMs: "Nasi Lemak", nameEn: "Nasi Lemak", sortOrder: 1 },
  { id: "cat_setnasi", nameMs: "Set Nasi Putih", nameEn: "White Rice Sets", sortOrder: 2 },
  { id: "cat_mee", nameMs: "Mee / Kuetiau / Bihun / Maggi", nameEn: "Noodles", sortOrder: 3 },
  { id: "cat_nasigoreng", nameMs: "Nasi Goreng", nameEn: "Fried Rice", sortOrder: 4 },
  // ---- SEBELAH B · Western & Minuman ----
  { id: "cat_western", nameMs: "Western Food", nameEn: "Western Food", sortOrder: 5 },
  { id: "cat_pasta", nameMs: "Pasta", nameEn: "Pasta", sortOrder: 6 },
  { id: "cat_side", nameMs: "Side Dish", nameEn: "Side Dishes", sortOrder: 7 },
  { id: "cat_indo", nameMs: "Indonesian Food", nameEn: "Indonesian Food", sortOrder: 8 },
  { id: "cat_sarapan", nameMs: "Sarapan", nameEn: "Breakfast", sortOrder: 9 },
  { id: "cat_tambahan", nameMs: "Set Tambahan", nameEn: "Extras", sortOrder: 10 },
  { id: "cat_roti", nameMs: "Roti", nameEn: "Roti", sortOrder: 11 },
  // Nothing on the printed card yet — the owner is keeping the heading.
  { id: "cat_burger", nameMs: "Burger", nameEn: "Burger", sortOrder: 12 },
  { id: "cat_minum", nameMs: "Minuman", nameEn: "Drinks", sortOrder: 13 },
];

/**
 * One row of the printed card: [slug, nameMs, nameEn, priceSen, tags?].
 *
 * A tuple table rather than a hundred and forty-seven object literals, so it
 * can be read against the real menu line by line — which is the only way
 * anyone will ever check it.
 */
type Row = [string, string, string, number, string[]?];

function section(
  categoryId: string,
  idPrefix: string,
  prepMinutes: number,
  rows: Row[],
): SeedItem[] {
  return rows.map(([slug, nameMs, nameEn, priceSen, tags]) => ({
    id: `itm_${idPrefix}_${slug}`,
    categoryId,
    nameMs,
    nameEn,
    priceSen,
    tags: tags ?? [],
    prepMinutes,
  }));
}

export const SEED_ITEMS: SeedItem[] = [
  // ---- HAINAN · NASI AYAM HAINAN ----
  ...section("cat_hainan", "hainan", 10, [
    ["steam", "Nasi Ayam Hainan Steam", "Hainanese Chicken Rice, Steamed", 800, ["best"]],
    ["roasted", "Nasi Ayam Hainan Roasted", "Hainanese Chicken Rice, Roasted", 900],
    ["bbq", "Nasi Ayam Hainan BBQ", "Hainanese Chicken Rice, BBQ", 1000],
    ["mix", "Nasi Ayam Hainan Mix", "Hainanese Chicken Rice, Mixed", 1600],
    ["taugeh", "Taugeh", "Bean Sprout", 500],
    ["nasitambah", "Nasi Tambah", "Extra Rice", 250],
  ]),

  // ---- KEGEMARAN · NASI LEMAK ----
  ...section("cat_nasilemak", "nl", 8, [
    ["biasa", "Nasi Lemak Biasa", "Nasi Lemak, Plain", 600, ["best"]],
    ["telurmata", "Nasi Lemak Telur Mata", "Nasi Lemak with Fried Egg", 600],
    ["ayamgoreng", "Nasi Lemak Ayam Goreng", "Nasi Lemak with Fried Chicken", 900, ["best"]],
    ["ayamrendang", "Nasi Lemak Ayam Rendang", "Nasi Lemak with Chicken Rendang", 1000],
    ["dagingrendang", "Nasi Lemak Daging Rendang", "Nasi Lemak with Beef Rendang", 1000],
    ["sambalparu", "Nasi Lemak Sambal Paru", "Nasi Lemak with Sambal Beef Lung", 800, ["hot"]],
    ["sambalsotong", "Nasi Lemak Sambal Sotong", "Nasi Lemak with Sambal Squid", 800, ["hot"]],
    ["udangpetai", "Nasi Lemak Udang Petai", "Nasi Lemak with Prawn & Petai", 900, ["hot"]],
  ]),

  // ---- SET · SET NASI PUTIH ----
  ...section("cat_setnasi", "set", 15, [
    ["ayammasakmerah", "Set Nasi Putih Ayam Masak Merah", "White Rice Set, Chicken Masak Merah", 1100],
    ["dagingmasakmerah", "Set Nasi Putih Daging Masak Merah", "White Rice Set, Beef Masak Merah", 1200],
    ["seafoodmasakmerah", "Set Nasi Putih Seafood Masak Merah", "White Rice Set, Seafood Masak Merah", 1300],
    ["ayampaprik", "Set Nasi Putih Ayam Paprik", "White Rice Set, Chicken Paprik", 1100, ["hot"]],
    ["seafoodpaprik", "Set Nasi Putih Seafood Paprik", "White Rice Set, Seafood Paprik", 1300, ["hot"]],
    ["paprikcampur", "Set Nasi Putih Paprik Campur", "White Rice Set, Mixed Paprik", 1300, ["hot"]],
    ["dagingkunyit", "Set Nasi Putih Daging Goreng Kunyit", "White Rice Set, Turmeric Beef", 1000],
    ["tomyamayam", "Set Nasi Putih Tomyam Ayam", "White Rice Set, Chicken Tomyam", 1100, ["hot"]],
    ["tomyamdaging", "Set Nasi Putih Tomyam Daging", "White Rice Set, Beef Tomyam", 1200, ["hot"]],
    ["tomyamcampur", "Set Nasi Putih Tomyam Campur", "White Rice Set, Mixed Tomyam", 1300, ["hot"]],
    ["tomyamseafood", "Set Nasi Putih Tomyam Seafood", "White Rice Set, Seafood Tomyam", 1300, ["hot"]],
    ["suptulang", "Set Nasi Putih Sup Tulang", "White Rice Set, Bone Soup", 1400],
    ["supayam", "Set Nasi Putih Sup Ayam", "White Rice Set, Chicken Soup", 1000],
    ["supdaging", "Set Nasi Putih Sup Daging", "White Rice Set, Beef Soup", 1200],
    ["supseafood", "Set Nasi Putih Sup Seafood", "White Rice Set, Seafood Soup", 1300],
    ["supsayur", "Set Nasi Putih Sup Sayur", "White Rice Set, Vegetable Soup", 1000],
  ]),

  // ---- GORENG / SUP · MEE / KUETIAU / BIHUN / MAGGI ----
  // The noodle and the goreng/sup choice are required options, both free, so
  // these nine rows cover what would otherwise be seventy-two.
  ...section("cat_mee", "mee", 10, [
    ["biasa", "Mee Biasa", "Noodles, Plain", 900],
    ["bandung", "Mee Bandung", "Mee Bandung", 900],
    ["kungfu", "Mee Kungfu", "Kungfu Noodles", 1000, ["best"]],
    ["seafoodkungfu", "Mee Seafood Kungfu", "Seafood Kungfu Noodles", 1200],
    ["tomyamthai", "Mee Tomyam Thai", "Thai Tomyam Noodles", 900, ["hot"]],
    ["tomyamthaiseafood", "Mee Tomyam Thai Seafood", "Thai Tomyam Seafood Noodles", 1200, ["hot"]],
    ["singapore", "Mee Singapore", "Singapore Noodles", 800],
    ["ladnaayam", "Mee Ladna Ayam", "Chicken Ladna Noodles", 900],
    ["ladnaseafood", "Mee Ladna Seafood", "Seafood Ladna Noodles", 1200],
  ]),

  // ---- 26 PILIHAN · NASI GORENG ----
  ...section("cat_nasigoreng", "ng", 10, [
    ["biasa", "Nasi Goreng Biasa", "Fried Rice, Plain", 800],
    ["seafood", "Nasi Goreng Seafood", "Seafood Fried Rice", 1200],
    ["kampung", "Nasi Goreng Kampung", "Kampung Fried Rice", 800, ["best", "hot"]],
    ["belacan", "Nasi Goreng Belacan", "Belacan Fried Rice", 800, ["hot"]],
    ["cilipadi", "Nasi Goreng Cili Padi", "Bird's Eye Chilli Fried Rice", 800, ["hot"]],
    ["ayamgoreng", "Nasi Goreng Ayam Goreng", "Fried Rice with Fried Chicken", 1000],
    ["ikanmasin", "Nasi Goreng Ikan Masin", "Salted Fish Fried Rice", 900],
    ["sardin", "Nasi Goreng Sardin", "Sardine Fried Rice", 900],
    ["pattaya", "Nasi Goreng Pattaya", "Pattaya Fried Rice", 900],
    ["pattayaayam", "Nasi Goreng Pattaya Ayam Goreng", "Pattaya Fried Rice with Fried Chicken", 1300],
    ["paprikayam", "Nasi Goreng Paprik Ayam", "Chicken Paprik Fried Rice", 1100, ["hot"]],
    ["paprikcampur", "Nasi Goreng Paprik Campur", "Mixed Paprik Fried Rice", 1300, ["hot"]],
    ["paprikseafood", "Nasi Goreng Paprik Seafood", "Seafood Paprik Fried Rice", 1300, ["hot"]],
    ["paprikdaging", "Nasi Goreng Paprik Daging", "Beef Paprik Fried Rice", 1200, ["hot"]],
    ["ayammasakmerah", "Nasi Goreng Ayam Masak Merah", "Fried Rice, Chicken Masak Merah", 1100],
    ["dagingmasakmerah", "Nasi Goreng Daging Masak Merah", "Fried Rice, Beef Masak Merah", 1200],
    ["seafoodmasakmerah", "Nasi Goreng Seafood Masak Merah", "Fried Rice, Seafood Masak Merah", 1300],
    ["ayamkunyit", "Nasi Goreng Ayam Goreng Kunyit", "Fried Rice with Turmeric Chicken", 1000],
    ["usaayam", "Nasi Goreng USA Ayam", "USA Chicken Fried Rice", 1200],
    ["usadaging", "Nasi Goreng USA Daging", "USA Beef Fried Rice", 1300],
    ["daging", "Nasi Goreng Daging", "Beef Fried Rice", 1100],
    ["tomyamthai", "Nasi Goreng Tomyam Thai", "Thai Tomyam Fried Rice", 900, ["hot"]],
    ["cendawan", "Nasi Goreng Cendawan", "Mushroom Fried Rice", 900],
    ["kerabu", "Nasi Goreng Kerabu", "Kerabu Fried Rice", 900],
    ["cina", "Nasi Goreng Cina", "Chinese Fried Rice", 900],
    ["vegetarian", "Nasi Goreng Vegetarian", "Vegetarian Fried Rice", 700],
  ]),

  // ---- GRILL · WESTERN FOOD ----
  ...section("cat_western", "west", 18, [
    ["chickenchop", "Chicken Chop", "Chicken Chop", 1390, ["best"]],
    ["chickengrill", "Chicken Grill", "Grilled Chicken", 1390],
    ["beefsteak", "Beef Steak", "Beef Steak", 1590],
    ["lambchop", "Lamb Chop", "Lamb Chop", 1690],
    ["mixedsteak", "Mixed Steak (Chicken & Beef)", "Mixed Steak (Chicken & Beef)", 1990],
    ["fishandchip", "Fish and Chip", "Fish and Chips", 1590],
  ]),

  // ---- ITALIANO · PASTA ----
  ...section("cat_pasta", "pasta", 15, [
    ["aglio", "Aglio e Olio", "Aglio e Olio", 1090],
    ["beefaglio", "Beef Aglio e Olio", "Beef Aglio e Olio", 1290],
    ["seafoodaglio", "Seafood Aglio e Olio", "Seafood Aglio e Olio", 1490],
    ["chickengrillaglio", "Chicken Grill Aglio e Olio", "Grilled Chicken Aglio e Olio", 1890],
    ["beefbolognese", "Beef Bolognese", "Beef Bolognese", 1390],
    ["chickenbolognese", "Chicken Bolognese", "Chicken Bolognese", 1290],
    ["carbonara", "Carbonara", "Carbonara", 1190],
    ["beefcarbonara", "Beef Carbonara", "Beef Carbonara", 1390],
    ["chickengrillcarbonara", "Chicken Grill Carbonara", "Grilled Chicken Carbonara", 1890],
  ]),

  // ---- SNEK · SIDE DISH ----
  ...section("cat_side", "side", 8, [
    ["mushroom", "Mushroom", "Mushroom", 700],
    ["garlicbread", "Garlic Bread", "Garlic Bread", 400],
    ["cheesywedges", "Cheesy Wedges", "Cheesy Wedges", 690],
    ["chickennugget", "Chicken Nugget", "Chicken Nuggets", 890],
    ["frenchfries", "French Fries", "French Fries", 690],
    ["jumbosausage", "Jumbo Sausage", "Jumbo Sausage", 890],
    ["meatball", "Meatball (5 Pieces)", "Meatballs (5 Pieces)", 1190],
  ]),

  // ---- PENYET & KUAH · INDONESIAN FOOD ----
  ...section("cat_indo", "indo", 15, [
    ["ayampenyet", "Set Nasi Ayam Penyet", "Ayam Penyet Rice Set", 1200, ["best", "hot"]],
    ["lelepenyet", "Set Nasi Lele Penyet", "Lele Penyet Rice Set", 1200, ["hot"]],
    ["dagingpenyet", "Set Nasi Daging Penyet", "Beef Penyet Rice Set", 1300, ["hot"]],
    ["tauhupenyet", "Set Tauhu Penyet", "Tauhu Penyet Set", 800, ["hot"]],
    ["bakso", "Bakso", "Bakso", 1000],
    ["soto", "Soto", "Soto", 1000],
  ]),

  // ---- PAGI · SARAPAN ----
  ...section("cat_sarapan", "sarapan", 6, [
    ["telurseparuh", "Telur Separuh Masak (2 Biji)", "Soft-Boiled Eggs (2)", 400],
    ["rotibakar", "Roti Bakar", "Toast", 300],
    ["goreng", "Mee / Kuetiau / Nasi / Bihun Goreng", "Fried Noodles or Rice", 400],
    ["lontong", "Lontong", "Lontong", 900],
    ["nasiimpit", "Nasi Impit dan Kuah", "Rice Cakes with Curry", 800],
  ]),

  // ---- SAYUR & TELUR · SET TAMBAHAN ----
  ...section("cat_tambahan", "tmb", 8, [
    ["kangkungbelacan", "Kangkung Belacan", "Water Spinach with Belacan", 700, ["hot"]],
    ["kailanikanmasin", "Kailan Ikan Masin", "Kailan with Salted Fish", 800],
    ["sayurcampur", "Sayur Campur", "Mixed Vegetables", 800],
    ["telurbungkus", "Telur Bungkus", "Omelette Parcel", 800],
    ["telurbistik", "Telur Bistik", "Telur Bistik", 800],
    ["telurdadar", "Telur Dadar", "Omelette", 300],
    ["telurmata", "Telur Mata", "Fried Egg", 200],
  ]),

  // ---- CANAI PANAS · ROTI ----
  ...section("cat_roti", "roti", 6, [
    ["kosong", "Roti Kosong", "Roti Canai, Plain", 180, ["best"]],
    ["telur", "Roti Telur", "Roti Canai with Egg", 300],
    ["telurcili", "Roti Telur Cili", "Roti Canai with Egg & Chilli", 350, ["hot"]],
    ["telurbawang", "Roti Telur Bawang", "Roti Canai with Egg & Onion", 350],
    ["telurcilibawang", "Roti Telur Cili Bawang", "Roti Canai with Egg, Chilli & Onion", 400, ["hot"]],
    ["telurplanta", "Roti Telur Planta", "Roti Canai with Egg & Margarine", 400],
    ["telurdouble", "Roti Telur Double", "Roti Canai with Double Egg", 600],
    ["bawang", "Roti Bawang", "Roti Canai with Onion", 250],
    ["bom", "Roti Bom", "Roti Bom", 250],
    ["pisang", "Roti Pisang", "Roti Canai with Banana", 350],
    ["milo", "Roti Milo", "Roti Canai with Milo", 350],
    ["kaya", "Roti Kaya", "Roti Canai with Kaya", 300],
    ["susu", "Roti Susu", "Roti Canai with Condensed Milk", 300],
    ["tampal", "Roti Tampal", "Roti Tampal", 300],
    ["cheese", "Roti Cheese", "Roti Canai with Cheese", 400],
    ["sarangburung", "Roti Sarang Burung", "Roti Sarang Burung", 500],
    ["jantan", "Roti Jantan", "Roti Jantan", 450],
  ]),

  // ---- BURGER ----
  // Deliberately empty: nothing on the printed card yet.

  // ---- PANAS & SEJUK · MINUMAN ----
  ...section("cat_minum", "min", 3, [
    ["teho", "Teh O", "Black Tea", 200],
    ["tehtarik", "Teh Tarik", "Teh Tarik", 250, ["best"]],
    ["tehhalia", "Teh Halia", "Ginger Tea", 300],
    ["tehlimau", "Teh Limau", "Lime Tea", 250],
    ["tehc", "Teh C", "Teh C", 250],
    ["sirap", "Sirap", "Rose Syrup", 200],
    ["siraplimau", "Sirap Limau", "Rose Syrup with Lime", 250],
    ["bandung", "Bandung", "Bandung", 300],
    ["kopio", "Kopi O", "Black Coffee", 200],
    ["kopisusu", "Kopi Susu", "Coffee with Milk", 250],
    ["cam", "Cam", "Cham", 250],
    ["susu", "Susu", "Milk", 200],
    ["horlick", "Horlick", "Horlicks", 300],
    ["milo", "Milo", "Milo", 300, ["best"]],
    ["nescafeo", "Nescafe O", "Nescafe O", 250],
    ["nescafe", "Nescafe", "Nescafe", 300],
    ["neslo", "Neslo", "Neslo", 350],
    ["barli", "Barli", "Barley", 250],
    ["limau", "Limau", "Lime", 250],
    ["lemon", "Lemon", "Lemon", 400],
    // Served cold as they are — no ice surcharge, only takeaway.
    ["milodinasour", "Milo Dinasour", "Milo Dinosaur", 400],
    ["fruitjuice", "Fruit Juice", "Fruit Juice", 550],
    ["softdrinks", "Soft Drinks (Coke, Sprite, dll.)", "Soft Drinks (Coke, Sprite, etc.)", 350],
    ["airsmall", "Drinking Water (Small)", "Drinking Water (Small)", 150],
    ["airbig", "Drinking Water (Big)", "Drinking Water (Big)", 250],
  ]),
];

/* ------------------------------------------------------------------ *
 * Modifier groups
 *
 * Every price here lives server-side. The phone sends option ids and the
 * server resolves each one against these tables, which is what stops a
 * customer setting their own price.
 * ------------------------------------------------------------------ */

/** The card's surcharge, in sen. */
const SURCHARGE_SEN = 50;

/**
 * Drinks the kitchen makes to order: hot as listed, +50 sen iced or bungkus.
 *
 * One single-select group rather than a "hot/iced" group plus a "takeaway"
 * group, because the owner charges the 50 sen ONCE. Two independent options
 * would stack to RM 1.00 the first time someone ordered an iced drink to take
 * away; with one choice, charging twice is not expressible.
 */
function servedHotOrCold(itemId: string): SeedModifierGroup {
  const slug = itemId.replace("itm_min_", "");
  return {
    id: `mg_${slug}_suhu`,
    menuItemId: itemId,
    nameMs: "Panas, ais atau bungkus?",
    nameEn: "Hot, iced or takeaway?",
    minSelect: 1,
    maxSelect: 1,
    options: [
      { id: `mo_${slug}_panas`, labelMs: "Panas", labelEn: "Hot" },
      { id: `mo_${slug}_ais`, labelMs: "Ais", labelEn: "Iced", priceDeltaSen: SURCHARGE_SEN, sortOrder: 1 },
      {
        id: `mo_${slug}_bkspanas`,
        labelMs: "Bungkus (panas)",
        labelEn: "Takeaway (hot)",
        priceDeltaSen: SURCHARGE_SEN,
        sortOrder: 2,
      },
      {
        id: `mo_${slug}_bksais`,
        labelMs: "Bungkus (ais)",
        labelEn: "Takeaway (iced)",
        priceDeltaSen: SURCHARGE_SEN,
        sortOrder: 3,
      },
    ],
  };
}

/**
 * Drinks that arrive cold anyway — a sealed bottle, a blended Milo Dinasour.
 * Nobody pays 50 sen to chill something that is already cold, so the only
 * surcharge these carry is takeaway.
 */
function servedCold(itemId: string): SeedModifierGroup {
  const slug = itemId.replace("itm_min_", "");
  return {
    id: `mg_${slug}_bungkus`,
    menuItemId: itemId,
    nameMs: "Makan sini atau bungkus?",
    nameEn: "Dine in or takeaway?",
    minSelect: 1,
    maxSelect: 1,
    options: [
      { id: `mo_${slug}_sini`, labelMs: "Makan sini", labelEn: "Dine in" },
      {
        id: `mo_${slug}_bungkus`,
        labelMs: "Bungkus",
        labelEn: "Takeaway",
        priceDeltaSen: SURCHARGE_SEN,
        sortOrder: 1,
      },
    ],
  };
}

/** Which noodle, and goreng or sup — the two headings over that section. */
function noodleChoices(itemId: string): SeedModifierGroup[] {
  const slug = itemId.replace("itm_mee_", "");
  return [
    {
      id: `mg_${slug}_jenis`,
      menuItemId: itemId,
      nameMs: "Pilih mee",
      nameEn: "Choose your noodle",
      minSelect: 1,
      maxSelect: 1,
      options: [
        { id: `mo_${slug}_mee`, labelMs: "Mee", labelEn: "Yellow noodles" },
        { id: `mo_${slug}_kuetiau`, labelMs: "Kuetiau", labelEn: "Kuetiau", sortOrder: 1 },
        { id: `mo_${slug}_bihun`, labelMs: "Bihun", labelEn: "Bihun", sortOrder: 2 },
        { id: `mo_${slug}_maggi`, labelMs: "Maggi", labelEn: "Maggi", sortOrder: 3 },
      ],
    },
    {
      id: `mg_${slug}_gorengsup`,
      menuItemId: itemId,
      nameMs: "Goreng atau sup?",
      nameEn: "Fried or soup?",
      minSelect: 1,
      maxSelect: 1,
      sortOrder: 1,
      options: [
        { id: `mo_${slug}_goreng`, labelMs: "Goreng", labelEn: "Fried" },
        { id: `mo_${slug}_sup`, labelMs: "Sup", labelEn: "Soup", sortOrder: 1 },
      ],
    },
  ];
}

/** Drinks made to order — the ones the ice surcharge applies to. */
const HOT_OR_COLD_DRINKS = [
  "itm_min_teho", "itm_min_tehtarik", "itm_min_tehhalia", "itm_min_tehlimau",
  "itm_min_tehc", "itm_min_sirap", "itm_min_siraplimau", "itm_min_bandung",
  "itm_min_kopio", "itm_min_kopisusu", "itm_min_cam", "itm_min_susu",
  "itm_min_horlick", "itm_min_milo", "itm_min_nescafeo", "itm_min_nescafe",
  "itm_min_neslo", "itm_min_barli", "itm_min_limau", "itm_min_lemon",
];

/** Already cold, or sealed: takeaway is the only surcharge. */
const ALWAYS_COLD_DRINKS = [
  "itm_min_milodinasour", "itm_min_fruitjuice", "itm_min_softdrinks",
  "itm_min_airsmall", "itm_min_airbig",
];

export const SEED_MODIFIER_GROUPS: SeedModifierGroup[] = [
  ...HOT_OR_COLD_DRINKS.map(servedHotOrCold),
  ...ALWAYS_COLD_DRINKS.map(servedCold),
  ...SEED_ITEMS.filter((i) => i.categoryId === "cat_mee").flatMap((i) =>
    noodleChoices(i.id),
  ),
];

export const SEED_OUTLETS = [
  { name: "Suriani Jalan Imbi (HQ)", tables: 16 },
  { name: "Suriani Hotel Leo", tables: 12 },
];

/**
 * Where each part of the menu prints.
 *
 * Kitchen is the default, so a category added later still reaches a printer
 * even before anyone routes it — food failing to print silently is the one
 * outcome this table exists to prevent. Roti goes to the kitchen; if a branch
 * puts a printer at the roti counter, that is one more station and one line
 * moved here.
 */
export const SEED_STATIONS = [
  {
    id: "st_kitchen",
    name: "Dapur",
    target: "kitchen",
    isDefault: true,
    sortOrder: 0,
    categoryIds: SEED_CATEGORIES.filter((c) => c.id !== "cat_minum").map((c) => c.id),
  },
  {
    id: "st_drinks",
    name: "Minuman",
    target: "drinks",
    sortOrder: 1,
    categoryIds: ["cat_minum"],
  },
  {
    id: "st_counter",
    name: "Kaunter",
    target: "counter",
    sortOrder: 2,
    categoryIds: [],
  },
];
