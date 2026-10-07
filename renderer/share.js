// Share-window renderer: plays the clip the main process hands over, then
// fades back to full transparency and reports done (main re-enables
// click-through). No state of its own beyond the currently playing clip.
const card = document.getElementById("card");
const clip = document.getElementById("clip");
const captionUser = document.getElementById("caption-user");
const captionText = document.getElementById("caption-text");

let settleTimer = null;

function settle() {
  clearTimeout(settleTimer);
  settleTimer = null;
  card.classList.add("hidden");
  // let the fade finish before clearing the frame + telling main
  setTimeout(() => {
    clip.removeAttribute("src");
    clip.load();
    window.share.done();
  }, 500);
}

window.share.onPlay(({ url, line, username, platform }) => {
  // hud = Jev's own announcements (test reading); otherwise it's a chatter
  captionUser.textContent = platform === "hud" ? username : `Jev reads ${username}`;
  captionText.textContent = line;
  clip.src = url;
  clip.muted = false;
  card.classList.remove("hidden");
  const p = clip.play();
  if (p && p.catch) p.catch(() => settle());
  // Fallback: if the media clock stalls (no audio device, codec hiccup),
  // still settle rather than leaving a frozen card on stream.
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, 120000);
});

clip.addEventListener("ended", settle);
clip.addEventListener("error", settle);

window.share.onArrange((on) => {
  document.body.classList.toggle("arranging", !!on);
});

// Arrange-mode chrome: ✕ saves the placement and exits; the corner grip
// resizes the window (screen coords, so the math survives the window
// resizing underneath the cursor).
document.getElementById("arrange-close").addEventListener("click", () => {
  window.share.arrangeDone();
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
  window.share.setSize(resizing.w + (e.screenX - resizing.x), resizing.h + (e.screenY - resizing.y));
});
grip.addEventListener("pointerup", () => {
  resizing = null;
});

window.share.onChroma((on) => {
  document.body.classList.toggle("chroma", !!on);
});
