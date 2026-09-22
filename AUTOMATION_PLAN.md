# WhopClip Automation — Build Plan (2026-09-22)

## Survey findings
- Server has: pairing, sessions, manual campaign upsert, job queue (CAS claim),
  step templates (check/join/post/submit), daily tick cron, submissions/earnings.
- Phone JobEngine runs: goto/wait/wait_text/assert_text/click_text/type/js/extract/upload.
  It pre-downloads payload.video_url and auto-supplies it to file inputs.
- MISSING (the real automation):
  1. Campaign discovery from Whop (only manual upsert exists)
  2. Free-text requirement extraction (requirements_text extracted but never parsed)
  3. Authorized-source enforcement (no field, no fail-closed)
  4. Source download + render pipeline (nothing produces the video)
  5. Robust live-reel verification (weak assert_text "likes")
  6. Frame checks at 1s/7s/15s/25s (needs screenshot action = v6 APK)
  7. Full auto-chain check→join→render→post→verify→submit

## Architecture
- Render happens on THIS VM (ffmpeg 8.1.2 + yt-dlp + faster-whisper in whop-edit-env).
  Vercel serverless can't render (timeouts); phone can't (no ffmpeg).
- VM worker polls POST /api/render/next (CRON_SECRET auth), claims render jobs,
  downloads authorized source, transcribes, renders 9:16 with safe zones,
  uploads MP4 to Supabase storage, POSTs /api/render/result with video_url.
- Phone downloads video_url and posts to IG via existing upload path.
- Chain orchestrated server-side in lib/run.ts.

## Build order
1. server/lib/requirements.ts — free-text brief parser, fail-closed
2. server/lib/jobs.ts — discoverCampaignsJob(), hardened igPostJob, verifyReelJob()
3. server/lib/render.ts + app/api/render/* — VM worker contract
4. server/app/api/campaigns/discover/route.ts — discovery ingest
5. server/lib/run.ts — full chain with render step
6. worker/render_worker.py — VM render worker
7. Deploy, test, commit, push
8. v6 APK (AFTER v5 confirmed): screenshot action for frame checks
