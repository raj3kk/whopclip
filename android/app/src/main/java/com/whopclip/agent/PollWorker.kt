package com.whopclip.agent

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Periodic worker: claims one job from the server, runs it through the
 * JobEngine WebView, and reports the result back.
 *
 * - needs_foreground (upload step headless) -> job requeued + user notified
 *   to open the app (JobRunnerActivity handles the file picker).
 * - if the server no longer has our session (e.g. server restarted), the
 *   session cookies are re-uploaded from the WebView store automatically.
 */
class PollWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    private val TAG = "PollWorker"

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            // Foreground worker: shows the persistent "background me chal raha
            // hai" notification. This is the sanctioned way to run from the
            // background on Android 12+ (plain startForegroundService is
            // blocked after boot) — and it re-arms automation after reboot
            // even when the PollService process was killed.
            setForeground(createForegroundInfo())
            // Pairing gate: unpaired phone must not touch the server queue.
            if (!SessionManager.isPaired(applicationContext)) {
                Log.i(TAG, "unpaired device — polling skipped")
                return@withContext Result.success()
            }
            // Online gate: user tapped "Offline" — no polling until "Online".
            if (!SessionManager.isOnline(applicationContext)) {
                Log.i(TAG, "device offline — polling skipped")
                return@withContext Result.success()
            }
            ensureSessionsOnServer()
            pumpServerChains()
            val job = claimJob() ?: return@withContext Result.success()
            Log.i(TAG, "claimed job ${job.optString("id")} type=${job.optString("type")}")
            try {
                val out = JobEngine(applicationContext).run(job)
                reportJob(job.getString("id"), "done", out)
            } catch (e: JobEngine.JobCancelled) {
                Log.i(TAG, "job cancelled by owner")
                reportJob(
                    job.getString("id"), "cancelled",
                    JSONObject().put("error", e.message ?: "cancelled by owner")
                )
            } catch (e: JobEngine.JobFailed) {
                if ((e.message ?: "").startsWith("needs_foreground")) {
                    requeueJob(job.getString("id"))
                    notifyOpenApp()
                    Log.i(TAG, "job requeued, user notified to open app")
                } else {
                    Log.e(TAG, "job failed", e)
                    reportJob(
                        job.getString("id"), "failed",
                        JSONObject().put("error", e.message ?: "unknown")
                    )
                }
            }
            Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "poll error", e)
            Result.retry()
        }
    }

    /** Foreground notification shown while the worker runs in background. */
    private fun createForegroundInfo(): ForegroundInfo {
        val ctx = applicationContext
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            mgr.createNotificationChannel(
                NotificationChannel(
                    PollService.CHANNEL_ID, "WhopClip background",
                    NotificationManager.IMPORTANCE_LOW
                )
            )
        }
        val openIntent = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            ctx, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notif = NotificationCompat.Builder(ctx, PollService.CHANNEL_ID)
            .setContentTitle("WhopClip background me chal raha hai")
            .setContentText("Server automation ke liye login session ready")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
        return ForegroundInfo(PollService.NOTIF_ID, notif)
    }

    /** Server storage is ephemeral: if it forgot our session, re-upload. */
    private fun ensureSessionsOnServer() {
        try {
            val deviceId = SessionManager.deviceId(applicationContext)
            val url = "${SessionManager.serverUrl(applicationContext)}/api/sessions/status?device_id=$deviceId"
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 15000; readTimeout = 15000
            }
            val body = try {
                if (conn.responseCode != 200) return
                JSONObject(conn.inputStream.bufferedReader().readText())
            } finally { conn.disconnect() }
            val services = body.optJSONObject("services") ?: return
            val staleServices = mutableListOf<String>()
            for (svc in listOf("whop", "instagram")) {
                val info = services.optJSONObject(svc) ?: continue
                val linkedLocal = if (svc == "whop") SessionManager.isWhopLinked(applicationContext)
                else SessionManager.isIgLinked(applicationContext)
                if (info.optBoolean("stale", false) && linkedLocal) staleServices.add(svc)
                if (linkedLocal && !info.optBoolean("linked", false)) {
                    val page = if (svc == "whop") "https://whop.com/" else "https://www.instagram.com/"
                    Log.i(TAG, "re-uploading $svc session (server forgot it)")
                    // suspend fun — we are in a suspend context already
                    kotlinx.coroutines.runBlocking {
                        SessionManager.uploadSession(applicationContext, svc, page)
                    }
                }
            }
            // Session expiry alert: server marked a linked session stale ->
            // notify once per stale episode so the user re-logs in.
            notifyLoginAgain(staleServices)
        } catch (e: Exception) {
            Log.w(TAG, "ensureSessions failed: ${e.message}")
        }
    }

    /**
     * Drive server-side chains. The server runs every chain stage; the
     * phone's poll is the retry driver (Vercel Hobby allows only one
     * cron/day, so long stages like `post` retry from here).
     */
    private fun pumpServerChains() {
        try {
            val deviceId = SessionManager.deviceId(applicationContext)
            val url = "${SessionManager.serverUrl(applicationContext)}/api/chains/advance?device_id=$deviceId"
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 20000; readTimeout = 90000
            }
            val code = conn.responseCode
            val body = try {
                conn.inputStream.bufferedReader().readText()
            } catch (_: Exception) { "" } finally { conn.disconnect() }
            if (code !in 200..299) {
                Log.w(TAG, "chain pump: HTTP $code")
                return
            }
            val n = try { JSONObject(body).optJSONArray("chains")?.length() ?: 0 } catch (_: Exception) { 0 }
            if (n > 0) Log.i(TAG, "chain pump: $n active chain(s) advanced")
        } catch (e: Exception) {
            Log.w(TAG, "pumpServerChains failed: ${e.message}")
        }
    }

    /**
     * "Dobara login karo" alert. Fires once per stale episode (tracked in
     * prefs); clears when the session is fresh again. Tapping opens the app.
     */
    private fun notifyLoginAgain(staleServices: List<String>) {
        try {
            val ctx = applicationContext
            val prefs = ctx.getSharedPreferences("whopclip", Context.MODE_PRIVATE)
            val key = "notified_stale"
            val cur = staleServices.sorted().joinToString(",")
            if (cur == (prefs.getString(key, "") ?: "")) return
            prefs.edit().putString(key, cur).apply()
            if (staleServices.isEmpty()) return
            val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                mgr.createNotificationChannel(
                    NotificationChannel(
                        "whopclip_login", "WhopClip login alerts",
                        NotificationManager.IMPORTANCE_HIGH
                    )
                )
            }
            val intent = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val pi = PendingIntent.getActivity(
                ctx, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val names = staleServices.joinToString(" + ") { if (it == "whop") "Whop" else "Instagram" }
            val notif = NotificationCompat.Builder(ctx, "whopclip_login")
                .setContentTitle("🔐 WhopClip: dobara login karo")
                .setContentText("$names ka session expire ho gaya — tap karke login karo")
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build()
            mgr.notify(2002, notif)
            Log.i(TAG, "login-again notification shown for: $cur")
        } catch (e: Exception) {
            Log.w(TAG, "notifyLoginAgain failed: ${e.message}")
        }
    }

    private fun api(path: String, method: String = "GET", body: JSONObject? = null,
                    throwOnError: Boolean = false): JSONObject? {
        val conn = (URL("${SessionManager.serverUrl(applicationContext)}$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 20000; readTimeout = 20000
            if (body != null) {
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
            }
        }
        return try {
            if (body != null) conn.outputStream.bufferedWriter().use { it.write(body.toString()) }
            val code = conn.responseCode
            if (code == 204) null // genuine empty queue — success
            else if (code !in 200..299) {
                // Transport/HTTP error — NOT an empty queue. Caller decides;
                // claimJob rethrows so doWork() returns Result.retry().
                Log.w(TAG, "api $path failed: HTTP $code")
                if (throwOnError) throw java.io.IOException("api $path: HTTP $code")
                null
            } else JSONObject(conn.inputStream.bufferedReader().readText())
        } catch (e: Exception) {
            Log.w(TAG, "api $path failed: ${e.message}")
            if (throwOnError) throw e
            null
        } finally { conn.disconnect() }
    }

    private fun claimJob(): JSONObject? {
        val deviceId = SessionManager.deviceId(applicationContext)
        val appV = SessionManager.appVersionCode(applicationContext)
        val model = java.net.URLEncoder.encode(
            "${Build.MANUFACTURER} ${Build.MODEL}", "UTF-8")
        return api("/api/jobs/next?device_id=$deviceId&app_version=$appV&device_model=$model",
            throwOnError = true)?.optJSONObject("job")
    }

    private fun reportJob(id: String, status: String, result: JSONObject) {
        api(
            "/api/jobs/$id", "POST",
            JSONObject().put("status", status).put("result", result)
                .put("device_id", SessionManager.deviceId(applicationContext))
        )
    }

    private fun requeueJob(id: String) {
        api("/api/jobs/$id", "POST", JSONObject().put("status", "requeue"))
    }

    private fun notifyOpenApp() {
        try {
            val ctx = applicationContext
            val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                mgr.createNotificationChannel(
                    NotificationChannel("whopclip_jobs", "WhopClip jobs", NotificationManager.IMPORTANCE_HIGH)
                )
            }
            val intent = Intent(ctx, JobRunnerActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val pi = PendingIntent.getActivity(
                ctx, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val notif = NotificationCompat.Builder(ctx, "whopclip_jobs")
                .setContentTitle("WhopClip: upload ready")
                .setContentText("Video upload ke liye app kholo")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build()
            mgr.notify(2001, notif)
        } catch (e: Exception) {
            Log.w(TAG, "notify failed: ${e.message}")
        }
    }
}
