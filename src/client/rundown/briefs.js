// RUNDOWN's briefs, fetched per project when its brief changes (the room's briefAt), not on every message in its room. A reply
// that comes back after the brief changed again is dropped, so an older brief never replaces a newer one. A failure is kept,
// not asked again in a loop, until the brief changes or RUNDOWN opens again (reset). `get(slug)` resolves to the brief's
// text or throws; `changed` runs when a current fetch settles.
export function briefLoader(get, changed) {
  const seen = new Map(); // slug -> { at, text, failed }
  const load = async (slug, at) => {
    const mine = { at, text: seen.get(slug)?.text ?? null, failed: false };
    seen.set(slug, mine);
    try {
      mine.text = await get(slug);
    } catch {
      mine.failed = true;
    }
    if (seen.get(slug) === mine) changed();
  };
  return {
    // The brief to show for a project whose brief was set at `at` (none when it has none), asking for it once per `at`.
    of(slug, at) {
      if (!at) return null;
      if (seen.get(slug)?.at !== at) load(slug, at);
      return seen.get(slug).text;
    },
    reset() { seen.clear(); },
  };
}
