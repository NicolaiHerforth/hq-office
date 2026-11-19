// Draws markup into an element by changing only what differs, so what is under the pointer or has the focus stays the
// same element: a press begun before a push ends where it began, and a field being typed in keeps its text, its
// selection and an input method's composition. Children with data-k are matched by it wherever they are; the rest
// by place and tag. A focused text field is left alone entirely.
const tpl = document.createElement("template");

export function morph(el, html) {
  tpl.innerHTML = html;
  children(el, tpl.content);
}

const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute("data-k") : null);
const alike = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName;

function children(a, b) {
  const keyed = new Map();
  for (const c of a.childNodes) { const k = keyOf(c); if (k != null) keyed.set(k, c); }
  let at = a.firstChild;
  for (const nb of [...b.childNodes]) {
    const k = keyOf(nb);
    let m = k != null ? keyed.get(k) : at && keyOf(at) == null && alike(at, nb) ? at : null;
    if (m && !alike(m, nb)) m = null;
    if (!m) { a.insertBefore(nb, at); continue; }
    if (k != null) keyed.delete(k);
    if (m === at) at = at.nextSibling;
    else a.insertBefore(m, at);
    patch(m, nb);
  }
  while (at) { const next = at.nextSibling; at.remove(); at = next; }
}

function patch(a, b) {
  if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  const field = a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && !/^(checkbox|radio)$/.test(a.type));
  if (field && a === document.activeElement) return;
  for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  if (a.tagName === "INPUT") { if (a.checked !== b.checked) a.checked = b.checked; if (a.value !== b.value) a.value = b.value; return; }
  if (a.tagName === "TEXTAREA") { if (a.value !== b.value) a.value = b.value; return; }
  children(a, b);
}
