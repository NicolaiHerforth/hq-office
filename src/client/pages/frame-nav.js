// A page frame sent to an address (a reload, a new version, the other theme) only once it has loaded the address it
// was last given. Chrome can drop a navigation asked for while the frame's first is still on its way, as it moves the
// frame into a process of its own, and the old version would stay on screen. A request made meanwhile waits for that
// load (the newest request wins), or at most WAIT, so a frame that never says it loaded is still sent on.
const WAIT = 5000;
const loaded = new WeakMap(); // frame -> the src it last finished loading
const waiting = new WeakMap(); // frame -> { src, timer }

function go(f, src) {
  const w = waiting.get(f);
  if (w) { clearTimeout(w.timer); waiting.delete(f); }
  if (!f.isConnected) return;
  loaded.delete(f); // on its way again
  f.setAttribute("src", src);
}
document.addEventListener("load", (e) => {
  const f = e.target;
  if (!(f instanceof HTMLIFrameElement)) return;
  loaded.set(f, f.getAttribute("src"));
  const w = waiting.get(f);
  if (w) go(f, w.src);
}, true);

// Sends the frame to src (its own address again: a reload).
export function navigateFrame(f, src = f.getAttribute("src")) {
  if (loaded.get(f) === f.getAttribute("src")) { go(f, src); return; }
  const w = waiting.get(f);
  if (w) { w.src = src; return; }
  waiting.set(f, { src, timer: setTimeout(() => go(f, waiting.get(f)?.src ?? src), WAIT) });
}
