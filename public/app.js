import { bindTimelineSelection } from "/timeline-selection.js";
import { setupWorkspaceLayout } from "/layout.js";
import * as pdfjs from "/pdfjs/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.mjs";
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app"),
  modal = $("#modal");
let me,
  session,
  audioId,
  scoreId,
  pdf,
  page = 1,
  point = null,
  pinning = false,
  kind = "note",
  filter = "all",
  pdfGeneration = 0,
  renderTask,
  renderSequence = 0,
  zoom = "page",
  activePin = null,
  resizeObserver;
let selectingSection = false,
  sectionAnchor = null,
  sectionPreview = null,
  cancelTimelineDrag = null;
const codes = new Map();
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const clock = (t) =>
  `${Math.floor((t || 0) / 60)}:${String(Math.floor((t || 0) % 60)).padStart(2, "0")}`;
const fileUrl = (id) => `/api/sessions/${session.id}/files/${id}`;
async function api(url, body, method = "POST") {
  const opts =
    body === undefined
      ? {}
      : {
          method,
          headers:
            body instanceof FormData
              ? {}
              : { "Content-Type": "application/json" },
          body: body instanceof FormData ? body : JSON.stringify(body),
        };
  const r = await fetch("/api" + url, opts);
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || "Please try again.");
  return result;
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").style.display = "none"), 5000);
}
function error(el, e) {
  el.textContent = e.message;
}
function account() {
  $("#account").innerHTML = me
    ? `<span>${esc(me.name || "Owner")}</span><button class="quiet" id="logout">Sign Out</button>`
    : '<span class="muted">A space for thoughtful listening</span>';
  if (me)
    $("#logout").onclick = async () => {
      await api("/logout", {});
      location.hash = "";
      me = null;
      session = null;
      login();
    };
}
function login(owner = false) {
  account();
  app.innerHTML = `<section class="entry"><div class="entry-copy"><div class="eyebrow">Listen closely. Leave a note.</div><h1>Every Detail.<br>A Little Clearer.</h1><p class="muted">Bring recordings, scores, and thoughtful feedback together in one quiet space.</p><div class="steps"><span><b>01</b>Open Your Session</span><span><b>02</b>Listen & Follow Along</span><span><b>03</b>Share Your Notes</span></div></div><div class="entry-card"><h2>${owner ? "Your Library" : "Welcome In."}</h2><p class="muted">${owner ? "Sign in to create and manage your sessions." : "Enter your access code to open a session."}</p><form id="login-form">${owner ? '<div class="field"><label for="password">Library Password</label><input id="password" type="password" autocomplete="current-password" required></div>' : '<div class="field"><label for="code">Access Code</label><input class="code-input" id="code" placeholder="XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" required maxlength="30"></div><div class="field"><label for="name">Your Name</label><input id="name" autocomplete="name" placeholder="How should your notes be signed?" required maxlength="60"></div>'}<p class="error" id="login-error" role="alert"></p><button class="primary" type="submit">${owner ? "Open Library" : "Open Session"} <span aria-hidden="true">→</span></button></form><button class="quiet" id="switch-login">${owner ? "← Use an Access Code" : "Manage Library"}</button></div></section>`;
  $("#switch-login").onclick = () => login(!owner);
  $("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = $("button[type=submit]", e.target);
    b.disabled = true;
    try {
      await api(
        "/login",
        owner
          ? { password: $("#password").value }
          : { code: $("#code").value, name: $("#name").value },
      );
      me = await api("/me");
      account();
      if (me.admin) await library();
      else await openSession(me.sessionId);
    } catch (e) {
      error($("#login-error"), e);
    } finally {
      b.disabled = false;
    }
  };
}
async function library() {
  resizeObserver?.disconnect();
  session = null;
  location.hash = "";
  const list = await api("/sessions");
  account();
  app.innerHTML = `<section class="library"><div class="page-head"><div><div class="eyebrow">Your Workspace</div><h1>The Library</h1><p class="muted">A place for recordings, scores, and conversation.</p></div><button class="primary" id="create">+ New Session</button></div><div class="cards">${list.map((s) => `<article class="session-card"><div class="card-icon" aria-hidden="true">♫</div><h2>${esc(s.title)}</h2><p class="muted">${esc(s.description || "Ready for a closer listen.")}</p><small>${s.file_count} files &nbsp;·&nbsp; ${s.note_count} notes</small><button data-open="${s.id}">Open Session <span aria-hidden="true">→</span></button></article>`).join("")}</div>${list.length ? "" : '<div class="empty"><h2>Start with a Session</h2><p>Add your recordings and scores, then share a single access code.</p></div>'}</section>`;
  $("#create").onclick = createSession;
  app
    .querySelectorAll("[data-open]")
    .forEach(
      (b) => (b.onclick = () => openSession(b.dataset.open).catch(toastError)),
    );
}
function toastError(e) {
  toast(e.message);
}
function dialog(html) {
  modal.innerHTML = html;
  modal.showModal();
  modal
    .querySelectorAll("[data-close]")
    .forEach((b) => (b.onclick = () => modal.close()));
}
function createSession() {
  dialog(
    '<h2>A New Session</h2><p class="muted">Give your recordings and scores a home.</p><form id="new-session"><div class="field"><label for="title">Session Title</label><input id="title" placeholder="For example, Waltz in A minor" maxlength="120" required></div><div class="field"><label for="description">A Short Introduction <span class="muted">(optional)</span></label><textarea id="description" rows="3" maxlength="2000" placeholder="What would you like someone to listen for?"></textarea></div><p class="error" role="alert"></p><div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Create Session</button></div></form>',
  );
  $("#new-session").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const s = await api("/sessions", {
        title: $("#title").value,
        description: $("#description").value,
      });
      codes.set(s.id, s.code);
      modal.close();
      await openSession(s.id);
      toast("Session created. Add your files below.");
    } catch (e) {
      error($(".error", modal), e);
    }
  };
}
async function openSession(id) {
  selectingSection = false;
  sectionAnchor = null;
  sectionPreview = null;
  session = await api(`/sessions/${id}`);
  location.hash = id;
  resizeObserver?.disconnect();
  pdf = null;
  zoom = "page";
  activePin = null;
  page = 1;
  point = null;
  pinning = false;
  kind = "note";
  filter = "all";
  audioId = session.files.find((f) => ["audio", "video"].includes(f.kind))?.id;
  scoreId = session.files.find((f) => f.kind === "score")?.id;
  workspace();
  await loadScore();
}
const options = (type) =>
  session.files
    .filter((f) =>
      type === "audio" ? ["audio", "video"].includes(f.kind) : f.kind === type,
    )
    .map((f) => `<option value="${f.id}">${esc(f.name)}</option>`)
    .join("");
function workspace() {
  account();
  app.innerHTML = `<section class="workspace">${me.admin ? '<button class="quiet back" id="back">← All Sessions</button>' : ""}<div class="session-heading"><div><div class="eyebrow">Listening Room</div><h1 title="${esc(session.title)}">${esc(session.title)}</h1>${session.description ? `<button class="quiet session-details" id="session-details" aria-label="About This Session" title="About This Session">ⓘ</button>` : ""}</div>${me.admin ? '<div class="actions"><button id="add-files">+ Add Files</button><button class="primary" id="share">Share Session</button><button class="quiet" id="session-menu" aria-label="Session Options">•••</button></div>' : ""}</div>${me.admin ? `<div class="upload-zone" id="upload-zone" ${session.files.length ? "hidden" : ""}><label for="files">Add Scores and Recordings</label><input type="file" id="files" accept=".pdf,.aac,.m4a,.mp3,.wav,.ogg,.flac,.webm,.mp4,.mov" multiple><p class="muted">PDF, audio, and video · Up to 150 MB per file. Videos may take a few minutes to prepare.</p><p id="upload-status" role="status"></p></div>` : ""}<div class="layout-tools"><button id="flip-layout">Switch Sides</button><button id="reset-layout">Reset Layout</button></div><div class="review-grid" id="review-grid"><section class="panel score-panel" data-pane="score"><div class="panel-head"><h2>Score</h2><button class="pane-handle" draggable="false" data-move="score" aria-label="Move Score Pane" title="Drag to another pane, or click to choose a position">⠿</button>${scoreId ? `<label class="sr-only" for="score-select">Choose Score</label><select id="score-select">${options("score")}</select>` : ""}</div>${scoreId ? `<div class="score-toolbar"><div class="page-controls"><button id="prev-page" aria-label="Previous Page">←</button><span id="page-label">Page 1</span><button id="next-page" aria-label="Next Page">→</button></div><button class="quiet" id="pin-mode">＋ Mark Passage</button><label class="sr-only" for="score-zoom">Score Zoom</label><select id="score-zoom"><option value="page" selected>Fit Page</option><option value="width">Fit Width</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option></select><a id="download-score" href="${fileUrl(scoreId)}" target="_blank" rel="noopener">Open PDF ↗</a></div><div class="score-stage" id="score-stage"><div class="score-paper" id="score-paper"><canvas id="score-canvas" tabindex="0" aria-label="Score Page" aria-describedby="score-hint"></canvas><div id="pins"></div></div><p id="score-status" role="status">Opening score…</p></div><p class="hint" id="score-hint">Choose “Mark Passage”, then click a note or drag around a phrase.</p>` : '<div class="score-stage"><div class="empty">No score added yet.<br>You can still listen and leave notes.</div></div>'}</section><section class="panel audio-panel" data-pane="audio"><div class="audio-title"><h2>Recording</h2><button class="pane-handle" draggable="false" data-move="audio" aria-label="Move Recording Pane" title="Drag to another pane, or click to choose a position">⠿</button>${audioId ? `<label class="sr-only" for="audio-select">Choose Recording</label><select id="audio-select">${options("audio")}</select>` : ""}</div>${audioId ? `${playerMarkup()}<div id="recording-marks" class="recording-marks" aria-label="Recording Timeline"></div><div class="player-controls"><button id="play-toggle" type="button">Play</button><button id="mute-toggle" type="button" aria-label="Mute Recording">Mute</button><button id="fullscreen" type="button">Full Screen</button><button id="mark-section" type="button" aria-pressed="false">Mark Section</button><label class="volume-control" for="player-volume">Volume <input id="player-volume" type="range" min="0" max="1" step="0.05" value="1"></label><label id="video-zoom-control" for="video-zoom">Zoom <select id="video-zoom"><option value="1">Fit</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option></select></label></div><div class="audio-tools"><div><button id="rewind">↶ 10 sec</button> <button id="forward">10 sec ↷</button></div><label for="speed">Speed <select id="speed"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option></select></label></div><p id="audio-error" class="error" role="alert" hidden></p>` : '<p class="muted">No recording added yet. Notes on the score are welcome.</p>'}</section><aside class="panel notes-panel" data-pane="notes"><div class="panel-head"><h2>Notes & Questions <span class="muted" id="note-count"></span></h2><button class="pane-handle" draggable="false" data-move="notes" aria-label="Move Notes Pane" title="Drag to another pane, or click to choose a position">⠿</button><label for="filter" class="sr-only">Filter Notes</label><select id="filter" class="filter"><option value="all">All</option><option value="note">Notes</option><option value="question">Questions</option></select></div><div class="notes-scroll"><button type="button" id="toggle-compose" class="compose-toggle" aria-controls="note-form">Add Note or Question</button><form class="note-compose" id="note-form" ${session.notes.some((n) => !n.parent_id) ? "hidden" : ""}><div class="kind-tabs" aria-label="Note Type"><button type="button" class="active" data-kind="note" aria-pressed="true">Note</button><button type="button" data-kind="question" aria-pressed="false">Question</button></div><label for="note-body">What would you like to note?</label><textarea id="note-body" rows="3" maxlength="5000" required placeholder="A thought, a question, something to return to…"></textarea><div class="attachment-picker"><label for="note-target">Attach To</label><select id="note-target"><option value="general">General — No Location</option>${scoreId ? '<option value="score" selected>Score Only</option>' : ""}${audioId ? `<option value="recording" ${!scoreId ? "selected" : ""}>Recording Only</option>` : ""}${scoreId && audioId ? '<option value="both">Score and Recording</option>' : ""}</select></div>${audioId ? `<fieldset id="recording-location" hidden><legend>Recording Location</legend><label for="recording-scope">Mark</label><select id="recording-scope"><option value="point">A Moment</option><option value="section">A Section</option></select><div id="section-times" hidden><p id="selected-section">Select a section on the recording timeline.</p><details id="section-adjust"><summary>Adjust Times</summary><label for="section-start">Start</label><div class="time-entry"><input id="section-start" aria-describedby="section-help" inputmode="decimal" placeholder="0:00"><button type="button" id="use-start">Use Current Time</button></div><label for="section-end">End</label><div class="time-entry"><input id="section-end" aria-describedby="section-help" inputmode="decimal" placeholder="0:30"><button type="button" id="use-end">Use Current Time</button></div><p id="section-help" class="muted">Enter minutes:seconds, or seek in the recording and use its current time. Use the note text to name the piece or describe the section.</p></details></div></fieldset>` : ""}<input type="checkbox" id="attach-time" hidden ${!scoreId && audioId ? "checked" : ""}><input type="checkbox" id="attach-score" hidden ${scoreId ? "checked" : ""}><div class="attachment-summary">${audioId ? '<span id="time-summary" hidden>Current Position: <span id="current-time">0:00</span></span>' : ""}${scoreId ? '<span id="score-summary">Score: <span id="current-page">page 1</span></span>' : ""}</div><div class="attachment" id="point-label"></div>${scoreId ? '<div id="location-field" hidden><button type="button" class="quiet" id="clear-mark">Clear Mark</button></div>' : ""}<p class="error" id="note-error" role="alert" hidden></p><button class="primary" type="submit">Save Note</button></form><div class="notes-list" id="notes-list"></div><p class="hint">Notes are shared with everyone in this session.</p></div></aside><div class="pane-divider column-divider" id="column-divider" role="separator" tabindex="0" aria-label="Resize Main Pane" aria-orientation="vertical"></div><div class="pane-divider row-divider" id="row-divider" role="separator" tabindex="0" aria-label="Resize Side Panes" aria-orientation="horizontal"></div></div></section>`;
  if ($("#session-details"))
    $("#session-details").onclick = () =>
      dialog(
        `<h2>${esc(session.title)}</h2><p>${esc(session.description)}</p><div class="actions"><button data-close>Done</button></div>`,
      );
  $(".session-heading").append($(".layout-tools"));
  $("#toggle-compose").onclick = () => setComposer($("#note-form").hidden);
  setComposer(!$("#note-form").hidden);
  $("#note-target").onchange = syncNoteTarget;
  $("#note-body").onfocus = () => {
    if ($("#attach-time").checked) $("#player")?.pause();
  };
  syncNoteTarget();
  if (me.admin) {
    $("#back").onclick = () => library().catch(toastError);
    $("#add-files").onclick = () => {
      $("#upload-zone").hidden = !$("#upload-zone").hidden;
    };
    $("#files").onchange = uploadFiles;
    $("#share").onclick = share;
    $("#session-menu").onclick = () => {
      dialog(
        '<h2>Session Options</h2><p>Deleting this session permanently removes its files and notes.</p><div class="actions"><button data-close>Keep Session</button><button class="danger" id="delete-session">Delete Session</button></div>',
      );
      $("#delete-session").onclick = async () => {
        try {
          await api(`/sessions/${session.id}`, {}, "DELETE");
          modal.close();
          await library();
        } catch (e) {
          toastError(e);
        }
      };
    };
  }
  if (audioId) {
    $("#audio-select").value = audioId;
    $("#audio-select").onchange = (e) => switchRecording(e.target.value);
    bindPlayer();
    $("#play-toggle").onclick = async () => {
      const player = $("#player");
      if (player.paused) {
        try {
          await player.play();
        } catch {
          toast("The recording could not play. Try again when it has loaded.");
        }
      } else player.pause();
    };
    $("#player-volume").oninput = (e) => {
      $("#player").volume = Number(e.target.value);
      $("#player").muted = false;
    };
    $("#mute-toggle").onclick = () => {
      $("#player").muted = !$("#player").muted;
    };
    $("#fullscreen").onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await $(".audio-panel").requestFullscreen();
      } catch {
        toast("Full screen is unavailable in this browser.");
      }
    };
    $("#recording-scope").onchange = () => {
      $("#section-times").hidden = $("#recording-scope").value !== "section";
      if (!$("#section-times").hidden && !$("#section-start").value)
        initializeSection();
      syncSectionDraft();
    };
    $("#mark-section").onclick = () => {
      selectingSection = !selectingSection;
      sectionAnchor = selectingSection ? $("#player").currentTime : null;
      sectionPreview = null;
      $("#player").pause();
      updateSectionSelection();
      if (selectingSection) $("#recording-seek").focus();
    };
    $("#video-zoom").onchange = updateVideoZoom;
    $("#section-start").oninput = $("#section-end").oninput = syncSectionDraft;
    $("#use-start").onclick = () => {
      $("#section-start").value = inputTime($("#player").currentTime);
      syncSectionDraft();
    };
    $("#use-end").onclick = () => {
      $("#section-end").value = inputTime($("#player").currentTime);
      syncSectionDraft();
    };
    $("#rewind").onclick = () => {
      $("#player").currentTime = Math.max(0, $("#player").currentTime - 10);
    };
    $("#forward").onclick = () => {
      const a = $("#player");
      if (Number.isFinite(a.duration))
        a.currentTime = Math.min(a.duration, a.currentTime + 10);
    };
    $("#speed").onchange = (e) => {
      $("#player").playbackRate = Number(e.target.value);
    };
  }
  if (scoreId) {
    $("#score-select").value = scoreId;
    $("#score-select").onchange = async (e) => {
      scoreId = e.target.value;
      page = 1;
      $("#download-score").href = fileUrl(scoreId);
      await loadScore();
    };
    $("#prev-page").onclick = async () => {
      if (page > 1) {
        page--;
        await renderPage();
      }
    };
    $("#next-page").onclick = async () => {
      if (pdf && page < pdf.numPages) {
        page++;
        await renderPage();
      }
    };
    setupScoreSelection();
  }
  setupWorkspaceLayout(
    () => scheduleScoreRender(),
    session.files.find((f) => f.id === audioId)?.kind === "video",
  );
  if (scoreId) {
    resizeObserver = new ResizeObserver(() => scheduleScoreRender());
    resizeObserver.observe($("#score-stage"));
    $("#score-zoom").onchange = (e) => {
      zoom = e.target.value;
      renderPage().catch(toastError);
    };
    $("#clear-mark").onclick = () => {
      point = null;
      updateAttachments();
      drawPins();
    };
    $("#attach-score").onchange = updateAttachments;
  }

  document.querySelectorAll("[data-kind]").forEach(
    (b) =>
      (b.onclick = () => {
        kind = b.dataset.kind;
        $("#note-form button[type=submit]").textContent =
          kind === "question" ? "Save Question" : "Save Note";
        document.querySelectorAll("[data-kind]").forEach((t) => {
          t.classList.toggle("active", t === b);
          t.setAttribute("aria-pressed", t === b);
        });
      }),
  );
  $("#filter").onchange = (e) => {
    filter = e.target.value;
    renderNotes();
  };
  $("#note-form").onsubmit = saveNote;
  renderNotes();
}
function setComposer(open) {
  $("#note-form").hidden = !open;
  $("#toggle-compose").textContent = open
    ? "Hide Editor"
    : $("#note-body").value
      ? "Continue Writing"
      : "+ Add Note or Question";
  $("#toggle-compose").setAttribute("aria-expanded", String(open));
}
function playerMarkup() {
  const video = session.files.find((f) => f.id === audioId)?.kind === "video";
  return video
    ? `<div id="video-viewport" class="video-viewport" tabindex="0" aria-label="Video; zoom in to inspect, then drag or scroll to move around"><video id="player" playsinline preload="metadata" src="${fileUrl(audioId)}"></video></div>`
    : `<audio id="player" preload="metadata" src="${fileUrl(audioId)}"></audio>`;
}
function updateVideoZoom() {
  const viewport = $("#video-viewport");
  if (!viewport) return;
  const oldZoom = Number(viewport.dataset.zoom || 1),
    zoom = Number($("#video-zoom").value);
  const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / oldZoom;
  const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / oldZoom;
  viewport.dataset.zoom = zoom;
  viewport.style.setProperty("--video-zoom", zoom);
  viewport.scrollLeft = centerX * zoom - viewport.clientWidth / 2;
  viewport.scrollTop = centerY * zoom - viewport.clientHeight / 2;
  viewport.classList.toggle("zoomed", zoom > 1);
}
function bindVideoPan() {
  const viewport = $("#video-viewport");
  if (!viewport) return;
  let pan = null;
  viewport.onpointerdown = (e) => {
    if (e.button !== 0 || Number(viewport.dataset.zoom || 1) === 1) return;
    e.preventDefault();
    pan = {
      x: e.clientX,
      y: e.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    viewport.setPointerCapture(e.pointerId);
  };
  viewport.onpointermove = (e) => {
    if (!pan) return;
    viewport.scrollLeft = pan.left + pan.x - e.clientX;
    viewport.scrollTop = pan.top + pan.y - e.clientY;
  };
  viewport.onpointerup = viewport.onpointercancel = () => {
    pan = null;
  };
}
function updateSectionSelection() {
  const button = $("#mark-section"),
    track = $(".seek-track"),
    hint = $("#timeline-hint"),
    draft = $("#section-draft");
  if (!button || !track) return;
  button.textContent = selectingSection ? "Cancel Selection" : "Mark Section";
  button.setAttribute("aria-pressed", String(selectingSection));
  track.classList.toggle("selecting-section", selectingSection);
  hint.textContent = selectingSection
    ? "Drag across the timeline. Keyboard: move to the end with arrow keys, then Enter. Escape cancels."
    : "Right-click and drag on the timeline to mark a section, or choose Mark Section, then drag.";
  draft.hidden = !sectionPreview;
  if (sectionPreview && Number.isFinite($("#player").duration)) {
    draft.style.left = `${(sectionPreview.start / $("#player").duration) * 100}%`;
    draft.style.width = `${((sectionPreview.end - sectionPreview.start) / $("#player").duration) * 100}%`;
    hint.textContent = `${inputTime(sectionPreview.start)}–${inputTime(sectionPreview.end)} selected. ${selectingSection ? "Release the pointer or press Enter to add a note." : "Write a note to save this section."}`;
  }
}
async function selectRecordingSection(range) {
  if (document.fullscreenElement) await document.exitFullscreen();
  $("#player").pause();
  selectingSection = false;
  sectionPreview = range;
  $("#note-target").value =
    $("#attach-score").checked && point ? "both" : "recording";
  syncNoteTarget();
  $("#recording-scope").value = "section";
  $("#section-times").hidden = false;
  $("#section-start").value = inputTime(range.start);
  $("#section-end").value = inputTime(range.end);
  $("#section-adjust").open = false;
  $("#selected-section").textContent =
    `${inputTime(range.start)}–${inputTime(range.end)}`;
  setComposer(true);
  updateSectionSelection();
  $("#note-body").focus();
}
function syncSectionDraft() {
  sectionPreview = null;
  if ($("#recording-scope").value === "section") {
    try {
      const times = sectionTimes(
        $("#section-start").value,
        $("#section-end").value,
        $("#player").duration,
      );
      sectionPreview = { start: times.time, end: times.endTime };
      $("#selected-section").textContent =
        `${inputTime(times.time)}–${inputTime(times.endTime)}`;
    } catch {
      $("#selected-section").textContent =
        "Select a section on the timeline, or adjust its times.";
    }
  }
  updateSectionSelection();
}
function initializeSection() {
  $("#section-start").value = inputTime($("#player").currentTime);
  $("#section-end").value = "";
}
function inputTime(seconds) {
  const rounded = Math.round(seconds * 10) / 10;
  return `${Math.floor(rounded / 60)}:${(rounded % 60).toFixed(1).padStart(4, "0")}`;
}
function parseTime(value) {
  const parts = value.trim().split(":");
  if (
    !value.trim() ||
    parts.length > 2 ||
    parts.some((p) => !/^\d+(\.\d+)?$/.test(p))
  )
    throw new Error("Enter a time such as 1:30 or 90 seconds.");
  if (parts.length === 2 && (Number(parts[1]) >= 60 || !/^\d+$/.test(parts[0])))
    throw new Error("Use minutes:seconds, such as 1:30.");
  return parts.length === 2
    ? Number(parts[0]) * 60 + Number(parts[1])
    : Number(parts[0]);
}
function sectionTimes(start, end, duration) {
  const time = parseTime(start),
    endTime = end.trim() ? parseTime(end) : null;
  if (endTime === null || endTime <= time)
    throw new Error("Choose an end time later than the start.");
  if (Number.isFinite(duration) && endTime > duration + 0.05)
    throw new Error("The section must fit within the recording.");
  return {
    time,
    endTime: Number.isFinite(duration) ? Math.min(duration, endTime) : endTime,
  };
}
function recordingTimeLabel(n) {
  return n.end_time == null
    ? clock(n.time)
    : `${clock(n.time)}–${clock(n.end_time)}`;
}
function bindPlayer() {
  $("#player").onloadedmetadata = renderRecordingMarks;
  $("#player").ondurationchange = renderRecordingMarks;
  $("#fullscreen").hidden = $("#player").tagName !== "VIDEO";
  $("#video-zoom-control").hidden = $("#player").tagName !== "VIDEO";
  $("#video-zoom").value = "1";
  bindVideoPan();
  $("#play-toggle").textContent = "Play";
  $("#mute-toggle").textContent = "Mute";
  $("#mute-toggle").setAttribute("aria-label", "Mute Recording");
  $("#player").volume = Number($("#player-volume").value);
  $("#player").onplay = () => {
    $("#play-toggle").textContent = "Pause";
  };
  $("#player").onpause = $("#player").onended = () => {
    $("#play-toggle").textContent = "Play";
  };
  $("#player").onvolumechange = () => {
    $("#mute-toggle").textContent = $("#player").muted ? "Unmute" : "Mute";
    $("#mute-toggle").setAttribute(
      "aria-label",
      $("#player").muted ? "Unmute Recording" : "Mute Recording",
    );
  };
  renderRecordingMarks();
  $("#player").ontimeupdate = () => {
    $("#current-time").textContent = clock($("#player").currentTime);
    updatePlayhead();
  };
  $("#player").onerror = () => {
    $("#audio-error").hidden = false;
    $("#audio-error").textContent =
      "Recording could not load. Refresh the page and try again.";
  };
}
function switchRecording(id) {
  $("#player")?.pause();
  audioId = id;
  $("#recording-scope").value = "point";
  $("#section-times").hidden = true;
  $("#section-start").value = "";
  $("#section-end").value = "";
  $("#audio-select").value = id;
  ($("#video-viewport") || $("#player")).outerHTML = playerMarkup();
  selectingSection = false;
  sectionPreview = null;
  sectionAnchor = null;
  bindPlayer();
  $("#review-grid").dispatchEvent(
    new CustomEvent("recordingtypechange", {
      detail: $("#player").tagName === "VIDEO",
    }),
  );
  $("#player").playbackRate = Number($("#speed").value);
  $("#current-time").textContent = "0:00";
  $("#audio-error").hidden = true;
}
function syncNoteTarget() {
  const target = $("#note-target").value;
  $("#attach-time").checked = target === "recording" || target === "both";
  $("#attach-score").checked = target === "score" || target === "both";
  if ($("#attach-time").checked) $("#player")?.pause();
  if ($("#recording-location"))
    $("#recording-location").hidden = !$("#attach-time").checked;
  if ($("#time-summary"))
    $("#time-summary").hidden = !$("#attach-time").checked;
  if ($("#score-summary"))
    $("#score-summary").hidden = !$("#attach-score").checked;
  updateAttachments();
  drawPins();
}
function showUndo(sessionId, id) {
  clearTimeout(toast.timer);
  const box = $("#toast");
  box.replaceChildren(document.createTextNode("Removed. "));
  const button = document.createElement("button");
  button.textContent = "Undo";
  button.onclick = async () => {
    try {
      await api(`/sessions/${sessionId}/notes/${id}/restore`, {});
      if (session?.id === sessionId) await refreshNotes();
      toast("Restored.");
    } catch (e) {
      toastError(e);
    }
  };
  box.append(button);
  box.style.display = "block";
  button.focus({ preventScroll: true });
  toast.timer = setTimeout(() => (box.style.display = "none"), 15000);
}
async function loadScore() {
  const generation = ++pdfGeneration;
  if (!scoreId) return;
  pdf = null;
  $("#score-status").textContent = "Opening score…";
  try {
    const doc = await pdfjs.getDocument({
      url: fileUrl(scoreId),
      isEvalSupported: false,
      standardFontDataUrl: "/pdf-fonts/",
      cMapUrl: "/pdf-cmaps/",
      cMapPacked: true,
    }).promise;
    if (generation !== pdfGeneration) {
      doc.destroy();
      return;
    }
    pdf = doc;
    await renderPage();
  } catch (e) {
    if (generation === pdfGeneration && $("#score-status"))
      $("#score-status").textContent =
        "The score could not be displayed. Use “Open PDF” above to view it.";
  }
}
async function renderPage() {
  if (!pdf || !$("#score-canvas")) return;
  const sequence = ++renderSequence;
  if (renderTask) {
    renderTask.cancel();
    try {
      await renderTask.promise;
    } catch {}
  }
  const generation = pdfGeneration,
    requestedPage = page,
    doc = pdf;
  const p = await doc.getPage(requestedPage);
  if (
    sequence !== renderSequence ||
    generation !== pdfGeneration ||
    requestedPage !== page ||
    !$("#score-canvas")
  )
    return;
  const canvas = $("#score-canvas"),
    base = p.getViewport({ scale: 1 });
  const stage = $("#score-stage");
  const availableWidth = Math.max(180, stage.clientWidth - 40);
  const fitWidth = availableWidth / base.width;
  const scale =
    zoom === "page"
      ? Math.min(fitWidth, Math.max(180, stage.clientHeight - 40) / base.height)
      : fitWidth * (zoom === "width" ? 1 : Number(zoom));
  const width = base.width * scale;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = p.getViewport({ scale: scale * pixelRatio });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${width}px`;
  $("#score-paper").style.width = `${width}px`;
  renderTask = p.render({ canvasContext: canvas.getContext("2d"), viewport });
  try {
    await renderTask.promise;
  } catch (e) {
    if (e.name === "RenderingCancelledException") return;
    throw e;
  }
  if (sequence !== renderSequence) return;
  $("#score-status").textContent = "";
  $("#page-label").textContent = `Page ${page} of ${pdf.numPages}`;
  $("#prev-page").disabled = page <= 1;
  $("#next-page").disabled = page >= pdf.numPages;
  canvas.setAttribute(
    "aria-label",
    `Score Page ${page} of ${pdf.numPages}. Use the Open PDF link for the original document.`,
  );
  updateAttachments();
  drawPins();
}
function updateAttachments() {
  if ($("#current-page"))
    $("#current-page").textContent = point
      ? `marked ${point.width ? "passage" : "spot"} on page ${point.page || page}`
      : `page ${page}`;
  $("#point-label").textContent =
    point && $("#attach-score").checked ? "Exact score location selected." : "";
  if ($("#location-field"))
    $("#location-field").hidden = !$("#attach-score").checked || !point;
}
function drawPins() {
  if (!$("#pins")) return;
  const pins = session.notes.filter(
    (n) =>
      !n.parent_id && n.score_id === scoreId && n.page === page && n.x !== null,
  );
  $("#pins").replaceChildren();
  function draw(n, i, draft = false) {
    const region = n.width > 0 && n.height > 0;
    const el = document.createElement(draft ? "span" : "button");
    el.className = `${region ? "score-region" : "pin"} ${draft ? "draft-mark" : ""} ${activePin === n.id && !draft ? "active-mark" : ""}`;
    el.style.left = `${n.x * 100}%`;
    el.style.top = `${n.y * 100}%`;
    if (region) {
      el.style.width = `${n.width * 100}%`;
      el.style.height = `${n.height * 100}%`;
    }
    el.textContent = draft ? "+" : String(noteNumber(n));
    el.title = draft
      ? "Selected passage"
      : `${noteNumber(n)}. ${n.kind === "question" ? "Question" : "Note"}: ${n.body}`;
    el.setAttribute(
      "aria-label",
      draft ? "Selected passage" : `Go to note: ${n.body.slice(0, 80)}`,
    );
    if (!draft) {
      el.dataset.pin = n.id;
      el.onclick = () => {
        activePin = n.id;
        filter = "all";
        $("#filter").value = "all";
        renderNotes();
        drawPins();
        focusNote(n.id);
      };
    }
    $("#pins").append(el);
  }
  pins.forEach((n, i) => draw(n, i));
  if (
    point &&
    $("#attach-score").checked &&
    (!point.scoreId || (point.scoreId === scoreId && point.page === page))
  )
    draw(point, 0, true);
}
function setupScoreSelection() {
  const canvas = $("#score-canvas");
  let origin = null;
  const coords = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  };
  function finish() {
    point = { ...point, scoreId, page };
    origin = null;
    pinning = false;
    $("#score-paper").classList.remove("pinning");
    $("#pin-mode").textContent = "＋ Mark Passage";
    $("#note-target").value = $("#attach-time").checked ? "both" : "score";
    syncNoteTarget();
    $("#player")?.pause();
    $("#score-hint").textContent =
      "Location selected. Write your note or question, then save it.";
    updateAttachments();
    drawPins();
    setComposer(true);
    $("#note-body").focus({ preventScroll: true });
    if (matchMedia("(max-width: 600px)").matches)
      $("#note-body").scrollIntoView({ block: "center", behavior: "smooth" });
  }
  $("#pin-mode").onclick = () => {
    pinning = !pinning;
    $("#score-paper").classList.toggle("pinning", pinning);
    $("#pin-mode").textContent = pinning ? "Cancel Marking" : "＋ Mark Passage";
    $("#score-hint").textContent = pinning
      ? "Click a note or drag a box around a passage. Keyboard: focus the score, use arrows, then Enter. Escape cancels."
      : "Choose “Mark Passage”, then click a note or drag around a phrase.";
  };
  canvas.onpointerdown = (e) => {
    if (!pinning || e.button !== 0) return;
    e.preventDefault();
    origin = coords(e);
    point = { ...origin };
    canvas.setPointerCapture(e.pointerId);
    drawPins();
  };
  canvas.onpointermove = (e) => {
    if (!origin) return;
    const end = coords(e),
      width = Math.abs(end.x - origin.x),
      height = Math.abs(end.y - origin.y);
    point =
      width > 0.005 && height > 0.005
        ? {
            x: Math.min(origin.x, end.x),
            y: Math.min(origin.y, end.y),
            width,
            height,
          }
        : { ...origin };
    drawPins();
  };
  canvas.onpointerup = (e) => {
    if (!origin) return;
    canvas.releasePointerCapture(e.pointerId);
    finish();
  };
  canvas.onpointercancel = () => {
    origin = null;
    point = null;
    drawPins();
    updateAttachments();
  };
  canvas.onkeydown = (e) => {
    if (!pinning) return;
    if (e.key === "Escape") {
      point = null;
      $("#pin-mode").click();
      drawPins();
      updateAttachments();
      return;
    }
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(
        e.key,
      )
    )
      return;
    e.preventDefault();
    point ||= { x: 0.5, y: 0.5 };
    const step = e.shiftKey ? 0.002 : 0.01;
    if (e.key === "Enter") return finish();
    const dx =
      e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
    const dy = e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
    point = {
      x: Math.max(0, Math.min(1, point.x + dx)),
      y: Math.max(0, Math.min(1, point.y + dy)),
    };
    drawPins();
  };
}
function scheduleScoreRender() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (pdf && $("#score-canvas")) renderPage().catch(toastError);
  }, 120);
}
function focusNote(id) {
  const n = $(`[data-note="${id}"]`);
  if (n) {
    n.scrollIntoView({ behavior: "smooth", block: "center" });
    n.classList.add("highlight");
    setTimeout(() => n.classList.remove("highlight"), 2000);
  }
}
function noteNumber(note) {
  return (
    session.notes
      .filter((n) => !n.parent_id)
      .findIndex((n) => n.id === note.id) + 1
  );
}
function updatePlayhead() {
  const player = $("#player"),
    seek = $("#recording-seek"),
    progress = $("#recording-progress");
  if (!player || !seek) return;
  const ready = Number.isFinite(player.duration) && player.duration > 0;
  if (ready) {
    seek.value = player.currentTime;
    seek.setAttribute(
      "aria-valuetext",
      `${clock(player.currentTime)} of ${clock(player.duration)}`,
    );
    progress.style.width = `${Math.min(100, (player.currentTime / player.duration) * 100)}%`;
  }
  $("#playback-time").textContent =
    `${clock(player.currentTime)} / ${ready ? clock(player.duration) : "—"}`;
}
function renderRecordingMarks() {
  const container = $("#recording-marks"),
    player = $("#player");
  if (!container || !player) return;
  $("#mark-section").disabled = !(
    Number.isFinite(player.duration) && player.duration > 0
  );
  if (selectingSection && container.querySelector("#recording-seek")) return;
  const notes = session.notes
    .filter((n) => !n.parent_id && n.audio_id === audioId && n.time !== null)
    .sort((a, b) => a.time - b.time);
  const duration = player.duration,
    ready = Number.isFinite(duration) && duration > 0;
  const lanes = [];
  const markerSpacing = (28 / Math.max(100, container.clientWidth - 16)) * 100;
  const marks = ready
    ? notes
        .map((n) => {
          const start = Math.min(100, (n.time / duration) * 100),
            end =
              n.end_time == null
                ? start
                : Math.min(100, (n.end_time / duration) * 100);
          let lane = lanes.findIndex((last) => last + markerSpacing < start);
          if (lane < 0) lane = lanes.length;
          lanes[lane] = Math.max(end, start + markerSpacing);
          return `<button type="button" class="timeline-mark ${n.end_time == null ? "moment" : "section"} ${n.kind}" data-recording-mark="${n.id}" style="left:${start}%;width:${Math.max(end - start, 0)}%;top:${lane * 24}px" title="${esc(`${recordingTimeLabel(n)} · ${n.body}`)}" aria-label="${esc(`Jump to ${recordingTimeLabel(n)}, ${n.kind} ${noteNumber(n)}: ${n.body}`)}">${noteNumber(n)}${n.end_time == null ? "" : ` · ${esc(n.body.split("\n")[0])}`}</button>`;
        })
        .join("")
    : "";
  container.innerHTML = `<div class="integrated-timeline"><div class="seek-track"><span id="recording-progress"></span><span id="section-draft" hidden></span><input type="range" id="recording-seek" aria-label="Seek Recording" aria-describedby="timeline-hint" min="0" max="${ready ? duration : 1}" step="0.1" value="${player.currentTime}" ${ready ? "" : "disabled"}></div><div class="timeline-annotations" style="height:${lanes.length * 24}px">${marks}</div></div><div class="track-times"><span id="playback-time"></span><span>${notes.length} ${notes.length === 1 ? "mark" : "marks"}</span></div><p id="timeline-hint" class="timeline-hint"></p>`;
  $("#recording-seek").oninput = (e) => {
    if (ready) player.currentTime = Number(e.target.value);
    if (selectingSection) {
      sectionPreview = {
        start: Math.min(sectionAnchor, player.currentTime),
        end: Math.max(sectionAnchor, player.currentTime),
      };
      updateSectionSelection();
    }
    updatePlayhead();
  };
  cancelTimelineDrag = bindTimelineSelection($(".seek-track"), {
    duration: () => player.duration,
    enabled: () => selectingSection,
    preview: (range) => {
      $("#recording-seek").focus({ preventScroll: true });
      player.pause();
      selectingSection = true;
      sectionPreview = range;
      updateSectionSelection();
    },
    commit: (range) => selectRecordingSection(range).catch(toastError),
    cancel: () => {
      selectingSection = false;
      sectionPreview = null;
      updateSectionSelection();
    },
  });
  $("#recording-seek").onkeydown = (e) => {
    if (e.key === "Escape") {
      cancelTimelineDrag?.();
      selectingSection = false;
      sectionPreview = null;
      updateSectionSelection();
    } else if (
      e.key === "Enter" &&
      selectingSection &&
      sectionPreview?.end - sectionPreview?.start >= 0.1
    ) {
      e.preventDefault();
      selectRecordingSection(sectionPreview).catch(toastError);
    }
  };
  updateSectionSelection();
  container.querySelectorAll("[data-recording-mark]").forEach((button) => {
    button.onclick = () =>
      jumpToRecordingNote(
        notes.find((n) => n.id === button.dataset.recordingMark),
      ).catch(toastError);
  });
  updatePlayhead();
}
async function jumpToRecordingNote(n) {
  let player = $("#player");
  if (audioId !== n.audio_id) {
    switchRecording(n.audio_id);
    player = $("#player");
  }
  const seek = () => {
    player.currentTime = Math.min(
      n.time,
      Number.isFinite(player.duration) ? player.duration : n.time,
    );
  };
  if (player.readyState >= 1) seek();
  else player.addEventListener("loadedmetadata", seek, { once: true });
  activePin = n.id;
  filter = "all";
  $("#filter").value = "all";
  renderNotes();
  drawPins();
  focusNote(n.id);
  try {
    await player.play();
  } catch {
    toast("Press play to start from this point.");
  }
}
function renderNotes() {
  renderRecordingMarks();
  const roots = session.notes.filter((n) => !n.parent_id);
  $("#note-count").textContent = `(${roots.length})`;
  const list = roots.filter((n) => filter === "all" || n.kind === filter);
  const actions = (n) =>
    `<div class="note-actions">${!n.parent_id ? `<button data-reply="${n.id}">Reply</button>` : ""}${n.editable ? `<button data-edit="${n.id}">Edit</button><button class="remove-note" data-delete="${n.id}" aria-label="Remove ${n.parent_id ? "Reply" : n.kind === "question" ? "Question" : "Note"}">Remove</button>` : ""}</div>`;
  $("#notes-list").innerHTML =
    list
      .map(
        (n) =>
          `<article class="note" data-note="${n.id}"><div class="note-meta"><span class="note-number">${noteNumber(n)}</span><span class="tag ${n.kind}">${n.kind === "question" ? "Question" : "Note"}</span><span>${esc(n.author)}</span></div><div>${n.audio_id ? `<button class="jump" data-jump-audio="${n.id}">▶ ${recordingTimeLabel(n)}</button>` : ""}${n.score_id ? `<button class="jump" data-jump-score="${n.id}">◎ ${esc(n.x !== null ? (n.width ? "Marked Passage" : "Marked Spot") : "Page " + n.page)}${n.x !== null ? ` · p. ${n.page}` : ""}</button>` : ""}</div><p class="note-body">${esc(n.body)}</p>${actions(n)}${session.notes
            .filter((r) => r.parent_id === n.id)
            .map(
              (r) =>
                `<div class="reply"><small>${esc(r.author)}</small><p>${esc(r.body)}</p>${actions(r)}</div>`,
            )
            .join("")}</article>`,
      )
      .join("") ||
    `<div class="empty" style="border:none">${filter === "all" ? "Room for your first thought.<br>Pause anywhere and leave a note." : "No " + filter + "s yet."}</div>`;
  $("#notes-list")
    .querySelectorAll("[data-jump-audio]")
    .forEach(
      (b) =>
        (b.onclick = async () => {
          const n = session.notes.find((n) => n.id === b.dataset.jumpAudio);
          await jumpToRecordingNote(n);
        }),
    );
  $("#notes-list")
    .querySelectorAll("[data-jump-score]")
    .forEach(
      (b) =>
        (b.onclick = async () => {
          const n = session.notes.find((n) => n.id === b.dataset.jumpScore);
          page = n.page;
          if (scoreId !== n.score_id) {
            scoreId = n.score_id;
            $("#score-select").value = scoreId;
            $("#download-score").href = fileUrl(scoreId);
            await loadScore();
          } else await renderPage();
          activePin = n.id;
          drawPins();
          const stage = $("#score-stage"),
            paper = $("#score-paper"),
            rect = paper.getBoundingClientRect(),
            area = stage.getBoundingClientRect();
          if (n.x !== null) {
            stage.scrollLeft +=
              rect.left -
              area.left +
              (n.x + (n.width || 0) / 2) * rect.width -
              stage.clientWidth / 2;
            stage.scrollTop +=
              rect.top -
              area.top +
              (n.y + (n.height || 0) / 2) * rect.height -
              stage.clientHeight / 2;
          } else {
            stage.scrollTop = 0;
            stage.scrollLeft = 0;
          }
          if (matchMedia("(max-width: 600px)").matches)
            stage.scrollIntoView({ behavior: "smooth", block: "center" });
        }),
    );
  $("#notes-list")
    .querySelectorAll("[data-reply]")
    .forEach((b) => (b.onclick = () => editNote(b.dataset.reply, true)));
  $("#notes-list")
    .querySelectorAll("[data-edit]")
    .forEach((b) => (b.onclick = () => editNote(b.dataset.edit, false)));
  $("#notes-list")
    .querySelectorAll("[data-delete]")
    .forEach(
      (b) =>
        (b.onclick = async () => {
          try {
            const id = b.dataset.delete,
              sessionId = session.id;
            await api(`/sessions/${sessionId}/notes/${id}`, {}, "DELETE");
            await refreshNotes();
            showUndo(sessionId, id);
          } catch (e) {
            toastError(e);
          }
        }),
    );
}
async function refreshNotes() {
  const id = session?.id;
  if (!id) return;
  const fresh = await api(`/sessions/${id}`);
  if (session?.id !== id) return;
  if (JSON.stringify(session.notes) === JSON.stringify(fresh.notes)) return;
  session.notes = fresh.notes;
  renderNotes();
  drawPins();
}
async function saveNote(e) {
  e.preventDefault();
  const button = $("button[type=submit]", e.target);
  button.disabled = true;
  const includeAudio = $("#attach-time")?.checked,
    includeScore = $("#attach-score")?.checked;
  try {
    const recordingTimes =
      includeAudio && $("#recording-scope").value === "section"
        ? sectionTimes(
            $("#section-start").value,
            $("#section-end").value,
            $("#player").duration,
          )
        : {
            time: includeAudio ? $("#player").currentTime : null,
            endTime: null,
          };
    await api(`/sessions/${session.id}/notes`, {
      body: $("#note-body").value,
      kind,
      audioId: includeAudio ? audioId : null,
      ...recordingTimes,
      scoreId: includeScore ? point?.scoreId || scoreId : null,
      page: includeScore ? point?.page || page : null,
      ...(includeScore && point
        ? { x: point.x, y: point.y, width: point.width, height: point.height }
        : {}),
    });
    $("#note-body").value = "";
    selectingSection = false;
    sectionPreview = null;
    if ($("#recording-scope")) {
      $("#recording-scope").value = "point";
      $("#section-times").hidden = true;
      $("#section-start").value = "";
      $("#section-end").value = "";
    }
    point = null;
    updateAttachments();
    if ($("#score-hint"))
      $("#score-hint").textContent =
        "Choose “Mark Passage”, then click a note or drag around a phrase.";
    $("#note-error").hidden = true;
    await refreshNotes();
    setComposer(false);
    toast(kind === "question" ? "Question saved." : "Note saved.");
  } catch (e) {
    $("#note-error").hidden = false;
    error($("#note-error"), e);
  } finally {
    button.disabled = false;
  }
}
function editNote(id, reply) {
  const n = session.notes.find((n) => n.id === id);
  dialog(
    `<h2>${reply ? "Add a Reply" : n.kind === "question" ? "Edit Your Question" : "Edit Your Note"}</h2>${reply ? `<p class="muted">${esc(n.body)}</p>` : ""}<form id="edit-form"><label for="edit-body">${reply ? "Your Reply" : n.kind === "question" ? "Your Question" : "Your Note"}</label><textarea id="edit-body" rows="5" maxlength="5000" required>${reply ? "" : esc(n.body)}</textarea>${!reply && n.audio_id ? `<div class="edit-times"><label for="edit-start">Start</label><input id="edit-start" value="${inputTime(n.time)}"><label for="edit-end">End <span class="muted">(leave blank for a single moment)</span></label><input id="edit-end" value="${n.end_time == null ? "" : inputTime(n.end_time)}"></div>` : ""}<p class="error" role="alert"></p><div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save ${reply ? "Reply" : "Changes"}</button></div></form>`,
  );
  $("#edit-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = $("button.primary", e.target);
    b.disabled = true;
    try {
      const recordingTimes =
        !reply && n.audio_id
          ? $("#edit-end").value.trim()
            ? sectionTimes(
                $("#edit-start").value,
                $("#edit-end").value,
                audioId === n.audio_id ? $("#player").duration : NaN,
              )
            : { time: parseTime($("#edit-start").value), endTime: null }
          : {};
      await api(
        `/sessions/${session.id}/notes${reply ? "" : "/" + id}`,
        {
          body: $("#edit-body").value,
          ...recordingTimes,
          ...(reply ? { parentId: id } : {}),
        },
        reply ? "POST" : "PATCH",
      );
      modal.close();
      await refreshNotes();
      toast(
        reply
          ? "Reply saved."
          : n.kind === "question"
            ? "Question updated."
            : "Note updated.",
      );
    } catch (e) {
      error($(".error", modal), e);
    } finally {
      b.disabled = false;
    }
  };
}
async function uploadFiles(e) {
  const files = [...e.target.files];
  if (!files.length) return;
  e.target.disabled = true;
  let failed = false;
  for (let i = 0; i < files.length; i++) {
    $("#upload-status").textContent =
      `Preparing ${i + 1} of ${files.length}: ${files[i].name}… Please keep this page open.`;
    try {
      const form = new FormData();
      form.append("file", files[i]);
      await api(`/sessions/${session.id}/files`, form);
    } catch (e) {
      $("#upload-status").textContent = e.message;
      failed = true;
      break;
    }
  }
  if (failed) {
    e.target.disabled = false;
    toast("Some files could not be added. See the message above.");
    return;
  }
  await openSession(session.id);
  toast(`${files.length === 1 ? "File" : "Files"} added. Ready to listen.`);
}
function share() {
  const code = codes.get(session.id);
  dialog(
    `<h2>Invite a Closer Listen</h2><p class="muted">Share the website address and access code. Anyone with the code can listen, view scores, and add notes.</p><label>Website Address</label><input readonly value="${esc(location.origin)}" aria-label="Website Address">${code ? `<div class="share-code">${code.match(/.{1,4}/g).join("-")}</div><p class="muted">Keep a copy of this code. For privacy, it is only shown here until you reload the page.</p><button class="primary" id="copy-invite">Copy Invitation</button>` : '<p class="muted">Codes are stored privately and cannot be retrieved. Create a new code if you no longer have the original.</p>'}<p class="footnote">A new code replaces the old code and signs out everyone using it.</p><div class="actions"><button id="rotate-code">Create a New Code</button><button data-close>Done</button></div>`,
  );
  if (code)
    $("#copy-invite").onclick = async () => {
      try {
        await navigator.clipboard.writeText(
          `Open ${location.origin}\nAccess Code: ${code.match(/.{1,4}/g).join("-")}\nSession: ${session.title}`,
        );
        toast("Invitation copied.");
      } catch {
        toast("Select the address and code above to copy them.");
      }
    };
  $("#rotate-code").onclick = () => {
    dialog(
      '<h2>Replace the Access Code?</h2><p>The old code will stop working and current visitors will be signed out.</p><div class="actions"><button data-close>Cancel</button><button class="primary" id="confirm-rotate">Create New Code</button></div>',
    );
    $("#confirm-rotate").onclick = async () => {
      try {
        const r = await api(`/sessions/${session.id}/code`, {});
        codes.set(session.id, r.code);
        modal.close();
        share();
      } catch (e) {
        toastError(e);
      }
    };
  };
}
document.addEventListener("fullscreenchange", () => {
  if ($("#fullscreen"))
    $("#fullscreen").textContent = document.fullscreenElement
      ? "Exit Full Screen"
      : "Full Screen";
});
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (pdf && $("#score-canvas")) renderPage().catch(toastError);
  }, 250);
});
// Refresh shared feedback without disturbing playback or a draft.
setInterval(() => {
  if (session && !document.hidden && !modal.open)
    refreshNotes().catch(() => {});
}, 20000);
try {
  me = await api("/me");
  account();
  if (!me) login();
  else if (!me.admin) await openSession(me.sessionId);
  else if (location.hash.length > 1) {
    try {
      await openSession(location.hash.slice(1));
    } catch {
      await library();
    }
  } else await library();
} catch (e) {
  app.innerHTML = `<div class="loading"><h2>Unable to Connect</h2><p>${esc(e.message)}</p><a href="/">Try Again</a></div>`;
}
