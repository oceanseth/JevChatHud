// Always-on avatar renderer: shows the identity still permanently and plays
// one clip at a time over it. Ordering and queueing live in the main process
// (voice_mirror) — this window just reports each clip done so the next can
// be handed over.
const still = document.getElementById("still");
const clip = document.getElementById("clip");

let settleTimer = null;

window.avatar.onStill((url) => {
  if (url) still.src = url;
  else still.removeAttribute("src");
});

function settle() {
  clearTimeout(settleTimer);
  settleTimer = null;
  clip.classList.add("hidden");
  clip.removeAttribute("src");
  clip.load();
  window.avatar.done();
}

window.avatar.onPlay(({ url }) => {
  clip.src = url;
  clip.muted = false;
  clip.classList.remove("hidden");
  const p = clip.play();
  if (p && p.catch) p.catch(() => settle());
  // Fallback: a stalled media clock (no audio device, codec hiccup) must not
  // freeze the queue behind a clip that never ends.
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, 120000);
});

clip.addEventListener("ended", settle);
clip.addEventListener("error", settle);

window.avatar.onArrange((on) => {
  document.body.classList.toggle("arranging", !!on);
});

// Arrange-mode chrome: ✕ saves the placement and exits; the corner grip
// resizes the window (screen coords, so the math survives the window
// resizing underneath the cursor).
document.getElementById("arrange-close").addEventListener("click", () => {
  window.avatar.arrangeDone();
});

const grip = document.getElementById("resize-grip");
let resizing = null;
grip.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  try {
    grip.setPointerCapture(e.pointerId);
  } catch {
    /* synthetic events have no active pointer to capture */
  }
  resizing = { x: e.screenX, y: e.screenY, w: window.innerWidth, h: window.innerHeight };
});
grip.addEventListener("pointermove", (e) => {
  if (!resizing) return;
  window.avatar.setSize(resizing.w + (e.screenX - resizing.x), resizing.h + (e.screenY - resizing.y));
});
grip.addEventListener("pointerup", () => {
  resizing = null;
});

window.avatar.onChroma((on) => {
  document.body.classList.toggle("chroma", !!on);
});
