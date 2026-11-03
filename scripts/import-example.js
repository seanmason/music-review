// Imports files into a running LOCAL instance. Source media is never committed.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const paths = process.argv.slice(2);
if (!paths.length || !process.env.ADMIN_PASSWORD)
  throw new Error(
    "Run with an existing .env and provide one or more PDF/audio paths.",
  );
const base = "http://localhost:3000";
let cookie;
async function request(url, body) {
  const r = await fetch(base + "/api" + url, {
    method: body ? "POST" : "GET",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body && !(body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: body
      ? body instanceof FormData
        ? body
        : JSON.stringify(body)
      : undefined,
  });
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  const result = await r.json();
  if (!r.ok) throw new Error(result.error);
  return result;
}
await request("/login", { password: process.env.ADMIN_PASSWORD });
const session = await request("/sessions", {
  title: "Waltz in A minor",
  description:
    "A recording and score to explore together. Leave a note at any moment, or mark a spot on the score.",
});
for (const file of paths) {
  console.log("Adding " + path.basename(file));
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)]), path.basename(file));
  await request(`/sessions/${session.id}/files`, form);
}
mkdirSync("data", { recursive: true });
writeFileSync("data/local-example.json", JSON.stringify(session, null, 2), {
  mode: 0o600,
});
console.log(
  `Local example ready at ${base}\nAccess code: ${session.code.match(/.{4}/g).join("-")}`,
);
await request("/logout", {});
