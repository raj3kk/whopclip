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
            ensureSessionsOnServer()
            val job = claimJob() ?: return@withContext Result.success()
            Log.i(TAG, "claimed job ${job.optString("id")} type=${job.optString("type")}")
            try {
                val out = JobEngine(applicationContext).run(job)
                reportJob(job.getString("id"), "done", out)
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
            for (svc in listOf("whop", "instagram")) {
                val info = services.optJSONObject(svc) ?: continue
                val linkedLocal = if (svc == "whop") SessionManager.isWhopLinked(applicationContext)
                else SessionManager.isIgLinked(applicationContext)
                if (linkedLocal && !info.optBoolean("linked", false)) {
                    val page = if (svc == "whop") "https://whop.com/" else "https://www.instagram.com/"
                    Log.i(TAG, "re-uploading $svc session (server forgot it)")
                    // suspend fun — we are in a suspend context already
                    kotlinx.coroutines.runBlocking {
                        SessionManager.uploadSession(applicationContext, svc, page)
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "ensureSessions failed: ${e.message}")
        }
    }

    private fun api(path: String, method: String = "GET", body: JSONObject? = null): JSONObject? {
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
            if (conn.responseCode == 204) null
            else JSONObject(conn.inputStream.bufferedReader().readText())
        } catch (e: Exception) {
            Log.w(TAG, "api $path failed: ${e.message}")
            null
        } finally { conn.disconnect() }
    }

    private fun claimJob(): JSONObject? {
        val deviceId = SessionManager.deviceId(applicationContext)
        return api("/api/jobs/next?device_id=$deviceId")?.optJSONObject("job")
    }

    private fun reportJob(id: String, status: String, result: JSONObject) {
        api("/api/jobs/$id", "POST", JSONObject().put("status", status).put("result", result))
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
