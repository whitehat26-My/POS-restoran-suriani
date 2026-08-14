/**
 * Printable table cards.
 *
 * Renders a print-ready page — one card per active table, sized for the A6
 * acrylic stands. The owner opens it and presses Print. Generating these here
 * rather than leaving people to paste URLs into a QR website means the outage
 * panel can never be forgotten off a card, and a newly added table always gets
 * a card that matches the ones already on the floor.
 */
import qrcode from "qrcode-generator";

export interface CardTable {
  label: string;
  qrToken: string;
}

export interface CardOptions {
  outletName: string;
  origin: string;
  outletId: string;
  tables: CardTable[];
  /** Set once Phase 5b exists; until then the outage panel is omitted. */
  localOrderUrl?: string | null;
  wifiSsid?: string | null;
  wifiPassword?: string | null;
}

/** Error correction M: survives a smudge or a thumbprint on a table card. */
function qrSvg(text: string, cellSize: number): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 0, scalable: true });
}

/** The standard WIFI: payload every phone camera understands natively. */
function wifiPayload(ssid: string, password?: string | null): string {
  const escape = (v: string) => v.replace(/([\\;,:"])/g, "\\$1");
  return password
    ? `WIFI:S:${escape(ssid)};T:WPA;P:${escape(password)};;`
    : `WIFI:S:${escape(ssid)};T:nopass;;`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function orderingUrl(
  origin: string,
  outletId: string,
  token: string,
): string {
  return `${origin}/t/${outletId}/${token}`;
}

export function renderCards(opts: CardOptions): string {
  const showOutage = Boolean(opts.localOrderUrl);

  const cards = opts.tables
    .map((table) => {
      const url = orderingUrl(opts.origin, opts.outletId, table.qrToken);

      const outage =
        showOutage && opts.localOrderUrl
          ? `<div class="outage">
               <p class="outage-title">Tiada internet? · No internet?</p>
               <div class="outage-grid">
                 ${
                   opts.wifiSsid
                     ? `<figure>
                          ${qrSvg(wifiPayload(opts.wifiSsid, opts.wifiPassword), 2)}
                          <figcaption>1. Sambung WiFi</figcaption>
                        </figure>`
                     : ""
                 }
                 <figure>
                   ${qrSvg(`${opts.localOrderUrl}/t/${opts.outletId}/${table.qrToken}`, 2)}
                   <figcaption>${opts.wifiSsid ? "2. " : ""}Pesan di sini</figcaption>
                 </figure>
               </div>
             </div>`
          : "";

      return `<section class="card${showOutage ? " has-outage" : ""}">
        <p class="shop">${escapeHtml(opts.outletName)}</p>
        <p class="table">${escapeHtml(table.label)}</p>
        <div class="qr">${qrSvg(url, 4)}</div>
        <p class="cta">Imbas untuk pesan</p>
        <p class="cta-en">Scan to order</p>
        ${outage}
      </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="ms">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.outletName)} — Kad Meja</title>
<style>
  :root {
    --enamel: #0B5D48;
    --ink: #101E19;
    --paper: #F6F4EC;
    --muted: #6B7169;
    --line: #E0DED2;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #fff; color: var(--ink);
    font-family: var(--sans); -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .card {
    width: 105mm; height: 148mm;           /* A6, the common table-stand size */
    padding: 12mm 10mm;
    display: flex; flex-direction: column; align-items: center;
    /* Centred when there is no outage panel, so a plain card does not sit
       crammed against the top edge with dead space beneath it. */
    justify-content: center;
    text-align: center; page-break-after: always; break-after: page;
    background: var(--paper);
    border: 1px solid var(--line);
  }
  .card.has-outage { justify-content: flex-start; }
  .card:last-child { page-break-after: auto; break-after: auto; }
  .shop {
    margin: 0; font-size: 11pt; font-weight: 800; letter-spacing: -0.01em;
    color: var(--enamel);
  }
  .table {
    margin: 2mm 0 6mm; font-family: var(--mono); font-size: 22pt; font-weight: 700;
    letter-spacing: 0.04em;
  }
  .qr { width: 52mm; height: 52mm; }
  .qr svg, .outage svg { width: 100%; height: 100%; display: block; }
  .qr svg { shape-rendering: crispEdges; }
  .cta { margin: 5mm 0 0; font-size: 12pt; font-weight: 700; }
  .cta-en { margin: 1mm 0 0; font-size: 9pt; color: var(--muted); }
  .outage {
    margin-top: auto; width: 100%; padding-top: 4mm;
    border-top: 1px dashed var(--line);
  }
  .outage-title {
    margin: 0 0 2mm; font-size: 7.5pt; font-weight: 700; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .outage-grid { display: flex; gap: 6mm; justify-content: center; }
  .outage figure { margin: 0; width: 20mm; }
  .outage figcaption { margin-top: 1mm; font-size: 6.5pt; color: var(--muted); }
  @page { size: A6; margin: 0; }
  @media screen {
    body { background: #EFEDE3; padding: 8mm; }
    .card { margin: 0 auto 6mm; box-shadow: 0 2px 12px rgba(16,30,25,.14); }
  }
</style>
</head>
<body>
${cards}
</body>
</html>`;
}
