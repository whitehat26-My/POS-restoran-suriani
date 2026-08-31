/**
 * Which docket goes to which printer.
 *
 * This rule exists in two places that must never disagree: the Worker groups
 * an order's lines when it queues print jobs, and the tablet groups the same
 * lines itself when the internet is down and it has to print the docket on
 * its own. A cook holding a slip cannot tell which one produced it, so the
 * two must produce the same slips — and the only way to be sure of that is
 * for there to be one implementation, the way money arithmetic already is.
 *
 * Pure on purpose: callers hand in rows they have already loaded, from a
 * Durable Object's SQLite in one case and from the tablet's cache in the
 * other.
 */

export interface StationLike {
  id: string;
  name: string;
  /** "kitchen" | "drinks" | "counter" — what kind of paper comes out. */
  target: string;
  enabled: number;
  isDefault: number;
}

export interface StationRouteLike {
  stationId: string;
  categoryId: string;
}

/**
 * The station a category prints at, or the fallback.
 *
 * A category with no route still prints. That is deliberate: the alternative
 * is that adding a category to the menu silently stops its dishes reaching
 * the kitchen, and nobody finds out until a table has been waiting twenty
 * minutes for food nobody started cooking.
 */
export function fallbackStation<S extends StationLike>(
  stations: readonly S[],
): S | undefined {
  return (
    stations.find((s) => s.isDefault === 1) ??
    stations.find((s) => s.target === "kitchen") ??
    stations[0]
  );
}

/**
 * Group lines into one docket per station.
 *
 * A mixed order becomes one slip for the kitchen and one for the drinks
 * counter, each carrying only its own lines. Insertion order is preserved
 * inside each group so the docket reads in the order the customer chose.
 */
export function groupLinesByStation<L, S extends StationLike>(
  lines: readonly L[],
  opts: {
    stations: readonly S[];
    routes: readonly StationRouteLike[];
    /** menu item id → category id, for the items in these lines. */
    categoryByItem: ReadonlyMap<string, string>;
    menuItemIdOf: (line: L) => string;
  },
): { station: S; lines: L[] }[] {
  const enabled = opts.stations.filter((s) => s.enabled === 1);
  const fallback = fallbackStation(enabled);
  if (!fallback) return [];

  const stationByCategory = new Map(
    opts.routes.map((r) => [r.categoryId, r.stationId]),
  );

  const grouped = new Map<string, L[]>();
  for (const line of lines) {
    const categoryId = opts.categoryByItem.get(opts.menuItemIdOf(line));
    const stationId =
      (categoryId ? stationByCategory.get(categoryId) : undefined) ??
      fallback.id;
    const list = grouped.get(stationId) ?? [];
    list.push(line);
    grouped.set(stationId, list);
  }

  return [...grouped].map(([stationId, groupLines]) => ({
    station: enabled.find((s) => s.id === stationId) ?? fallback,
    lines: groupLines,
  }));
}
