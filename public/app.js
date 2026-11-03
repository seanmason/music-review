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
  renderTask;
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
    ? `<span>${esc(me.name || "Owner")}</span><button class="quiet" id="logout">Sign out</button>`
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
  app.innerHTML = `<section class="entry"><div class="entry-copy"><div class="eyebrow">Listen closely. Leave a note.</div><h1>Every detail.<br>A little clearer.</h1><p class="muted">Bring recordings, scores, and thoughtful feedback together in one quiet space.</p><div class="steps"><span><b>01</b>Open your session</span><span><b>02</b>Listen & follow along</span><span><b>03</b>Share your notes</span></div></div><div class="entry-card"><h2>${owner ? "Your library" : "Welcome in."}</h2><p class="muted">${owner ? "Sign in to create and manage your sessions." : "Enter your access code to open a session."}</p><form id="login-form">${owner ? '<div class="field"><label for="password">Library password</label><input id="password" type="password" autocomplete="current-password" required></div>' : '<div class="field"><label for="code">Access code</label><input class="code-input" id="code" placeholder="XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" required maxlength="30"></div><div class="field"><label for="name">Your name</label><input id="name" autocomplete="name" placeholder="How should your notes be signed?" required maxlength="60"></div>'}<p class="error" id="login-error" role="alert"></p><button class="primary" type="submit">${owner ? "Open library" : "Open session"} <span aria-hidden="true">→</span></button></form><button class="quiet" id="switch-login">${owner ? "← Use an access code" : "Manage library"}</button></div></section>`;
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
  session = null;
  location.hash = "";
  const list = await api("/sessions");
  account();
  app.innerHTML = `<section class="library"><div class="page-head"><div><div class="eyebrow">Your workspace</div><h1>The library</h1><p class="muted">A place for recordings, scores, and conversation.</p></div><button class="primary" id="create">+ New session</button></div><div class="cards">${list.map((s) => `<article class="session-card"><div class="card-icon" aria-hidden="true">♫</div><h2>${esc(s.title)}</h2><p class="muted">${esc(s.description || "Ready for a closer listen.")}</p><small>${s.file_count} files &nbsp;·&nbsp; ${s.note_count} notes</small><button data-open="${s.id}">Open session <span aria-hidden="true">→</span></button></article>`).join("")}</div>${list.length ? "" : '<div class="empty"><h2>Start with a session</h2><p>Add your recordings and scores, then share a single access code.</p></div>'}</section>`;
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
    '<h2>A new session</h2><p class="muted">Give your recordings and scores a home.</p><form id="new-session"><div class="field"><label for="title">Session title</label><input id="title" placeholder="For example, Waltz in A minor" maxlength="120" required></div><div class="field"><label for="description">A short introduction <span class="muted">(optional)</span></label><textarea id="description" rows="3" maxlength="2000" placeholder="What would you like someone to listen for?"></textarea></div><p class="error" role="alert"></p><div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Create session</button></div></form>',
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
  session = await api(`/sessions/${id}`);
  location.hash = id;
  pdf = null;
  page = 1;
  point = null;
  pinning = false;
  kind = "note";
  filter = "all";
  audioId = session.files.find((f) => f.kind === "audio")?.id;
  scoreId = session.files.find((f) => f.kind === "score")?.id;
  workspace();
  await loadScore();
}
const options = (type) =>
  session.files
    .filter((f) => f.kind === type)
    .map((f) => `<option value="${f.id}">${esc(f.name)}</option>`)
    .join("");
function workspace() {
  account();
  app.innerHTML = `<section class="workspace">${me.admin ? '<button class="quiet back" id="back">← All sessions</button>' : ""}<div class="session-heading"><div><div class="eyebrow">Listening room</div><h1>${esc(session.title)}</h1>${session.description ? `<p class="muted">${esc(session.description)}</p>` : '<p class="muted">Listen, follow the score, and leave a note along the way.</p>'}</div>${me.admin ? '<div class="actions"><button id="add-files">+ Add files</button><button class="primary" id="share">Share session</button><button class="quiet" id="session-menu" aria-label="Session options">•••</button></div>' : ""}</div>${me.admin ? `<div class="upload-zone" id="upload-zone" ${session.files.length ? "hidden" : ""}><label for="files">Add scores and recordings</label><input type="file" id="files" accept=".pdf,.aac,.m4a,.mp3,.wav,.ogg,.flac,.webm,.mp4" multiple><p class="muted">PDF scores and audio files · Up to 150 MB each. Audio is prepared for easy playback.</p><p id="upload-status" role="status"></p></div>` : ""}<div class="review-grid"><div><section class="panel"><div class="panel-head"><h2>◎ &nbsp; The score</h2>${scoreId ? `<label class="sr-only" for="score-select">Choose score</label><select id="score-select">${options("score")}</select>` : ""}</div>${scoreId ? `<div class="score-toolbar"><div class="page-controls"><button id="prev-page" aria-label="Previous page">←</button><span id="page-label">Page 1</span><button id="next-page" aria-label="Next page">→</button></div><button class="quiet" id="pin-mode">＋ Mark a spot</button><a id="download-score" href="${fileUrl(scoreId)}" target="_blank" rel="noopener">Open PDF ↗</a></div><div class="score-stage" id="score-stage"><div class="score-paper" id="score-paper"><canvas id="score-canvas" aria-label="Score page"></canvas><div id="pins"></div></div><p id="score-status" role="status">Opening score…</p></div><p class="hint" id="score-hint">Use “Mark a spot” to attach a note to a place on the score.</p>` : '<div class="score-stage"><div class="empty">No score added yet.<br>You can still listen and leave notes.</div></div>'}</section><section class="panel audio-panel"><div class="audio-title"><h2>♫ &nbsp; The recording</h2>${audioId ? `<label class="sr-only" for="audio-select">Choose recording</label><select id="audio-select">${options("audio")}</select>` : ""}</div>${audioId ? `<audio id="player" controls preload="metadata" src="${fileUrl(audioId)}"></audio><div class="audio-tools"><div><button id="rewind">↶ 10 sec</button> <button id="forward">10 sec ↷</button></div><label for="speed">Speed <select id="speed"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option></select></label></div><p id="audio-error" class="error" role="alert" hidden></p>` : '<p class="muted">No recording added yet. Notes on the score are welcome.</p>'}</section><p class="footnote">Your notes are saved here and visible to everyone with access to this session.</p></div><aside class="panel notes-panel"><div class="panel-head"><h2>Notes <span class="muted" id="note-count"></span></h2><label for="filter" class="sr-only">Filter notes</label><select id="filter" class="filter"><option value="all">All notes</option><option value="question">Questions</option><option value="bookmark">Bookmarks</option></select></div><form class="note-compose" id="note-form"><div class="kind-tabs" aria-label="Note type"><button type="button" class="active" data-kind="note" aria-pressed="true">Note</button><button type="button" data-kind="question" aria-pressed="false">Question</button><button type="button" data-kind="bookmark" aria-pressed="false">Bookmark</button></div><label for="note-body">What would you like to note?</label><textarea id="note-body" rows="3" maxlength="5000" required placeholder="A thought, a question, something to return to…"></textarea>${audioId ? '<label class="check"><input type="checkbox" id="attach-time" checked><span>Link to <span id="current-time">0:00</span> in the recording</span></label>' : ""}${scoreId ? '<label class="check"><input type="checkbox" id="attach-score"><span>Link to <span id="current-page">page 1</span> of the score</span></label>' : ""}<div class="attachment" id="point-label"></div><p class="error" id="note-error" role="alert" hidden></p><button class="primary" type="submit">Save note</button></form><div class="notes-list" id="notes-list"></div></aside></div></section>`;
  if (me.admin) {
    $("#back").onclick = () => library().catch(toastError);
    $("#add-files").onclick = () => {
      $("#upload-zone").hidden = !$("#upload-zone").hidden;
    };
    $("#files").onchange = uploadFiles;
    $("#share").onclick = share;
    $("#session-menu").onclick = () => {
      dialog(
        '<h2>Session options</h2><p>Deleting this session permanently removes its files and notes.</p><div class="actions"><button data-close>Keep session</button><button class="danger" id="delete-session">Delete session</button></div>',
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
    $("#audio-select").onchange = (e) => {
      audioId = e.target.value;
      $("#player").src = fileUrl(audioId);
      $("#current-time").textContent = "0:00";
      $("#audio-error").hidden = true;
    };
    $("#player").ontimeupdate = () => {
      $("#current-time").textContent = clock($("#player").currentTime);
    };
    $("#player").onerror = () => {
      $("#audio-error").hidden = false;
      $("#audio-error").textContent =
        "Audio could not load. Please refresh the page and try again.";
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
      point = null;
      $("#download-score").href = fileUrl(scoreId);
      await loadScore();
    };
    $("#prev-page").onclick = async () => {
      if (page > 1) {
        page--;
        point = null;
        await renderPage();
      }
    };
    $("#next-page").onclick = async () => {
      if (pdf && page < pdf.numPages) {
        page++;
        point = null;
        await renderPage();
      }
    };
    $("#pin-mode").onclick = () => {
      pinning = !pinning;
      $("#score-paper").classList.toggle("pinning", pinning);
      $("#pin-mode").textContent = pinning
        ? "Cancel marking"
        : "＋ Mark a spot";
      $("#score-hint").textContent = pinning
        ? "Click a place on the score, then write your note."
        : "Use “Mark a spot” to attach a note to a place on the score.";
    };
    $("#score-canvas").onclick = (e) => {
      if (!pinning) return;
      const r = e.target.getBoundingClientRect();
      point = {
        x: (e.clientX - r.left) / r.width,
        y: (e.clientY - r.top) / r.height,
      };
      $("#attach-score").checked = true;
      pinning = false;
      $("#score-paper").classList.remove("pinning");
      $("#pin-mode").textContent = "＋ Mark a spot";
      $("#score-hint").textContent =
        "Spot selected. Write your note and choose Save note.";
      drawPins();
      updateAttachments();
      $("#note-body").focus();
    };
  }
  document.querySelectorAll("[data-kind]").forEach(
    (b) =>
      (b.onclick = () => {
        kind = b.dataset.kind;
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
    generation !== pdfGeneration ||
    requestedPage !== page ||
    !$("#score-canvas")
  )
    return;
  const canvas = $("#score-canvas"),
    base = p.getViewport({ scale: 1 });
  const width = Math.max(250, $("#score-stage").clientWidth - 48),
    scale = width / base.width,
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = p.getViewport({ scale: scale * pixelRatio });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${width}px`;
  renderTask = p.render({ canvasContext: canvas.getContext("2d"), viewport });
  try {
    await renderTask.promise;
  } catch (e) {
    if (e.name === "RenderingCancelledException") return;
    throw e;
  }
  $("#score-status").textContent = "";
  $("#page-label").textContent = `Page ${page} of ${pdf.numPages}`;
  $("#prev-page").disabled = page <= 1;
  $("#next-page").disabled = page >= pdf.numPages;
  canvas.setAttribute(
    "aria-label",
    `Score page ${page} of ${pdf.numPages}. Use the Open PDF link for the original document.`,
  );
  updateAttachments();
  drawPins();
}
function updateAttachments() {
  if ($("#current-page")) $("#current-page").textContent = `page ${page}`;
  $("#point-label").textContent = point
    ? "A spot on the score is selected."
    : "";
}
function drawPins() {
  if (!$("#pins")) return;
  const pins = session.notes.filter(
    (n) =>
      !n.parent_id && n.score_id === scoreId && n.page === page && n.x !== null,
  );
  $("#pins").innerHTML =
    pins
      .map(
        (n, i) =>
          `<button class="pin" data-pin="${n.id}" aria-label="Go to note: ${esc(n.body.slice(0, 80))}">${i + 1}</button>`,
      )
      .join("") +
    (point
      ? '<span class="pin selected" id="draft-pin" aria-label="Selected spot">+</span>'
      : "");
  pins.forEach((n) => {
    const p = $(`[data-pin="${n.id}"]`);
    p.style.left = `${n.x * 100}%`;
    p.style.top = `${n.y * 100}%`;
    p.onclick = () => {
      filter = "all";
      $("#filter").value = "all";
      renderNotes();
      focusNote(n.id);
    };
  });
  if (point) {
    $("#draft-pin").style.left = `${point.x * 100}%`;
    $("#draft-pin").style.top = `${point.y * 100}%`;
  }
}
function focusNote(id) {
  const n = $(`[data-note="${id}"]`);
  if (n) {
    n.scrollIntoView({ behavior: "smooth", block: "center" });
    n.classList.add("highlight");
    setTimeout(() => n.classList.remove("highlight"), 2000);
  }
}
function renderNotes() {
  const roots = session.notes.filter((n) => !n.parent_id);
  $("#note-count").textContent = `(${roots.length})`;
  const list = roots.filter((n) => filter === "all" || n.kind === filter);
  const actions = (n) =>
    `<div class="note-actions">${!n.parent_id ? `<button data-reply="${n.id}">Reply</button>` : ""}${n.editable ? `<button data-edit="${n.id}">Edit</button><button data-delete="${n.id}">Delete</button>` : ""}</div>`;
  $("#notes-list").innerHTML =
    list
      .map(
        (n) =>
          `<article class="note" data-note="${n.id}"><div class="note-meta"><span class="tag ${n.kind}">${n.kind}</span><span>${esc(n.author)}</span></div><div>${n.audio_id ? `<button class="jump" data-jump-audio="${n.id}">▶ ${clock(n.time)}</button>` : ""}${n.score_id ? `<button class="jump" data-jump-score="${n.id}">◎ Page ${n.page}</button>` : ""}</div><p class="note-body">${esc(n.body)}</p>${actions(n)}${session.notes
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
          const n = session.notes.find((n) => n.id === b.dataset.jumpAudio),
            a = $("#player");
          if (audioId !== n.audio_id) {
            audioId = n.audio_id;
            $("#audio-select").value = audioId;
            a.src = fileUrl(audioId);
            a.addEventListener(
              "loadedmetadata",
              () => {
                a.currentTime = Math.min(n.time, a.duration);
              },
              { once: true },
            );
          } else
            a.currentTime = Math.min(
              n.time,
              Number.isFinite(a.duration) ? a.duration : n.time,
            );
          try {
            await a.play();
          } catch {
            toast("Press play to listen from this point.");
          }
        }),
    );
  $("#notes-list")
    .querySelectorAll("[data-jump-score]")
    .forEach(
      (b) =>
        (b.onclick = async () => {
          const n = session.notes.find((n) => n.id === b.dataset.jumpScore);
          point = null;
          page = n.page;
          if (scoreId !== n.score_id) {
            scoreId = n.score_id;
            $("#score-select").value = scoreId;
            $("#download-score").href = fileUrl(scoreId);
            await loadScore();
          } else await renderPage();
          $("#score-stage").scrollTop =
            n.y !== null
              ? Math.max(
                  0,
                  n.y * $("#score-canvas").getBoundingClientRect().height -
                    $("#score-stage").clientHeight / 2,
                )
              : 0;
          $("#score-stage").scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
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
        (b.onclick = () => {
          dialog(
            '<h2>Delete this note?</h2><p>Any replies to this note will also be removed.</p><div class="actions"><button data-close>Keep note</button><button class="danger" id="confirm-delete">Delete note</button></div>',
          );
          $("#confirm-delete").onclick = async () => {
            try {
              await api(
                `/sessions/${session.id}/notes/${b.dataset.delete}`,
                {},
                "DELETE",
              );
              modal.close();
              await refreshNotes();
              toast("Note deleted.");
            } catch (e) {
              toastError(e);
            }
          };
        }),
    );
}
async function refreshNotes() {
  const id = session?.id;
  if (!id) return;
  const fresh = await api(`/sessions/${id}`);
  if (session?.id !== id) return;
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
    await api(`/sessions/${session.id}/notes`, {
      body: $("#note-body").value,
      kind,
      audioId: includeAudio ? audioId : null,
      time: includeAudio ? $("#player").currentTime : null,
      scoreId: includeScore ? scoreId : null,
      page: includeScore ? page : null,
      ...(includeScore && point ? point : {}),
    });
    $("#note-body").value = "";
    point = null;
    updateAttachments();
    if ($("#score-hint"))
      $("#score-hint").textContent =
        "Use “Mark a spot” to attach a note to a place on the score.";
    $("#note-error").hidden = true;
    await refreshNotes();
    toast("Note saved.");
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
    `<h2>${reply ? "Add a reply" : "Edit your note"}</h2>${reply ? `<p class="muted">${esc(n.body)}</p>` : ""}<form id="edit-form"><label for="edit-body">${reply ? "Your reply" : "Your note"}</label><textarea id="edit-body" rows="5" maxlength="5000" required>${reply ? "" : esc(n.body)}</textarea><p class="error" role="alert"></p><div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save ${reply ? "reply" : "changes"}</button></div></form>`,
  );
  $("#edit-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = $("button.primary", e.target);
    b.disabled = true;
    try {
      await api(
        `/sessions/${session.id}/notes${reply ? "" : "/" + id}`,
        { body: $("#edit-body").value, ...(reply ? { parentId: id } : {}) },
        reply ? "POST" : "PATCH",
      );
      modal.close();
      await refreshNotes();
      toast(reply ? "Reply saved." : "Note updated.");
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
    `<h2>Invite a closer listen</h2><p class="muted">Share the website address and access code. Anyone with the code can listen, view scores, and add notes.</p><label>Website address</label><input readonly value="${esc(location.origin)}" aria-label="Website address">${code ? `<div class="share-code">${code.match(/.{1,4}/g).join("-")}</div><p class="muted">Keep a copy of this code. For privacy, it is only shown here until you reload the page.</p><button class="primary" id="copy-invite">Copy invitation</button>` : '<p class="muted">Codes are stored privately and cannot be retrieved. Create a new code if you no longer have the original.</p>'}<p class="footnote">A new code replaces the old code and signs out everyone using it.</p><div class="actions"><button id="rotate-code">Create a new code</button><button data-close>Done</button></div>`,
  );
  if (code)
    $("#copy-invite").onclick = async () => {
      try {
        await navigator.clipboard.writeText(
          `Open ${location.origin}\nAccess code: ${code.match(/.{1,4}/g).join("-")}\nSession: ${session.title}`,
        );
        toast("Invitation copied.");
      } catch {
        toast("Select the address and code above to copy them.");
      }
    };
  $("#rotate-code").onclick = () => {
    dialog(
      '<h2>Replace the access code?</h2><p>The old code will stop working and current visitors will be signed out.</p><div class="actions"><button data-close>Cancel</button><button class="primary" id="confirm-rotate">Create new code</button></div>',
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
  app.innerHTML = `<div class="loading"><h2>Unable to connect</h2><p>${esc(e.message)}</p><a href="/">Try again</a></div>`;
}
