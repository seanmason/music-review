import { test } from "node:test";
import assert from "node:assert/strict";
import { bindTimelineSelection } from "../public/timeline-selection.js";
class Track extends EventTarget {
  getBoundingClientRect() {
    return { left: 10, width: 100 };
  }
  setPointerCapture(id) {
    this.capture = id;
  }
  releasePointerCapture() {
    this.capture = null;
  }
  hasPointerCapture(id) {
    return this.capture === id;
  }
}
function setup(enabled = false) {
  const track = new Track(),
    previews = [],
    committed = [];
  let cancelled = 0;
  const abort = bindTimelineSelection(track, {
    duration: () => 100,
    enabled: () => enabled,
    preview: (r) => previews.push(r),
    commit: (r) => committed.push(r),
    cancel: () => cancelled++,
  });
  const send = (type, x, button = 2) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX: x, button, pointerId: 1 });
    track.dispatchEvent(event);
    return event;
  };
  return {
    track,
    previews,
    committed,
    send,
    abort,
    cancelled: () => cancelled,
  };
}
test("right-drag selects a section in either direction and clamps to the recording", () => {
  const s = setup();
  assert.equal(s.send("pointerdown", 90).defaultPrevented, true);
  s.send("pointermove", 30);
  s.send("pointerup", 30);
  assert.deepEqual(s.committed, [{ start: 20, end: 80 }]);
  s.send("pointerdown", 30);
  s.send("pointerup", 200);
  assert.deepEqual(s.committed[1], { start: 20, end: 100 });
  assert.equal(s.send("contextmenu", 30).defaultPrevented, true);
});
test("ordinary left-drag remains a seek; marking mode supports left and touch pointer selection", () => {
  const normal = setup();
  assert.equal(normal.send("pointerdown", 30, 0).defaultPrevented, false);
  normal.send("pointerup", 80, 0);
  assert.equal(normal.committed.length, 0);
  const enabled = setup(true);
  enabled.send("pointerdown", 30, 0);
  enabled.send("pointerup", 80, 0);
  assert.deepEqual(enabled.committed, [{ start: 20, end: 70 }]);
});
test("clicks, pointer cancellation, and Escape abort do not commit a section", () => {
  const s = setup();
  s.send("pointerdown", 30);
  s.send("pointerup", 30);
  s.send("pointerdown", 30);
  s.send("pointercancel", 60);
  s.send("pointerdown", 30);
  s.abort();
  s.send("pointerup", 60);
  assert.equal(s.committed.length, 0);
  assert.equal(s.cancelled(), 3);
});
