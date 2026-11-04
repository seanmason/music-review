// Three stable grid slots: changing positions never remounts the audio player.
const KEY = "score-sound-layout-v1";
const defaults = () => ({
  slots: { score: "main", audio: "upper", notes: "lower" },
  width: 65,
  upper: 205,
  right: false,
});
export function setupWorkspaceLayout(onResize) {
  const grid = document.querySelector("#review-grid");
  let layout = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (
      saved &&
      ["score", "audio", "notes"].every((k) =>
        ["main", "upper", "lower"].includes(saved.slots?.[k]),
      ) &&
      new Set(Object.values(saved.slots)).size === 3
    ) {
      layout = {
        slots: saved.slots,
        width: Math.max(40, Math.min(75, Number(saved.width) || 65)),
        upper: Math.max(150, Math.min(500, Number(saved.upper) || 205)),
        right: !!saved.right,
      };
    }
  } catch {}
  const panes = [...grid.querySelectorAll("[data-pane]")];
  function apply(save = true) {
    grid.classList.toggle("main-right", layout.right);
    grid.style.setProperty("--main-width", `${layout.width}%`);
    grid.style.setProperty("--upper-height", `${layout.upper}px`);
    panes.forEach((p) => {
      p.style.gridArea = layout.slots[p.dataset.pane];
      p.dataset.slot = layout.slots[p.dataset.pane];
    });
    document
      .querySelector("#column-divider")
      .setAttribute("aria-valuenow", Math.round(layout.width));
    document
      .querySelector("#column-divider")
      .setAttribute("aria-valuemin", "40");
    document
      .querySelector("#column-divider")
      .setAttribute("aria-valuemax", "75");
    document.querySelector("#row-divider").setAttribute("aria-valuemin", "150");
    document
      .querySelector("#row-divider")
      .setAttribute(
        "aria-valuemax",
        String(Math.max(150, grid.clientHeight - 210)),
      );
    document
      .querySelector("#row-divider")
      .setAttribute("aria-valuenow", Math.round(layout.upper));
    if (save) {
      try {
        localStorage.setItem(KEY, JSON.stringify(layout));
      } catch {}
    }
    onResize();
  }
  function swap(a, b) {
    if (!a || a === b) return;
    [layout.slots[a], layout.slots[b]] = [layout.slots[b], layout.slots[a]];
    apply();
    document.querySelector("#toast").textContent =
      "Layout updated. Your arrangement is saved on this device.";
    document.querySelector("#toast").style.display = "block";
    setTimeout(
      () => (document.querySelector("#toast").style.display = "none"),
      3500,
    );
  }
  panes.forEach((p) => {
    const key = p.dataset.pane,
      handle = p.querySelector("[data-move]");
    let start = null,
      target = null,
      moved = false,
      suppressClick = false;
    const clearDrag = () => {
      start = null;
      target = null;
      moved = false;
      grid.classList.remove("arranging");
      panes.forEach((p) => p.classList.remove("drop-target"));
    };
    handle.onpointerdown = (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      handle.setPointerCapture(e.pointerId);
    };
    handle.onpointermove = (e) => {
      if (!start) return;
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6)
        return;
      moved = true;
      grid.classList.add("arranging");
      target = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest("[data-pane]");
      panes.forEach((p) =>
        p.classList.toggle(
          "drop-target",
          p === target && p.dataset.pane !== key,
        ),
      );
    };
    handle.onpointerup = (e) => {
      if (moved) {
        suppressClick = true;
        if (target && panes.includes(target)) swap(key, target.dataset.pane);
        setTimeout(() => {
          suppressClick = false;
        }, 0);
      }
      handle.releasePointerCapture(e.pointerId);
      clearDrag();
    };
    handle.onpointercancel = clearDrag;
    handle.onclick = () => {
      if (suppressClick) return;
      const modal = document.querySelector("#modal");
      modal.innerHTML = `<h2>Move ${key === "audio" ? "recording" : key} pane</h2><p>Choose a pane to swap with. You can also drag the handle onto another pane.</p><div class="actions">${panes
        .filter((other) => other !== p)
        .map(
          (other) =>
            `<button data-swap="${other.dataset.pane}">Swap with ${other.dataset.pane === "audio" ? "recording" : other.dataset.pane}</button>`,
        )
        .join("")}<button id="close-layout">Cancel</button></div>`;
      modal.showModal();
      modal.querySelector("#close-layout").onclick = () => modal.close();
      modal.querySelectorAll("[data-swap]").forEach(
        (b) =>
          (b.onclick = () => {
            swap(key, b.dataset.swap);
            modal.close();
            handle.focus();
          }),
      );
    };
  });
  function splitter(id, axis) {
    const el = document.querySelector(id);
    let active = false;
    el.onpointerdown = (e) => {
      if (e.button !== 0) return;
      active = true;
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    el.onpointermove = (e) => {
      if (!active) return;
      const r = grid.getBoundingClientRect();
      if (axis === "x")
        layout.width = Math.max(
          40,
          Math.min(
            75,
            (100 * (layout.right ? r.right - e.clientX : e.clientX - r.left)) /
              r.width,
          ),
        );
      else
        layout.upper = Math.max(
          150,
          Math.min(r.height - 210, e.clientY - r.top),
        );
      apply();
    };
    el.onpointerup = (e) => {
      active = false;
      el.releasePointerCapture(e.pointerId);
    };
    el.onpointercancel = () => {
      active = false;
    };
    el.onkeydown = (e) => {
      const minus = axis === "x" ? "ArrowLeft" : "ArrowUp",
        plus = axis === "x" ? "ArrowRight" : "ArrowDown";
      if (![minus, plus].includes(e.key)) return;
      e.preventDefault();
      const direction = e.key === plus ? 1 : -1;
      if (axis === "x")
        layout.width = Math.max(
          40,
          Math.min(75, layout.width + direction * (layout.right ? -2 : 2)),
        );
      else
        layout.upper = Math.max(
          150,
          Math.min(grid.clientHeight - 210, layout.upper + direction * 15),
        );
      apply();
    };
  }
  splitter("#column-divider", "x");
  splitter("#row-divider", "y");
  document.querySelector("#reset-layout").onclick = () => {
    layout = defaults();
    apply();
  };
  document.querySelector("#flip-layout").onclick = () => {
    layout.right = !layout.right;
    apply();
  };
  apply(false);
}
