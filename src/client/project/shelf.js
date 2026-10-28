// A project's shelf, fetched once per room revision. The revision is claimed before the fetch starts, and a failed fetch is
// kept as failed (list null): neither is asked again until the room changes or the panel shows another project, so a server
// that is down or restarting is not asked in a loop. `get(slug)` resolves to the list or throws; `changed` runs when a fetch settles.
export function shelfLoader(get, changed) {
  let shelf = null; // { slug, rev, list, failed }
  const load = async (r) => {
    const mine = { slug: r.slug, rev: r.rev, list: shelf?.slug === r.slug ? shelf.list : null, failed: false };
    shelf = mine;
    try {
      mine.list = await get(r.slug);
    } catch {
      mine.failed = true;
    }
    if (shelf === mine) changed();
  };
  return {
    // The shelf to show for room `r` (null before its first fetch), fetching it when this revision has not been asked for.
    of(r) {
      if (!shelf || shelf.slug !== r.slug || shelf.rev !== r.rev) load(r);
      return shelf.slug === r.slug ? shelf : null;
    },
    reset() { shelf = null; },
    // The project is shown again: a shelf that failed is asked for once more (the server may be back at the same revision).
    retry() { if (shelf?.failed) shelf = null; },
  };
}
