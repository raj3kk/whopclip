# WhopClip Root-Cause Fixes — v24 (2026-09-27)

## Virtual Test Results
Sabhi fixes ko bina phone ke virtual test kiya gaya (`/tmp/test_whopclip_fixes.py`).
Saare tests PASS — purane bugs confirm hue, naye fixes sahi kaam karte hain.

---

## Fix 1: 5-second screenshot loop (JobEngine.kt)
**Root cause:** `reportLive()` sirf har step ke BAAD call hota tha. Lambe steps
(goto 45s, wait_text 30s, upload 90s) ke dauran ZERO screenshots upload hote the.
**Evidence:** Virtual test me 35s ke blocking step me purane code se 0 screenshots mile.
**Fix:** `JobEngine.run()` me concurrent coroutine loop — har 5 sec me live frame
capture + upload, steps ke saath-saath. `finally` me loop band hota hai.
**Test:** 35s block me 6 screenshots, ~5s ke gap par — PASS.

## Fix 2: Independent 30-second heartbeat (JobEngine.kt)
**Root cause:** Heartbeat bhi sirf step ke baad jata tha. Lambe step me server ko
lagta tha job mar gayi (koi heartbeat nahi).
**Evidence:** 65s ke block me purane code se 0 heartbeat.
**Fix:** Concurrent loop — pehla heartbeat turant (t=0), phir har 30 sec me.
Cancel hone par `JobCancelled` throw hota hai (owner dashboard se cancel).
**Test:** 65s block me 3 heartbeat (0s, 30s, 60s) — PASS.

## Fix 3: Server-side stuck-job recovery cron (NEW)
**Root cause:** `requeueStuckJobs()` sirf `/api/jobs/next` me chalta tha — matlab
sirf jab phone poll kare. Phone silent hua (3.5 ghante) to stuck job "running"
mein atki rahi, recovery kabhi chali hi nahi.
**Evidence:** Job 1ece4935 213 min se "running", bina heartbeat — recovery nahi hui
kyunki phone ne poll hi nahi kiya.
**Fix:** Naya endpoint `/api/cron/recover-stuck` + vercel.json me har 15 min ka
cron. Ab phone ke bina bhi server khud stuck jobs ko requeue karega.
**Test:** Phone silent + 15 min purana heartbeat = cron requeue karta hai — PASS.

## Fix 4: setOnline se Whop+IG gate hataya (MainActivity.kt)
**Root cause:** Online hone ke liye Whop AUR Instagram dono me login zaroori tha.
Jo user sirf Instagram use karta hai wo "Online" dabane par atak jata tha.
**Evidence:** User ne "Nhi hua" bola — isi gate ki wajah se tha.
**Fix:** Ab sirf paired hona zaroori hai. Session validity job chalate waqt check
hoti hai, Online hote waqt nahi.
**Test:** IG-only user ab online ho sakta hai (pehle blocked tha) — PASS.

## Fix 5 (v22/v23 me pehle ho chuka): Poll silence
**Root cause:** `isOnline` default false tha + 15-min WorkManager sirf tab schedule
hota tha jab saare gates pass hon. Fresh pair kabhi poll nahi karta tha.
**Fix (v22):** Default true + paired device par hamesha schedule.

## Fix 6: current_step step se PEHLE set (JobEngine.kt)
**Root cause:** `current_step` sirf `reportLive` me set hota tha (step ke baad).
Lambe step ke dauran dashboard par kuch nahi dikhta tha.
**Fix:** Har step shuru hone se PEHLE `liveStepDesc` update hota hai, jise
concurrent loops padhte hain.
**Test:** Step t=0.00s par set hota hai (10s block se pehle) — PASS.

---

## v24 me kya hai
- Upar ke saare fixes (1, 2, 3, 4, 6)
- Guide tab (v23 se)
- Poll auto-start (v22 se)
