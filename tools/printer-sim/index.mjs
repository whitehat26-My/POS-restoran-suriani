#!/usr/bin/env node
/**
 * A thermal printer that isn't there.
 *
 * Listens on :9100 exactly as an 80mm ESC/POS printer does, decodes what it
 * receives and prints a plain-text rendering of the slip to the terminal — so
 * you can see the real docket, byte for byte, before owning hardware.
 *
 *   node tools/printer-sim/index.mjs [--port 9100] [--fail]
 *
 * --fail makes it drop every connection, which is how you exercise the retry
 * and the till's failure banner without unplugging anything.
 */
import net from "node:net";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]) || 9100;
const alwaysFail = args.includes("--fail");

const ESC = 0x1b;
const GS = 0x1d;

/** Decode the subset of ESC/POS we emit, and narrate the rest. */
function render(buf) {
  const out = [];
  let line = "";
  let bold = false;
  let width = 1;
  let height = 1;
  let align = "left";
  const notes = [];

  const flush = () => {
    if (!line.length) {
      out.push("");
      return;
    }
    let text = line;
    // Show emphasis the way the paper would: wide text is spaced out, tall
    // text is uppercased and marked, so a size bug is visible here.
    if (width > 1) text = text.split("").join(" ");
    const pad =
      align === "center"
        ? " ".repeat(Math.max(0, Math.floor((42 - text.length) / 2)))
        : align === "right"
          ? " ".repeat(Math.max(0, 42 - text.length))
          : "";
    out.push(pad + text + (bold ? "   «bold»" : "") + (height > 1 ? " «tall»" : ""));
    line = "";
  };

  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];

    if (b === ESC && buf[i + 1] === 0x40) { notes.push("init"); i += 1; continue; }
    if (b === ESC && buf[i + 1] === 0x61) { align = ["left","center","right"][buf[i+2]] ?? "left"; i += 2; continue; }
    if (b === ESC && buf[i + 1] === 0x45) { bold = buf[i + 2] === 1; i += 2; continue; }
    if (b === ESC && buf[i + 1] === 0x70) { notes.push("💰 CASH DRAWER KICK"); i += 4; continue; }
    if (b === GS && buf[i + 1] === 0x21) {
      const n = buf[i + 2];
      width = (n >> 4) + 1;
      height = (n & 0x0f) + 1;
      i += 2;
      continue;
    }
    if (b === GS && buf[i + 1] === 0x56) {
      flush();
      out.push("─".repeat(42) + "  ✂  " + (buf[i + 2] === 0 ? "full cut" : "partial cut"));
      i += 2;
      continue;
    }
    if (b === 0x0a) { flush(); continue; }
    line += String.fromCharCode(b);
  }
  flush();
  return { text: out.join("\n"), notes };
}

const server = net.createServer((socket) => {
  const chunks = [];
  socket.on("data", (d) => chunks.push(d));
  socket.on("close", () => {
    if (alwaysFail) return;
    const { text, notes } = render(Buffer.concat(chunks));
    console.log("\n" + "═".repeat(48));
    console.log(`  SLIP @ ${new Date().toLocaleTimeString()}`);
    console.log("═".repeat(48));
    console.log(text);
    if (notes.length) console.log("\n  " + notes.join(" · "));
    console.log("═".repeat(48) + "\n");
  });
  if (alwaysFail) socket.destroy();
});

server.listen(port, () => {
  console.log(
    alwaysFail
      ? `printer-sim on :${port} — FAILING every job on purpose`
      : `printer-sim on :${port} — waiting for dockets`,
  );
});
