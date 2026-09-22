# WhopClip — automated Whop Content Rewards clipper (Android + control plane)

Production status: **live**. Server: https://whopclip.vercel.app (Vercel, `raj3kk/whopclip`, root `server/`).
Android: `com.whopclip.agent` v1.0.0 (versionCode 2), release-signed APK:
**https://whopclip.vercel.app/whopclip-v5.apk**

> This is a brand-new project. It is NOT related to the deleted ClipFlow/AutoClip.

## How it works

1. User installs the APK, opens it, taps **Whop login** and **Instagram login**
   (in-app WebViews, once). Cookies are extracted and POSTed to the server
   AES-256-GCM encrypted (`SESSION_MASTER_KEY`).
2. Server picks the best eligible campaign
   (`POST /api/campaigns` → `select`: active + budget>0 + not already submitted;
   prefers joined, then highest $/1k).
3. Orchestrator enqueues jobs (`POST /api/jobs/enqueue`); the phone claims them
   (`GET /api/jobs/next`, atomic CAS claim), runs the WebView steps, reports back.
4. Video is rendered on the VM (`pipeline/render.py`: 1080×1920, safe-zone
   captions burned with libass).
5. Phone posts to Instagram (foreground `JobRunnerActivity` handles the system
   file picker — a background WebView cannot), extracts + live-verifies the Reel
   URL, then submits it to the same Whop campaign and verifies submitted/pending.
6. Earnings ledger: `GET /api/earnings?device_id=...`.

## Fail-closed rules (no silent wrong actions)

- No eligible campaign → job is never created; `select` returns `campaign:null`.
- Upload without foreground activity → job requeued + user notified (never skipped).
- Step text missing (`assert_text`) → job fails, nothing posted.
- Session expired mid-job → server marks it stale; app prompts re-login.
- Duplicate campaign submission → blocked server-side (`alreadySubmitted`).
- Pipeline refuses non-authorized download sources (`--allow-domain` required).

## Server env vars (Vercel)

| Var | Purpose |
|---|---|
| `SESSION_MASTER_KEY` | 64-hex key for AES-256-GCM session encryption (set) |
| `SUPABASE_SERVICE_ROLE_KEY` | durable state in `flipify_kv` (`whopclip:*` keys). **Not set yet** — without it the server uses ephemeral in-memory state (works, but jobs/sessions don't survive cold starts). Set via a secure capture flow, then redeploy. |
| `SUPABASE_URL` | defaults to the project's Supabase host; override only if it moves |
| `CRON_SECRET` | random secret (e.g. `openssl rand -hex 32`) for `GET /api/schedule/tick`; Vercel cron hits it every 15 min via `server/vercel.json`. Without it the schedule runner returns 503 and scheduled runs never fire. |

### Schedule cron

`server/vercel.json` runs `GET /api/schedule/tick` every 15 minutes. The route
requires the `x-cron-secret` header to equal `CRON_SECRET`. For every registered
device whose schedule is due it enqueues a `check` run and marks the schedule
so it fires once per day. This is the source of truth for scheduled automation.

State is namespaced `whopclip:*` inside the existing `flipify_kv` table — no new
tables, no SQL migrations.

## Android build (release)

Prereqs: JDK 17, Android SDK (platform-34, build-tools 34.0.0), Gradle 8.7.

```bash
export ANDROID_SDK_ROOT=$HOME/workspace/.android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
gradle assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

Signing: `android/whopclip-release.keystore` + `android/keystore.properties`
(both NOT in git; kept in the persistent workspace). `versionCode` is bumped
per release in `android/app/build.gradle`.

## API quick reference

- `POST /api/sessions` — upload encrypted session
- `GET /api/sessions/status?device_id=` — linked/stale per service
- `GET/POST /api/campaigns` — list / select / upsert
- `POST /api/jobs/enqueue`, `GET /api/jobs/next?device_id=`, `POST /api/jobs/:id` (done|failed|requeue), `GET /api/jobs?device_id=`
- `GET /api/earnings?device_id=`
- Job templates: `server/lib/jobs.ts` (`checkJoinJob`, `joinJob`, `igPostJob`, `whopSubmitJob`)

## What still needs the user

1. Install the APK on the phone, set Server URL to `https://whopclip.vercel.app`,
   log into Whop + Instagram once in the app.
2. A real campaign: orchestrator selects/creates it after sessions are linked.
3. `SUPABASE_SERVICE_ROLE_KEY` on Vercel (one env var) for durable state.
