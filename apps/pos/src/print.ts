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
 * NOT YET WIRED TO A SCREEN. The transports and the claim/ack loop are here
 * and under test in `packages/printer`, but nothing calls `printPendingJobs`
 * yet: the tablet still needs a setup screen for its server URL, its agent
 * token and its printer addresses, and the server needs to accept a bearer
 * token from a different origin. Both are the next commit, and shipping a
 * half-wired screen would be worse than shipping none.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { runOnce, type RunReport, type Transport } from "@suriani/printer";

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

const CONFIG_KEY = "suriani_printers";

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
