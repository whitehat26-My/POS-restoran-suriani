/**
 * Constant-time string comparison.
 *
 * `a === b` on a secret returns as soon as two bytes differ, so the time it
 * takes leaks how much of a guess was correct. Over enough requests that is
 * enough to recover the secret one character at a time.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}
