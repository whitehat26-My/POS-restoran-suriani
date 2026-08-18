#!/usr/bin/env node
/**
 * The print agent.
 *
 * Claims jobs, writes the bytes to a printer over TCP, and reports back. It
 * is deliberately dumb: all layout lives on the server, so fixing a docket is
 * a deploy rather than a visit to a restaurant. This is also the reference
 * the Phase 5 Android implementation follows — same protocol, same acks, plus
 * a Bluetooth fallback the Node version has no use for.
 *
 *   API_URL=http://localhost:8787 \
 *   AGENT_TOKEN=dev_xxx.yyy \
 *   PRINTER_KITCHEN=127.0.0.1:9100 \
 *   PRINTER_DRINKS=127.0.0.1:9101 \
 *   node tools/print-agent/index.mjs
 */
import net from "node:net";

const API_URL = process.env.API_URL ?? "http://localhost:8787";
const TOKEN = process.env.AGENT_TOKEN;
const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const ONCE = process.argv.includes("--once");

if (!TOKEN) {
  console.error("AGENT_TOKEN is required (register one from the till).");
  process.exit(1);
}

/** target → host:port. A target with no printer configured fails loudly. */
const PRINTERS = {
  kitchen: process.env.PRINTER_KITCHEN,
  drinks: process.env.PRINTER_DRINKS ?? process.env.PRINTER_KITCHEN,
  counter: process.env.PRINTER_COUNTER ?? process.env.PRINTER_KITCHEN,
};

const auth = { Authorization: `Bearer ${TOKEN}` };

function send(target, bytes) {
  const address = PRINTERS[target];
  if (!address) {
    return Promise.reject(new Error(`no printer configured for ${target}`));
  }
  const [host, port] = address.split(":");

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(
      { host, port: Number(port) || 9100 },
      () => socket.end(bytes),
    );
    // A printer that accepts the connection then dies mid-write must not hang
    // the agent forever; the job returns via its lease.
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error("printer timeout"));
    });
    socket.on("close", (hadError) =>
      hadError ? reject(new Error("socket error")) : resolve(),
    );
    socket.on("error", reject);
  });
}

async function tick() {
  const res = await fetch(`${API_URL}/api/agent/jobs`, { headers: auth });
  if (!res.ok) {
    console.error(`claim failed: ${res.status}`);
    return 0;
  }
  const { jobs } = await res.json();

  for (const job of jobs) {
    const bytes = Buffer.from(job.escposBase64, "base64");
    try {
      await send(job.target, bytes);
      await ack(job.id, { ok: true, transport: "lan" });
      console.log(`✓ printed ${job.id} → ${job.target}`);
    } catch (err) {
      await ack(job.id, { ok: false, error: String(err.message ?? err) });
      console.error(`✗ ${job.id} → ${job.target}: ${err.message ?? err}`);
    }
  }
  return jobs.length;
}

function ack(jobId, body) {
  return fetch(`${API_URL}/api/agent/jobs/${jobId}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify(body),
  });
}

async function heartbeat() {
  await fetch(`${API_URL}/api/agent/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ appVersion: "node-agent/0.1", printers: PRINTERS }),
  }).catch(() => {});
}

console.log(`print-agent → ${API_URL}`);
console.log(`  printers: ${JSON.stringify(PRINTERS)}`);

if (ONCE) {
  const n = await tick();
  console.log(`handled ${n} job(s)`);
  process.exit(0);
}

await heartbeat();
setInterval(() => void heartbeat(), 60_000);
setInterval(() => void tick().catch((e) => console.error(e.message)), POLL_MS);
