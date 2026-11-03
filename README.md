# Score & Sound

A small, self-hosted web app for listening to recordings alongside scores and sharing notes. Reviewers enter their name and a session code; the owner manages a private library with a password.

## Included

- Multiple PDF scores and audio recordings in each session.
- In-page PDF viewer, page navigation, and clickable notes pinned to a location on a page.
- Audio playback, seeking, skip-back/forward controls, and playback speed.
- Notes, questions, and bookmarks linked to an audio time, score page, both, or neither.
- Replies and editing/deletion of your own notes. The owner can manage all notes.
- Shared notes refresh every 20 seconds while a session is visible.
- Random access codes, protected media, revocable access, and rate-limited sign-in.
- SQLite and uploaded files in a persistent volume; no third-party accounts or storage required.
- Audio conversion through FFmpeg so raw AAC and other formats play consistently in browsers.

## Run locally with Docker

Install Docker Engine with the Compose plugin (or Docker Desktop). If Node 24+ is installed:

```sh
npm run setup
```

This generates `.env` and prints a random library password. Without Node, copy `.env.example` to `.env` and replace `ADMIN_PASSWORD` with a unique password of at least 12 characters. Do not use the example value.

```sh
docker compose up -d --build
```

Open **http://localhost:3000**. Choose **Manage library**, enter the password from `.env`, and create a session. Add files, make any notes, then choose **Share session**. Copy the code before reloading: only its hash is stored by the server, so a forgotten code must be replaced. A new code also signs out existing reviewers.

The local container binds only to this computer. `localhost` links cannot be used by someone on another computer. Use the HTTPS deployment below before sharing remotely.

```sh
docker compose logs -f app
docker compose down
```

Stopping containers preserves your data. **Do not use `down -v` unless you intend to delete the data volume.**

### Optional: import your own example files

With the app running and Node 24+ available:

```sh
node --env-file=.env scripts/import-example.js \
  "/path/to/recording.aac" \
  "/path/to/score.pdf"
```

This creates a session titled “Waltz in A minor” and prints its code. Each run creates a new session. The local example code is also saved in ignored `data/local-example.json`. The supplied files are not bundled in the application or committed to Git.

## Development without Docker

Requires Node 24+ and FFmpeg on your PATH.

```sh
npm ci
npm run setup
npm run dev
```

The app serves at http://localhost:3000 and stores its database/files in `./data`. This is a **different** data store from the Docker named volume. `DATA_DIR`, `HOST`, and `PORT` can override local defaults.

```sh
npm test
npm audit
```

Integration tests run a real temporary server/database, convert generated audio with FFmpeg, and verify authentication, session isolation, protected media/range requests, upload validation, annotations/replies, ownership, origin checks, restart persistence, code revocation, and session deletion.

## Deploy to Amazon Lightsail

Use a **Lightsail Linux instance** with Docker Compose and a persistent disk. This configuration targets an instance rather than Lightsail Container Service because SQLite and media need persistent local storage. Start with an Ubuntu instance with at least 2 GB RAM, and monitor storage usage as recordings accumulate.

1. Create an Ubuntu Linux instance and attach a [Lightsail static IP](https://docs.aws.amazon.com/lightsail/latest/userguide/lightsail-create-static-ip.html).
2. Point a domain/subdomain's DNS A record to that IP. Only add an AAAA record if IPv6 is configured and reachable.
3. Install Docker Engine and the Compose plugin using [Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).
4. Clone this repository onto the instance and check out the revision you have tested. Copy `.env.example` to `.env`, set a strong unique `ADMIN_PASSWORD`, and set `DOMAIN` to the hostname, such as `scores.example.com` (no scheme or path). Restrict `.env` permissions: `chmod 600 .env`.
5. In the Lightsail networking firewall, allow TCP 80 and 443; restrict SSH to your IP where possible. Do not expose port 3000. See [Lightsail firewall documentation](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html).
6. Start with the production file **on its own**, not merged with the local configuration:

   ```sh
   docker compose -f compose.production.yaml up -d --build
   docker compose -f compose.production.yaml ps
   docker compose -f compose.production.yaml logs -f proxy
   ```

Caddy obtains and renews HTTPS certificates once DNS and ports are reachable. The production configuration enables secure cookies and trusts the single internal reverse proxy. Open `https://your-hostname`, sign in, and create a session. Share that address and a session code.

The app container runs as a non-root user. Its health check verifies the HTTP service. Uploaded files are limited to 150 MB each; audio preparation is serialized and limited to five minutes per file to keep a small instance responsive. For long recordings, a larger instance or splitting the audio may be necessary.

### Backup and restore

Back up before upgrading and regularly afterward. Stop the app first so the SQLite database, WAL files, and uploads form a consistent copy. These commands work for the production Compose file, from the checkout directory:

```sh
mkdir -p backups
docker compose -f compose.production.yaml stop app
docker compose -f compose.production.yaml run --rm --no-deps --user root \
  --entrypoint tar -v "$PWD/backups:/backup" app \
  -czf /backup/review-data.tar.gz -C /app/data .
docker compose -f compose.production.yaml start app
```

Copy that archive securely off the instance. It contains private recordings, notes, and active login sessions. Repeated backups overwrite this filename; rename or date retained copies. Also retain `.env` securely. Enable Lightsail snapshots as an additional recovery measure.

To restore into a **new, empty** application volume, copy the archive to `backups/review-data.tar.gz`, then run:

```sh
docker compose -f compose.production.yaml stop app
docker compose -f compose.production.yaml run --rm --no-deps --user root \
  --entrypoint tar -v "$PWD/backups:/backup" app \
  -xzf /backup/review-data.tar.gz -C /app/data
docker compose -f compose.production.yaml run --rm --no-deps --user root \
  --entrypoint chown app -R node:node /app/data
docker compose -f compose.production.yaml up -d
```

Do not extract over a live or populated database. Rehearse a restore before relying on a backup. For updates, take a backup, fetch/check out the desired repository revision, then run the production `up -d --build` command again.

## Access model and current scope

The library has one owner password. A session code is shared access: anyone who knows it can see all files/notes in that session and contribute. Names identify comments for convenience; they are not verified identities. Reviewers can edit notes made with their current browser login, which expires after seven days. Signing out or using another browser loses that edit identity; the owner can still manage those notes. Rotating a code revokes all reviewer logins for that session.

Changing `ADMIN_PASSWORD` changes future owner sign-ins; existing owner cookies expire after seven days. To invalidate **all** active logins immediately, run the following inside the application container:

```sh
docker compose -f compose.production.yaml exec app node --input-type=module -e \
  "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/app/data/review.sqlite'); db.exec('DELETE FROM auth'); db.close();"
```

Score pins are manual page locations. There is no automatic score following, transcription, waveform alignment, email notification, or verified multi-user account system. The original PDF is available via “Open PDF”; the visual canvas itself does not provide an accessible transcription of musical notation. Use one app replica with its local persistent volume. File/annotation storage has no total quota; monitor disk space and keep backups.
