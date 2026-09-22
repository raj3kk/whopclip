# WhopClip

Fresh automation for **Whop Content Rewards clipping** — earn by clipping influencer content.

> This is a brand-new project. It is NOT related to the deleted ClipFlow/AutoClip.

## How it works

1. **One-time login (Android app):** user signs in to Whop and Instagram once, inside the app's WebViews. The app extracts session cookies and uploads them to the server (AES-256-GCM encrypted).
2. **Campaign loop (server):** pick a Content Rewards campaign → join if not joined → read requirements.
3. **Video (pipeline):** download the influencer asset → edit to 9:16 with captions per campaign requirements.
4. **Post (phone):** server sends an `ig_post` job → phone's JobEngine executes the steps in a WebView → returns the Instagram post URL.
5. **Submit (phone):** server sends a `whop_submit` job → phone submits the IG link to the campaign on Whop.

## Repo layout

```
android/   Kotlin app (com.whopclip.agent)
  app/src/main/java/com/whopclip/agent/
    MainActivity.kt      - home: link status, server URL, start polling
    LoginActivity.kt     - one-time Whop/Instagram login WebViews
    SessionManager.kt    - cookie extraction + encrypted upload to server
    JobEngine.kt         - executes JSON step specs in a WebView
    PollWorker.kt        - WorkManager: claim job -> run -> report
    PollService.kt       - foreground service + boot receiver
server/    Next.js 14 control plane (deploy to Vercel)
  app/api/sessions/route.ts   - POST phone sessions (encrypted at rest)
  app/api/campaigns/route.ts  - GET campaign state per device
  app/api/jobs/next/route.ts  - GET phone claims next job (204 = empty)
  app/api/jobs/[id]/route.ts  - POST enqueue/report/list jobs
  lib/crypto.ts  - AES-256-GCM session encryption
  lib/store.ts   - in-memory store (replace with KV/Postgres for prod)
pipeline/  video render stage (v1: dry-run stub, v2: real ffmpeg edits)
```

## Job step spec

Jobs are JSON the phone executes. Supported actions:

| action | fields | purpose |
|---|---|---|
| `goto` | `url` | navigate |
| `wait` | `ms` | sleep |
| `wait_text` | `text`, `timeout_ms` | wait for text on page |
| `click_text` | `text`, `timeout_ms` | click button/link by exact text |
| `type` | `selector`, `text` | type into an element |
| `js` | `code` | run JS, returns JSON |
| `extract` | `key`, `code` | save JS result under key |

Example `ig_post` job: goto instagram.com → upload flow → caption via `type` → share via `click_text` → `extract` post_url from location. `whop_submit`: goto campaign page → paste link → submit → confirm.

## Setup

### Server
```bash
cd server
npm install
# generate once, set as Vercel env var:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # -> SESSION_MASTER_KEY
npm run build
```
Deploy the `server/` directory to Vercel.

### Android app
Open `android/` in Android Studio, set `SessionManager.DEFAULT_SERVER_URL` to your
deployed server URL (or set it in-app), build release APK, install on the phone.
Log in to Whop + Instagram once, then tap **Automation start karo**.

## Status
- [x] v1 skeleton: app login + session upload, JobEngine, polling, server API
- [ ] Server-side campaign discovery via stored Whop session
- [ ] Real video pipeline (ffmpeg 9:16 + captions)
- [ ] `upload` step file-chooser wiring in JobEngine (needs activity result)
- [ ] Persistent store (KV/Postgres) instead of in-memory
- [ ] End-to-end test: join → render → post → submit
