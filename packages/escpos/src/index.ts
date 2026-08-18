/**
 * A minimal ESC/POS encoder.
 *
 * No dependencies: this runs inside a Cloudflare Worker, and the output is
 * plain bytes that any 80mm thermal printer speaks.
 *
 * Only the commands a restaurant docket actually needs are here. A larger
 * library would mostly add barcode and image support we do not use, and every
 * command we do not emit is one that cannot be emitted wrongly.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type Align = "left" | "center" | "right";

export class EscPos {
  private readonly parts: number[] = [];
  private readonly encoder = new TextEncoder();

  /** ESC @ — reset to a known state. Always the first thing on the wire. */
  init(): this {
    return this.raw(ESC, 0x40);
  }

  raw(...bytes: number[]): this {
    this.parts.push(...bytes);
    return this;
  }

  /**
   * Text.
   *
   * Bahasa Malaysia is plain ASCII, so the default code page is safe and no
   * transliteration is needed. Any non-ASCII byte (a stray “smart quote”
   * pasted into a menu name) is replaced rather than emitted, because a raw
   * high byte prints as a random glyph and can desynchronise some printers.
   */
  text(value: string): this {
    const safe = value.replace(/[^\x20-\x7e]/g, (ch) =>
      ch === "’" || ch === "‘"
        ? "'"
        : ch === "“" || ch === "”"
          ? '"'
          : ch === "–" || ch === "—"
            ? "-"
            : "?",
    );
    this.parts.push(...this.encoder.encode(safe));
    return this;
  }

  line(value = ""): this {
    return this.text(value).feed(1);
  }

  feed(lines = 1): this {
    for (let i = 0; i < lines; i++) this.parts.push(LF);
    return this;
  }

  align(mode: Align): this {
    const n = mode === "center" ? 1 : mode === "right" ? 2 : 0;
    return this.raw(ESC, 0x61, n);
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /**
   * GS ! — character size. Width and height are 1–8 multipliers packed into
   * one byte: high nibble width, low nibble height.
   */
  size(width: 1 | 2 | 3, height: 1 | 2 | 3): this {
    return this.raw(GS, 0x21, ((width - 1) << 4) | (height - 1));
  }

  /** A full-width rule, for separating a docket's sections. */
  rule(width = 42, ch = "-"): this {
    return this.line(ch.repeat(width));
  }

  /** Left text and right text on one line, dot-padded. Used for money. */
  columns(left: string, right: string, width = 42): this {
    const gap = Math.max(1, width - left.length - right.length);
    return this.line(left + " ".repeat(gap) + right);
  }

  /** GS V — cut. Partial leaves a small tab so the slip does not fall. */
  cut(mode: "full" | "partial" = "partial"): this {
    return this.feed(4).raw(GS, 0x56, mode === "full" ? 0 : 1);
  }

  /**
   * ESC p — pulse the RJ11 drawer kick.
   *
   * Sent only for cash payments. Pin 0, 50ms on / 250ms off, the timings
   * nearly every drawer expects.
   */
  drawerKick(): this {
    return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa);
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.parts);
  }

  /** For transport over JSON to the print agent. */
  base64(): string {
    let binary = "";
    for (const byte of this.bytes()) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
}

/** Wrap a long dish name onto the slip without breaking mid-word. */
export function wrap(value: string, width: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}
