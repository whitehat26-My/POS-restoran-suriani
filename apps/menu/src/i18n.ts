/**
 * Every visible string lives here, exactly as the Phase 0 prototype worked.
 * Adding a third language later is data entry, not rework.
 */
export type Lang = "ms" | "en";

const DICT = {
  ms: {
    cart_label: "Jumlah setakat ini",
    place: "Hantar Pesanan",
    placing: "Menghantar…",
    helper: "Tambah pesanan bila-bila masa sepanjang makan. Bil yang sama.",
    sold_out: "Habis",
    best: "Paling laris",
    hot: "Pedas",
    add: "Tambah",
    notes_ph: "Cth. kurang manis, tanpa cili, bungkus…",
    request_title: "Ada permintaan?",
    request_hint: "Tulis apa saja — dapur akan baca nota ini.",
    chip_manis: "Kurang manis",
    chip_pedas: "Kurang pedas",
    chip_cili: "Tanpa cili",
    chip_nasi: "Kurang nasi",
    chip_bungkus: "Bungkus",
    press_hint: "Tekan mana-mana hidangan untuk pilihan & nota.",
    cat_empty: "Belum ada menu dalam kategori ini.",
    qty: "Kuantiti",
    view_cart: "Lihat pesanan",
    your_cart: "Pesanan anda",
    empty_cart: "Belum ada apa-apa. Pilih dari menu dulu.",
    back_menu: "Kembali ke menu",
    remove: "Buang",
    total: "Jumlah",
    sent_title: "Pesanan diterima!",
    sent_body: "Dapur sedang menyediakan. Tunjukkan skrin ini jika perlu.",
    st_title: "Pesanan anda",
    st_eta: "lebih kurang",
    minta_bil: "Minta Bil",
    bill_requested: "Bil diminta — sila ke kaunter bila selesai.",
    call_waiter: "Panggil Pelayan",
    waiter_called: "Pelayan dipanggil. Sekejap ya!",
    st_1: "Diterima",
    st_2: "Sedang dimasak",
    st_3: "Dihidang",
    min: "min",
    order_more: "Pesan lagi",
    not_found_title: "Meja tidak dijumpai",
    not_found_body:
      "Kod QR ini tidak sah atau sudah ditukar. Sila panggil pekerja kami.",
    offline_note: "Tiada sambungan — menu dari simpanan. Pesanan dihantar bila talian kembali.",
    error_generic: "Maaf, ada masalah. Cuba sekali lagi.",
    error_option_required: "Sila buat pilihan yang diperlukan.",
    error_unavailable: "Maaf, ada item yang baru habis. Sila semak menu.",
    required: "Wajib pilih",
    choose_upto: "Pilih hingga",
  },
  en: {
    cart_label: "Running total",
    place: "Send Order",
    placing: "Sending…",
    helper: "Add to your order any time during the meal. Same bill.",
    sold_out: "Sold out",
    best: "Best seller",
    hot: "Spicy",
    add: "Add",
    notes_ph: "e.g. less sweet, no chilli, takeaway…",
    request_title: "Any request?",
    request_hint: "Write anything — the kitchen reads this note.",
    chip_manis: "Less sweet",
    chip_pedas: "Less spicy",
    chip_cili: "No chilli",
    chip_nasi: "Less rice",
    chip_bungkus: "Takeaway",
    press_hint: "Press any dish for options and a note.",
    cat_empty: "Nothing in this category yet.",
    qty: "Quantity",
    view_cart: "View order",
    your_cart: "Your order",
    empty_cart: "Nothing yet. Pick something from the menu.",
    back_menu: "Back to menu",
    remove: "Remove",
    total: "Total",
    sent_title: "Order received!",
    sent_body: "The kitchen is on it. Show this screen if asked.",
    st_title: "Your order",
    st_eta: "about",
    minta_bil: "Request Bill",
    bill_requested: "Bill requested — please see the counter when ready.",
    call_waiter: "Call Staff",
    waiter_called: "Staff on the way!",
    st_1: "Received",
    st_2: "Cooking",
    st_3: "Served",
    min: "min",
    order_more: "Order more",
    not_found_title: "Table not found",
    not_found_body:
      "This QR code is invalid or has been replaced. Please call our staff.",
    offline_note: "No connection — menu from cache. Orders send when you're back online.",
    error_generic: "Sorry, something went wrong. Please try again.",
    error_option_required: "Please make the required choice.",
    error_unavailable: "Sorry, something just sold out. Please check the menu.",
    required: "Required",
    choose_upto: "Choose up to",
  },
} as const;

export type Key = keyof (typeof DICT)["ms"];

export function makeT(lang: Lang) {
  return (k: Key): string => DICT[lang][k];
}

export function initialLang(): Lang {
  const stored = localStorage.getItem("suriani_lang");
  return stored === "en" ? "en" : "ms";
}

export function persistLang(lang: Lang) {
  localStorage.setItem("suriani_lang", lang);
}
