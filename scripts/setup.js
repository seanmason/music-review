import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (existsSync(".env")) {
  console.log(".env already exists; keeping your settings.");
} else {
  const password = randomBytes(18).toString("base64url");
  writeFileSync(
    ".env",
    `ADMIN_PASSWORD=${password}\nPORT=3000\nCOOKIE_SECURE=false\n`,
    { mode: 0o600 },
  );
  console.log(
    `Created .env. Your library password is: ${password}\nOpen http://localhost:3000 and choose Manage library.`,
  );
}
