/**
 * Menu presentation rules shared by the customer app and the till.
 *
 * One implementation for the same reason money arithmetic lives here: two
 * copies drift, and the two surfaces have to agree about what a dish is called.
 */

/**
 * The label to show when the category heading is already on screen beside it.
 *
 * The printed menu lists "Kampung" and "Belacan" under a big NASI GORENG
 * heading, and repeating the heading on every row wastes the width a phone
 * does not have. But the stored name stays full — "Nasi Goreng Kampung" —
 * because *Susu*, *Milo*, *Telur Mata* and *Ayam Goreng* each appear in two
 * sections at two prices, and a docket reading "1x Susu" for a Roti Susu is a
 * real mis-serve. So the shortening happens at render time, only where the
 * heading supplies the missing half.
 *
 * A name that does not sit under its category falls through unchanged rather
 * than being mangled: wrong-but-complete beats short-and-wrong.
 */
export function shortLabel(name: string, categoryName: string): string {
  const trimmed = name.trim();

  // "Mee / Kuetiau / Bihun / Maggi" is one category with four names in it.
  const prefixes = categoryName
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
    // Longest first, so "Nasi Goreng" wins over "Nasi" if both could match.
    .sort((a, b) => b.length - a.length);

  for (const prefix of prefixes) {
    if (
      trimmed.length > prefix.length + 1 &&
      trimmed.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase() &&
      trimmed[prefix.length] === " "
    ) {
      return trimmed.slice(prefix.length + 1);
    }
  }
  return trimmed;
}
