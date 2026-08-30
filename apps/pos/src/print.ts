/**
 * Printing from the till.
 *
 * In a browser this does nothing: the Node agent in `tools/print-agent`, or
 * whatever else is registered, drains the queue. Inside the Android shell the
 * tablet *is* the agent — it claims its own jobs and prints them over the LAN,
 * falling back to Bluetooth when the router dies.
 *
 * That fallback is the whole reason the till is a native app at all. A WebView
 * cannot open a socket to a printer, so a web-only POS is one dead router away
 * from a kitchen that cannot see its orders.
 *
 * Wired to the Peranti screen: it registers the agent, stores the printer
 * addresses, and the till drains the queue on a timer while it is open.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { groupLinesByStation } from "@suriani/core/stations";
import {
  renderKitchenTicket,
  renderReceipt,
  renderTestSlip,
  type ReceiptLine,
} from "@suriani/escpos/templates";
import {
  printVia,
  runOnce,
  type RunReport,
  type Transport,
} from "@suriani/printer";

import { apiUrl } from "./base";

interface SurianiPrinterPlugin {
  printTcp(options: { host: string; port?: number; data: string }): Promise<{
    transport: string;
  }>;
  printBluetooth(options: { address: string; data: string }): Promise<{
    transport: string;
  }>;
  listPaired(): Promise<{ devices: { name: string; address: string }[] }>;
  requestBluetoothPermission(): Promise<{ granted: boolean }>;
}

const SurianiPrinter = registerPlugin<SurianiPrinterPlugin>("SurianiPrinter");

/** Where a station's printer lives. Set once during install, per tablet. */
export interface PrinterConfig {
  /** "192.168.1.50:9100" */
  lan?: string;
  /** A paired device's MAC address. */
  bluetooth?: string;
}

/** target ("kitchen" | "drinks" | "counter") → printer. */
export type PrinterMap = Record<string, PrinterConfig>;

/** Reported on the heartbeat, so a stale tablet is visible as a version. */
const APP_VERSION = "0.5.0";

const CONFIG_KEY = "suriani_printers";
const AGENT_KEY = "suriani_agent";

/**
 * The agent credential.
 *
 * Issued once by the server and stored on the tablet, because there is no
 * endpoint that can read it back — only its PBKDF2 hash is kept. Scoped to one
 * outlet, so the branch it belongs to is stored beside it: a tablet whose
 * agent is registered to Jalan Imbi will print Jalan Imbi's dockets no matter
 * which branch the cashier is looking at, and the setup screen says so rather
 * than letting that be a surprise at the printer.
 */
export interface AgentCredential {
  token: string;
  outletId: string;
  outletName: string;
}

export function loadAgent(): AgentCredential | null {
  try {
    const raw = localStorage.getItem(AGENT_KEY);
    return raw ? (JSON.parse(raw) as AgentCredential) : null;
  } catch {
    return null;
  }
}

export function saveAgent(agent: AgentCredential): void {
  localStorage.setItem(AGENT_KEY, JSON.stringify(agent));
}

export function forgetAgent(): void {
  localStorage.removeItem(AGENT_KEY);
}

export function loadPrinters(): PrinterMap {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}") as PrinterMap;
  } catch {
    return {};
  }
}

export function savePrinters(map: PrinterMap): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(map));
}

export const isTablet = (): boolean => Capacitor.isNativePlatform();

export const listPairedPrinters = () => SurianiPrinter.listPaired();
export const askBluetoothPermission = () =>
  SurianiPrinter.requestBluetoothPermission();

function transportsFor(map: PrinterMap, target: string): Transport[] {
  const config = map[target] ?? map.kitchen ?? {};
  const transports: Transport[] = [];

  // LAN first: it is faster, and it is the one that keeps working when the
  // tablet is across the room from the printer.
  if (config.lan) {
    const [host, port] = config.lan.split(":");
    transports.push({
      name: "lan",
      send: async (bytes) => {
        await SurianiPrinter.printTcp({
          host: host!,
          port: Number(port) || 9100,
          data: toBase64(bytes),
        });
      },
    });
  }

  if (config.bluetooth) {
    transports.push({
      name: "bluetooth",
      send: async (bytes) => {
        await SurianiPrinter.printBluetooth({
          address: config.bluetooth!,
          data: toBase64(bytes),
        });
      },
    });
  }

  return transports;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

/**
 * Claim, print and ack one round.
 *
 * The device token is the agent's credential — scoped to one outlet, so a
 * stolen tablet reaches one restaurant's print queue and cannot read a sale
 * or touch a bill.
 */
export async function printPendingJobs(
  agentToken: string,
  printers: PrinterMap = loadPrinters(),
): Promise<RunReport> {
  const auth = { Authorization: `Bearer ${agentToken}` };

  return runOnce({
    claim: async () => {
      const res = await fetch(apiUrl("/api/agent/jobs"), { headers: auth });
      if (!res.ok) throw new Error(`claim failed: ${res.status}`);
      return (await res.json()).jobs;
    },
    ack: async (jobId, body) => {
      await fetch(apiUrl(`/api/agent/jobs/${jobId}/ack`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify(body),
      });
    },
    transportsFor: (target) => transportsFor(printers, target),
    decode: fromBase64,
  });
}

/**
 * Send a slip to one station's printer, now, and say what happened.
 *
 * The install question this answers is not "does the server work" — it is
 * "can this tablet reach that printer", which nothing else on the setup
 * screen can prove. So it deliberately skips the queue: no agent token, no
 * server round trip, straight down the same transports a real docket takes.
 *
 * The error is returned rather than swallowed, because "lan: connect timed
 * out after 1500ms" tells an installer to check the printer's IP, while a
 * bare "gagal" tells them to phone someone.
 */
export async function testPrint(
  target: string,
  stationName: string,
  outletName: string,
  printers: PrinterMap = loadPrinters(),
): Promise<{ transport: string }> {
  const transports = transportsFor(printers, target);
  if (transports.length === 0) {
    throw new Error("Tiada alamat pencetak disimpan untuk stesen ini.");
  }
  const bytes = renderTestSlip({ outletName, stationName, at: new Date() });
  const { transport } = await printVia(transports, bytes);
  return { transport };
}

/**
 * Tell the server this tablet is alive and what it is pointed at.
 *
 * Cheap, and it is the only way an owner looking at the control plane can
 * tell "the kitchen printer is unplugged" from "the tablet has been off since
 * Tuesday". Failure is ignored on purpose: a heartbeat that cannot be
 * delivered is precisely the situation it reports, and throwing here would
 * take the print loop down with it.
 */
export async function sendHeartbeat(
  agentToken: string,
  printers: PrinterMap = loadPrinters(),
): Promise<void> {
  try {
    await fetch(apiUrl("/api/agent/heartbeat"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({ appVersion: APP_VERSION, printers }),
    });
  } catch {
    /* offline; the next round tries again */
  }
}

/* ------------------------------------------------------------------ *
 * Printing an order the tablet took itself
 *
 * The Worker renders every docket the print queue carries, and that stays
 * true: layout lives in one tested place so fixing a slip is a deploy rather
 * than a visit to a restaurant. This is the one exception, and it exists for
 * a reason the server cannot solve — during an outage the Worker is simply
 * not reachable, and a kitchen with no paper is a restaurant that has stopped.
 *
 * It renders with the same `renderKitchenTicket` and groups by the same
 * `groupLinesByStation` the Worker uses. A cook cannot tell which machine
 * produced a slip, so neither can drift from the other.
 * ------------------------------------------------------------------ */

export interface DocketLine {
  menuItemId: string;
  qty: number;
  name: string;
  modifiers: string[];
  notes: string | null;
}

export interface PrintedDockets {
  /** True only when every station's slip actually came out. */
  ok: boolean;
  printed: number;
  errors: string[];
}

export async function printOrderDockets(input: {
  outletName: string;
  tableLabel: string;
  orderCode: string;
  placedAt: Date;
  lines: DocketLine[];
  stations: {
    stations: {
      id: string;
      name: string;
      target: string;
      enabled: number;
      isDefault: number;
    }[];
    routes: { stationId: string; categoryId: string }[];
  };
  categoryByItem: ReadonlyMap<string, string>;
  printers?: PrinterMap;
}): Promise<PrintedDockets> {
  const printers = input.printers ?? loadPrinters();
  const report: PrintedDockets = { ok: false, printed: 0, errors: [] };

  const grouped = groupLinesByStation(input.lines, {
    stations: input.stations.stations,
    routes: input.stations.routes,
    categoryByItem: input.categoryByItem,
    menuItemIdOf: (l) => l.menuItemId,
  });

  // No stations configured, or no printer set up: say so plainly rather than
  // reporting success. The caller turns that into "let the server queue it".
  if (grouped.length === 0) {
    report.errors.push("no print station configured");
    return report;
  }

  for (const { station, lines } of grouped) {
    const bytes = renderKitchenTicket({
      outletName: input.outletName,
      stationName: station.name,
      tableLabel: input.tableLabel,
      orderCode: input.orderCode,
      placedAt: input.placedAt,
      lines: lines.map((l) => ({
        qty: l.qty,
        name: l.name,
        modifiers: l.modifiers,
        notes: l.notes,
      })),
    });

    try {
      await printVia(transportsFor(printers, station.target), bytes);
      report.printed += 1;
    } catch (err) {
      report.errors.push(
        `${station.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // All of them, or none of them counts. A two-station order where only the
  // drinks slip came out still needs the kitchen's, and the only mechanism
  // that will produce it is the server's queue.
  report.ok = report.errors.length === 0 && report.printed === grouped.length;
  return report;
}

/**
 * The receipt, printed by the tablet itself.
 *
 * Same rule as the kitchen docket: the tablet is the print agent for its own
 * restaurant, so routing a slip it can print through the cloud only hands the
 * job back to this device — and doing it directly means the outage path and
 * the everyday path are one path, exercised on every ordinary Tuesday.
 *
 * The drawer pulse rides on these bytes, which is the part that matters. A
 * cashier with money in their hand and a drawer that will not open is stuck
 * in a way no error message helps with.
 */
export async function printReceiptLocally(input: {
  outletName: string;
  tableLabel: string;
  orderCode: string;
  receiptNo?: number;
  paidAt: Date;
  lines: ReceiptLine[];
  totalSen: number;
  itemCount?: number;
  method: string;
  cashReceivedSen?: number;
  changeSen?: number;
  roundingSen?: number;
  discountSen?: number;
  paidSen?: number;
  balanceSen?: number;
  printers?: PrinterMap;
}): Promise<PrintedDockets> {
  const printers = input.printers ?? loadPrinters();
  const report: PrintedDockets = { ok: false, printed: 0, errors: [] };

  const transports = transportsFor(printers, "counter");
  if (transports.length === 0) {
    report.errors.push("no counter printer configured");
    return report;
  }

  const { printers: _ignored, ...receipt } = input;
  try {
    await printVia(transports, renderReceipt(receipt));
    report.printed = 1;
    report.ok = true;
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
  }
  return report;
}
