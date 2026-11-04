import '@videojs/html/video/player';
import '@videojs/html/video/skin';
import '@videojs/html/audio/player';
import '@videojs/html/audio/skin';

// Video.js 10.3.0 is pinned. This adapter adds annotations to its packaged skin;
// playback, accessibility, responsiveness and auto-hide remain library-owned.
// Keep private skin selectors here and verify them when upgrading Video.js.
export function connectReviewPlayer(host, onMark) {
  const skin = host.querySelector('video-skin, audio-skin');
  const root = skin.shadowRoot;
  const timeline = root.querySelector('media-time-slider');
  const controls = root.querySelector('media-controls');
  if (!timeline || !controls) throw new Error('The playback controls could not initialize.');
  const media = host.querySelector('video, audio');
  const sheet = document.createElement('style');
  sheet.textContent = `
    media-cast-button[aria-disabled="true"], media-airplay-button[aria-disabled="true"] { display: none; }
    media-time-slider { position: relative; }
    .review-marks { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
    .review-marker { position: absolute; top: calc(50% - 8px); height: 5px; min-width: 4px; padding: 0; border: 0; border-radius: 2px; background: #9cd9ad; pointer-events: auto; cursor: pointer; }
    .review-marker.question { background: #ffd27e; }
    .review-marker.point { width: 5px; height: 12px; top: calc(50% - 6px); transform: translateX(-50%); }
    .review-marker:hover, .review-marker:focus-visible { outline: 2px solid white; z-index: 4; }
    .review-selection { position: absolute; top: calc(50% - 11px); height: 22px; border: 1px solid white; background: #5bbf8680; pointer-events: none; }
    .review-selection[hidden] { display: none; }
    media-time-slider[data-selecting] { cursor: crosshair; touch-action: none; }
  `;
  root.append(sheet);
  const marks = document.createElement('span');
  marks.className = 'review-marks';
  timeline.append(marks);
  const draft = document.createElement('span');
  draft.className = 'review-selection';
  draft.hidden = true;
  marks.append(draft);
  // Stop marker clicks from also triggering a seek or a playback gesture.
  marks.addEventListener('pointerdown', e => { if (e.button === 0 && e.target.dataset.noteId && !timeline.hasAttribute('data-selecting')) { e.stopPropagation(); } });
  marks.addEventListener('click', e => {
    const id = e.target.dataset.noteId;
    if (!id || timeline.hasAttribute('data-selecting')) return;
    e.preventDefault(); e.stopPropagation(); onMark(id);
  });
  let zoom = 1, pan = null, offsetX = 0, offsetY = 0;
  const applyZoom = () => {
    const maxX = skin.clientWidth * (zoom - 1) / 2;
    const maxY = skin.clientHeight * (zoom - 1) / 2;
    offsetX = Math.max(-maxX, Math.min(maxX, offsetX));
    offsetY = Math.max(-maxY, Math.min(maxY, offsetY));
    media.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
    media.style.cursor = zoom > 1 ? 'grab' : '';
    media.style.touchAction = zoom > 1 ? 'none' : '';
  };
  // Intercept only gestures on the picture when zoomed; stock controls stay usable.
  const startPan = e => {
    if (zoom === 1 || e.button !== 0 || e.composedPath().some(el => el.localName?.startsWith('media-') && el.localName !== 'media-container')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    pan = { x: e.clientX, y: e.clientY, offsetX, offsetY };
    skin.setPointerCapture(e.pointerId);
  };
  skin.addEventListener('pointerdown', startPan, true);
  skin.addEventListener('pointermove', e => {
    if (!pan) return;
    e.preventDefault(); e.stopImmediatePropagation();
    offsetX = pan.offsetX + e.clientX - pan.x; offsetY = pan.offsetY + e.clientY - pan.y; applyZoom();
  }, true);
  skin.addEventListener('pointerup', e => { if (pan) { pan = null; e.stopImmediatePropagation(); } }, true);
  skin.addEventListener('pointercancel', () => { pan = null; });
  skin.addEventListener('lostpointercapture', () => { pan = null; });
  skin.addEventListener('click', e => { if (zoom > 1 && e.target === media) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  return {
    timeline,
    focusTimeline() { (timeline.querySelector('[role="slider"]') || timeline).focus({ preventScroll: true }); },
    renderMarks(notes) {
      marks.querySelectorAll('[data-note-id]').forEach(el => el.remove());
      const duration = media.duration;
      if (!(duration > 0) || !Number.isFinite(duration)) return;
      const laneEnds = [];
      for (const n of notes) {
        const el = document.createElement('button');
        const start = Math.min(100, n.time / duration * 100);
        const end = n.end_time == null ? start : Math.min(100, n.end_time / duration * 100);
        el.type = 'button'; el.className = `review-marker ${n.kind} ${n.end_time == null ? 'point' : ''}`;
        el.dataset.noteId = n.id; el.title = n.label;
        el.setAttribute('aria-label', n.label);
        // Notes list supplies the keyboard navigation without crowding seek controls.
        el.tabIndex = -1;
        el.style.left = `${start}%`;
        if (n.end_time != null) {
          let lane = laneEnds.findIndex(last => last <= start);
          if (lane < 0) lane = laneEnds.length;
          laneEnds[lane] = end;
          el.style.width = `${Math.max(0, end - start)}%`;
          el.style.top = `calc(50% - ${8 + (lane % 3) * 6}px)`;
        }
        marks.append(el);
      }
    },
    setSelection(enabled, range) {
      timeline.toggleAttribute('data-selecting', enabled);
      controls.setAttribute('visibility', enabled ? 'always' : (media.tagName === 'AUDIO' ? 'always' : 'auto'));
      draft.hidden = !range;
      if (range && media.duration > 0) {
        draft.style.left = `${range.start / media.duration * 100}%`;
        draft.style.width = `${(range.end - range.start) / media.duration * 100}%`;
      }
    },
    setZoom(value) { zoom = value; offsetX = 0; offsetY = 0; applyZoom(); },
  };
}
