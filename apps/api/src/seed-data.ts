/**
 * The real Restoran Suriani menu, matching the Phase 0 prototype.
 *
 * Prices are integer sen. Two branches share this master menu; per-outlet
 * price and availability overrides arrive in Phase 7.
 */
import type { SeedCategory, SeedItem } from "./outlet/OutletDO";

export const SEED_CATEGORIES: SeedCategory[] = [
  { id: "cat_nasi", nameMs: "Nasi", nameEn: "Rice", sortOrder: 0 },
  { id: "cat_mee", nameMs: "Mee & Roti", nameEn: "Noodles & Roti", sortOrder: 1 },
  { id: "cat_minum", nameMs: "Minuman", nameEn: "Drinks", sortOrder: 2 },
  { id: "cat_manis", nameMs: "Pencuci Mulut", nameEn: "Desserts", sortOrder: 3 },
];

export const SEED_ITEMS: SeedItem[] = [
  {
    id: "itm_nasilemak",
    categoryId: "cat_nasi",
    nameMs: "Nasi Lemak Ayam Berempah",
    nameEn: "Nasi Lemak with Spiced Chicken",
    descMs: "Nasi santan, sambal tumis, telur, ikan bilis",
    descEn: "Coconut rice, sambal, egg, anchovies",
    priceSen: 1200,
    tags: ["best", "hot", "halal"],
    prepMinutes: 12,
  },
  {
    id: "itm_nasigoreng",
    categoryId: "cat_nasi",
    nameMs: "Nasi Goreng Kampung",
    nameEn: "Kampung Fried Rice",
    descMs: "Ikan bilis, kangkung, cili padi",
    descEn: "Anchovies, water spinach, bird's eye chilli",
    priceSen: 950,
    tags: ["hot", "halal"],
    prepMinutes: 10,
  },
  {
    id: "itm_ayam",
    categoryId: "cat_nasi",
    nameMs: "Ayam Goreng Berempah",
    nameEn: "Spiced Fried Chicken",
    descMs: "Dua ketul, rempah rumah",
    descEn: "Two pieces, house spice blend",
    priceSen: 750,
    tags: ["best", "halal"],
    prepMinutes: 14,
  },
  {
    id: "itm_meegoreng",
    categoryId: "cat_mee",
    nameMs: "Mee Goreng Mamak",
    nameEn: "Mamak Fried Noodles",
    descMs: "Mee kuning, tauhu, telur, kobis",
    descEn: "Yellow noodles, tofu, egg, cabbage",
    priceSen: 850,
    tags: ["best", "halal"],
    prepMinutes: 9,
  },
  {
    id: "itm_roti",
    categoryId: "cat_mee",
    nameMs: "Roti Canai Telur",
    nameEn: "Roti Canai with Egg",
    descMs: "Dihidang dengan dhal dan sambal",
    descEn: "Served with dhal and sambal",
    priceSen: 400,
    tags: ["halal"],
    prepMinutes: 6,
  },
  {
    id: "itm_tehtarik",
    categoryId: "cat_minum",
    nameMs: "Teh Tarik",
    nameEn: "Teh Tarik",
    descMs: "Panas atau ais",
    descEn: "Hot or iced",
    priceSen: 300,
    tags: ["best"],
    prepMinutes: 3,
  },
  {
    id: "itm_kopi",
    categoryId: "cat_minum",
    nameMs: "Kopi O Ais",
    nameEn: "Iced Black Coffee",
    descMs: "Kopi kaw, gula asing",
    descEn: "Strong brew, sugar on the side",
    priceSen: 320,
    prepMinutes: 3,
  },
  {
    id: "itm_milo",
    categoryId: "cat_minum",
    nameMs: "Milo Ais",
    nameEn: "Iced Milo",
    descMs: "Dengan serbuk di atas",
    descEn: "With powder on top",
    priceSen: 400,
    prepMinutes: 3,
  },
  {
    id: "itm_cendol",
    categoryId: "cat_manis",
    nameMs: "Cendol Pulut",
    nameEn: "Cendol with Glutinous Rice",
    descMs: "Gula melaka, santan pekat",
    descEn: "Palm sugar, thick coconut milk",
    priceSen: 650,
    prepMinutes: 5,
  },
];

export const SEED_OUTLETS = [
  { name: "Suriani Kampung Baru", tables: 16 },
  { name: "Suriani Bangi", tables: 12 },
];
