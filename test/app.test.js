import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
let child,
  base,
  adminCookie,
  visitorCookie,
  sessionId,
  otherId,
  code,
  noteId,
  audioId,
  scoreId;
const dir = mkdtempSync(path.join(tmpdir(), "score-sound-"));
async function start() {
  child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: "0",
      DATA_DIR: dir,
      ADMIN_PASSWORD: "test-password-with-enough-entropy",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Server start timed out")),
      15000,
    );
    child.stdout.on("data", (d) => {
      output += d;
      const m = output.match(/http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.once("exit", (c) => {
      clearTimeout(timer);
      reject(new Error("Server exited " + c));
    });
  });
}
async function stop() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
}
async function req(url, { cookie = adminCookie, body, method } = {}) {
  const r = await fetch(base + "/api" + url, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body && !(body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const content = r.headers.get("content-type");
  return {
    status: r.status,
    data: content?.includes("json") ? await r.json() : await r.arrayBuffer(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
    headers: r.headers,
  };
}
before(start);
after(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});
test("private library, session access and persisted collaborative notes", async (t) => {
  await t.test(
    "requires authentication and rejects incorrect password",
    async () => {
      assert.equal((await req("/sessions", { cookie: "" })).status, 403);
      assert.equal(
        (await req("/login", { body: { password: "wrong" } })).status,
        401,
      );
      const login = await req("/login", {
        body: { password: "test-password-with-enough-entropy" },
      });
      assert.equal(login.status, 200);
      adminCookie = login.cookie;
      assert.ok(adminCookie);
    },
  );
  await t.test(
    "creates separate sessions and grants access with formatted code",
    async () => {
      const a = await req("/sessions", {
        body: { title: "Waltz", description: "Listen for phrasing." },
      });
      assert.equal(a.status, 201);
      sessionId = a.data.id;
      code = a.data.code;
      otherId = (await req("/sessions", { body: { title: "Another session" } }))
        .data.id;
      const login = await req("/login", {
        body: {
          code: code.match(/.{4}/g).join("-").toLowerCase(),
          name: "Alex",
        },
      });
      assert.equal(login.status, 200);
      visitorCookie = login.cookie;
      assert.equal(
        (await req("/sessions/" + otherId, { cookie: visitorCookie })).status,
        403,
      );
      assert.equal(
        (await req("/sessions", { cookie: visitorCookie })).status,
        403,
      );
      assert.equal(
        (
          await req("/sessions", {
            cookie: visitorCookie,
            body: { title: "Unauthorized" },
          })
        ).status,
        403,
      );
    },
  );
  await t.test(
    "uploads PDF and converts audio, protects files, supports range seeking",
    async () => {
      const pdf = new FormData();
      pdf.append("file", new Blob(["%PDF-1.4\n%%EOF"]), "score.pdf");
      const s = await req(`/sessions/${sessionId}/files`, { body: pdf });
      assert.equal(s.status, 201);
      scoreId = s.data.id;
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-y",
        path.join(dir, "test.wav"),
      ]);
      const audio = new FormData();
      audio.append(
        "file",
        new Blob([readFileSync(path.join(dir, "test.wav"))]),
        "test.wav",
      );
      const a = await req(`/sessions/${sessionId}/files`, { body: audio });
      assert.equal(a.status, 201);
      audioId = a.data.id;
      assert.equal(
        (await req(`/sessions/${sessionId}/files/${audioId}`, { cookie: "" }))
          .status,
        403,
      );
      const range = await fetch(
        base + `/api/sessions/${sessionId}/files/${audioId}`,
        { headers: { cookie: visitorCookie, range: "bytes=0-31" } },
      );
      assert.equal(range.status, 206);
      assert.equal((await range.arrayBuffer()).byteLength, 32);
      const bad = new FormData();
      bad.append("file", new Blob(["not pdf"]), "bad.pdf");
      assert.equal(
        (await req(`/sessions/${sessionId}/files`, { body: bad })).status,
        400,
      );
      const denied = new FormData();
      denied.append("file", new Blob(["%PDF-1.4"]), "score.pdf");
      assert.equal(
        (
          await req(`/sessions/${sessionId}/files`, {
            cookie: visitorCookie,
            body: denied,
          })
        ).status,
        403,
      );
    },
  );
  await t.test(
    "saves notes, replies and enforces edit ownership and file scope",
    async () => {
      const n = await req(`/sessions/${sessionId}/notes`, {
        cookie: visitorCookie,
        body: {
          body: "How is this phrase?",
          kind: "question",
          audioId,
          time: 0.4,
          scoreId,
          page: 1,
          x: 0.2,
          y: 0.4,
          width: 0.3,
          height: 0.15,
          locationLabel: "Bars 9–12",
        },
      });
      assert.equal(n.status, 201);
      noteId = n.data.id;
      assert.equal(
        (
          await req(`/sessions/${sessionId}/notes`, {
            body: { body: "Try a softer ending.", parentId: noteId },
          })
        ).status,
        201,
      );
      const data = (
        await req("/sessions/" + sessionId, { cookie: visitorCookie })
      ).data;
      assert.equal(data.notes.length, 2);
      assert.equal(data.notes[0].editable, true);
      assert.equal(data.notes[1].editable, false);
      assert.equal(data.notes[0].x, 0.2);
      assert.equal(data.notes[0].width, 0.3);
      assert.equal(data.notes[0].height, 0.15);
      assert.equal(data.notes[0].location_label, "Bars 9–12");
      assert.equal(data.notes[0].owner, undefined);
      assert.equal(
        (
          await req(`/sessions/${sessionId}/notes/${data.notes[1].id}`, {
            cookie: visitorCookie,
            method: "PATCH",
            body: { body: "Not mine" },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await req(`/sessions/${otherId}/notes`, {
            body: { body: "bad reference", audioId, time: 0 },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await req(`/sessions/${sessionId}/notes`, {
            body: { body: "bad time", audioId, time: -1 },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await req(`/sessions/${sessionId}/notes/${noteId}`, {
            cookie: visitorCookie,
            method: "PATCH",
            body: { body: "Updated question" },
          })
        ).status,
        200,
      );
    },
  );
  await t.test(
    "rejects invalid score regions without losing existing annotations",
    async () => {
      for (const anchor of [
        { x: 0.9, y: 0.1, width: 0.2, height: 0.1 },
        { x: 0.1, y: 0.9, width: 0.1, height: 0.2 },
        { x: 0.1, y: 0.1, width: -0.1, height: 0.2 },
        { x: 0.1, y: 0.1, width: 0.2 },
        { x: 2, y: 0.1 },
        { width: 0.2, height: 0.2 },
      ]) {
        assert.equal(
          (
            await req(`/sessions/${sessionId}/notes`, {
              body: { body: "Invalid region", scoreId, page: 1, ...anchor },
            })
          ).status,
          400,
        );
      }
      const saved = (await req(`/sessions/${sessionId}`)).data.notes;
      assert.equal(saved.length, 2);
      assert.equal(saved[0].location_label, "Bars 9–12");
    },
  );
  await t.test("rejects cross-origin changes", async () => {
    const r = await fetch(base + "/api/sessions", {
      method: "POST",
      headers: {
        cookie: adminCookie,
        "Content-Type": "application/json",
        origin: "https://untrusted.example",
      },
      body: JSON.stringify({ title: "No" }),
    });
    assert.equal(r.status, 403);
  });
  await t.test("persists files, login and notes through restart", async () => {
    await stop();
    await start();
    const s = await req("/sessions/" + sessionId, { cookie: visitorCookie });
    assert.equal(s.status, 200);
    assert.equal(s.data.notes[0].body, "Updated question");
    assert.equal(s.data.files.length, 2);
    assert.equal(s.data.notes[0].width, 0.3);
    assert.equal(s.data.notes[0].location_label, "Bars 9–12");
  });
  await t.test(
    "video playback files and all attachment combinations",
    async () => {
      const videoPath = path.join(dir, "video.mp4");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x240:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-shortest",
        "-y",
        videoPath,
      ]);
      const form = new FormData();
      form.append("file", new Blob([readFileSync(videoPath)]), "clip.MP4");
      const uploaded = await req(`/sessions/${sessionId}/files`, {
        body: form,
      });
      assert.equal(uploaded.status, 201);
      const vid = uploaded.data.id;
      const files = (await req(`/sessions/${sessionId}`)).data.files;
      assert.equal(files.find((f) => f.id === vid).kind, "video");
      const stream = await fetch(
        base + `/api/sessions/${sessionId}/files/${vid}`,
        { headers: { cookie: visitorCookie, range: "bytes=0-63" } },
      );
      assert.equal(stream.status, 206);
      assert.match(stream.headers.get("content-type"), /video\/mp4/);
      for (const attachment of [
        { scoreId, page: 1 },
        { audioId, time: 0.2 },
        { audioId: vid, time: 0.3 },
        { audioId: vid, time: 0.3, scoreId, page: 1 },
        { audioId: vid, time: 0.1, endTime: 0.4 },
        {},
      ]) {
        const saved = await req(`/sessions/${sessionId}/notes`, {
          body: { body: "Attachment example", kind: "question", ...attachment },
          cookie: visitorCookie,
        });
        assert.equal(saved.status, 201);
        const note = (await req(`/sessions/${sessionId}`)).data.notes.find(
          (n) => n.id === saved.data.id,
        );
        assert.equal(note.end_time, attachment.endTime ?? null);
        assert.equal(note.audio_id, attachment.audioId || null);
        assert.equal(note.score_id, attachment.scoreId || null);
        assert.equal(
          (
            await req(`/sessions/${sessionId}/notes/${note.id}`, {
              method: "DELETE",
              body: {},
              cookie: visitorCookie,
            })
          ).status,
          200,
        );
      }
    },
  );
  await t.test(
    "recording sections validate, edit, restore and persist",
    async () => {
      const url = `/sessions/${sessionId}/notes`;
      for (const attachment of [
        { audioId, time: 0.4, endTime: 0.2 },
        { audioId, time: 0.2, endTime: 0.2 },
        { audioId, time: 0.2, endTime: "invalid" },
        { audioId, time: 0.2, endTime: 900000 },
        { endTime: 1 },
      ])
        assert.equal(
          (await req(url, { body: { body: "Bad section", ...attachment } }))
            .status,
          400,
        );
      const saved = await req(url, {
        cookie: visitorCookie,
        body: {
          body: "First piece",
          audioId,
          time: 0,
          endTime: 0.8,
          scoreId,
          page: 1,
        },
      });
      assert.equal(saved.status, 201);
      const noteUrl = `${url}/${saved.data.id}`;
      assert.equal(
        (
          await req(noteUrl, {
            cookie: visitorCookie,
            method: "PATCH",
            body: { body: "First piece", time: 0.2, endTime: 0.7 },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await req(noteUrl, {
            cookie: visitorCookie,
            method: "PATCH",
            body: { body: "Bad edit", time: 0.9 },
          })
        ).status,
        400,
      );
      await stop();
      await start();
      let note = (await req(`/sessions/${sessionId}`)).data.notes.find(
        (n) => n.id === saved.data.id,
      );
      assert.equal(note.time, 0.2);
      assert.equal(note.end_time, 0.7);
      await req(noteUrl, { cookie: visitorCookie, method: "DELETE", body: {} });
      await req(`${noteUrl}/restore`, { cookie: visitorCookie, body: {} });
      note = (await req(`/sessions/${sessionId}`)).data.notes.find(
        (n) => n.id === saved.data.id,
      );
      assert.equal(note.end_time, 0.7);
      assert.equal(
        (
          await req(noteUrl, {
            cookie: visitorCookie,
            method: "PATCH",
            body: { body: "A moment", endTime: null },
          })
        ).status,
        200,
      );
      note = (await req(`/sessions/${sessionId}`)).data.notes.find(
        (n) => n.id === saved.data.id,
      );
      assert.equal(note.end_time, null);
    },
  );
  await t.test(
    "remove and undo preserve replies and enforce ownership",
    async () => {
      let data = (
        await req(`/sessions/${sessionId}`, { cookie: visitorCookie })
      ).data;
      const reply = data.notes.find((n) => n.parent_id === noteId);
      assert.equal(
        (
          await req(`/sessions/${sessionId}/notes/${reply.id}`, {
            method: "DELETE",
            body: {},
            cookie: visitorCookie,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await req(`/sessions/${sessionId}/notes/${noteId}`, {
            method: "DELETE",
            body: {},
            cookie: visitorCookie,
          })
        ).status,
        200,
      );
      data = (await req(`/sessions/${sessionId}`)).data;
      assert.equal(
        data.notes.some((n) => n.id === noteId || n.parent_id === noteId),
        false,
      );
      assert.equal(
        (
          await req(`/sessions/${sessionId}/notes`, {
            body: { body: "Reply to removed note", parentId: noteId },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await req(`/sessions/${sessionId}/notes/${noteId}/restore`, {
            body: {},
            cookie: visitorCookie,
          })
        ).status,
        200,
      );
      data = (await req(`/sessions/${sessionId}`)).data;
      assert.ok(data.notes.find((n) => n.id === noteId));
      assert.ok(data.notes.find((n) => n.id === reply.id));
      await req(`/sessions/${sessionId}/notes/${reply.id}`, {
        method: "DELETE",
        body: {},
      });
      assert.equal(
        (
          await req(`/sessions/${sessionId}/notes/${reply.id}/restore`, {
            body: {},
            cookie: visitorCookie,
          })
        ).status,
        403,
      );
      await req(`/sessions/${sessionId}/notes/${noteId}`, {
        method: "DELETE",
        body: {},
      });
      await req(`/sessions/${sessionId}/notes/${noteId}/restore`, { body: {} });
      data = (await req(`/sessions/${sessionId}`)).data;
      assert.equal(
        data.notes.some((n) => n.id === reply.id),
        false,
      );
    },
  );
  await t.test(
    "rotating a code revokes old access, deletion cleans up session",
    async () => {
      const r = await req(`/sessions/${sessionId}/code`, { body: {} });
      assert.equal(r.status, 200);
      assert.notEqual(r.data.code, code);
      assert.equal(
        (await req("/sessions/" + sessionId, { cookie: visitorCookie })).status,
        403,
      );
      assert.equal(
        (await req("/login", { body: { code, name: "Alex" } })).status,
        401,
      );
      assert.equal(
        (await req(`/sessions/${sessionId}`, { body: {}, method: "DELETE" }))
          .status,
        200,
      );
      assert.equal((await req("/sessions/" + sessionId)).status, 404);
    },
  );
});
