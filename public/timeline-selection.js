// Pointer selection shares one path for right-drag and explicit touch/left-drag mode.
export function bindTimelineSelection(
  track,
  { duration, enabled, preview, commit, cancel },
) {
  let drag = null;
  const timeAt = (x) => {
    const bounds = track.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(duration(), ((x - bounds.left) / bounds.width) * duration()),
    );
  };
  const range = (x) => {
    const end = timeAt(x);
    return { start: Math.min(drag.start, end), end: Math.max(drag.start, end) };
  };
  track.addEventListener("contextmenu", (event) => event.preventDefault());
  track.addEventListener(
    "pointerdown",
    (event) => {
      if (
        !(event.button === 2 || (event.button === 0 && enabled())) ||
        !(duration() > 0) ||
        !Number.isFinite(duration())
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      drag = { id: event.pointerId, start: timeAt(event.clientX) };
      track.setPointerCapture(event.pointerId);
      preview({ start: drag.start, end: drag.start });
    },
    true,
  );
  track.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    preview(range(event.clientX));
  });
  track.addEventListener("pointerup", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    const selected = range(event.clientX);
    const id = drag.id;
    drag = null;
    track.releasePointerCapture(id);
    if (selected.end - selected.start >= 0.1) commit(selected);
    else cancel();
  });
  const abort = () => {
    if (drag) {
      const id = drag.id;
      drag = null;
      if (track.hasPointerCapture(id)) track.releasePointerCapture(id);
      cancel();
    }
  };
  track.addEventListener("pointercancel", abort);
  track.addEventListener("lostpointercapture", abort);
  return abort;
}
