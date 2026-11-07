// EXPORT in a brief's or a page's bar: index.js answers its click. v: the older version shown, if one is.
import { esc } from "../core/format.js";

export const exportButton = (page, v) => `<button class="btn-s" type="button" data-export="${esc(page)}"${v ? ` data-export-v="${esc(v)}"` : ""} aria-haspopup="dialog" aria-expanded="false">EXPORT</button>`;
