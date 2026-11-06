// No pinch zoom on a phone. iOS Safari ignores user-scalable=no in the viewport for pinches; its gesture events
// still let a page refuse them. Double taps are handled in CSS (touch-action in core/layout.css).
const phone = matchMedia("(max-width: 1150px) and (pointer: coarse)");
for (const type of ["gesturestart", "gesturechange"]) document.addEventListener(type, (e) => { if (phone.matches) e.preventDefault(); }, { passive: false });

// iOS Safari applies :active on a tap only once the page listens for touches: this is what makes a press show.
document.addEventListener("touchstart", () => {}, { passive: true });
