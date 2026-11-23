const query = new URL(location.href).searchParams;
const host = new URLSearchParams({ site: query.get("site") ?? "all", host: query.get("host") ?? "" });
const sections = { tasks: "sop.html", accounts: "popup.html", models: "models.html" };
const fold = document.getElementById("fold");
const frames = document.getElementById("frames");
let fullHeight = 750;
let folded = false;

function select(name) {
  for (const [id, page] of Object.entries(sections)) {
    document.getElementById(id).setAttribute("aria-pressed", String(id === name));
    const frame = document.getElementById(id + "-frame");
    frame.hidden = id !== name;
    if (!frame.hidden && !frame.hasAttribute("src")) frame.src = page + "?" + host;
  }
}

for (const name of Object.keys(sections)) {
  document.getElementById(name).addEventListener("click", () => select(name));
}
fold.addEventListener("click", async () => {
  const current = await chrome.windows.getCurrent();
  if (!folded) fullHeight = current.height ?? fullHeight;
  folded = !folded;
  frames.hidden = folded;
  fold.textContent = folded ? "展开" : "收起";
  fold.setAttribute("aria-expanded", String(!folded));
  try {
    await chrome.windows.update(current.id, { height: folded ? 135 : fullHeight });
  } catch {
    // The panel can still collapse when the window manager controls its height.
  }
});
select("tasks");
