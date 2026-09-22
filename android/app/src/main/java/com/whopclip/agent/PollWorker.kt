package com.whopclip.agent

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Periodic worker: claims one job from the server, runs it through the
 * JobEngine WebView, and reports the result back. Runs even when the
 * app UI is closed (as long as WorkManager constraints allow).
 */
class PollWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    private val TAG = "PollWorker"

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            if (!SessionManager.isWhopLinked(applicationContext) ||
                !SessionManager.isIgLinked(applicationContext)
            ) {
                Log.i(TAG, "not linked yet — skipping poll")
                return@withContext Result.success()
            }
            val job = claimJob() ?: return@withContext Result.success()
            Log.i(TAG, "claimed job ${job.optString("id")} type=${job.optString("type")}")
            try {
                val out = JobEngine(applicationContext).run(job)
                reportJob(job.getString("id"), "done", out)
            } catch (e: Exception) {
                Log.e(TAG, "job failed", e)
                reportJob(job.getString("id"), "failed",
                    JSONObject().put("error", e.message ?: "unknown"))
            }
            Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "poll error", e)
            Result.retry()
        }
    }

    private fun claimJob(): JSONObject? {
        val deviceId = SessionManager.deviceId(applicationContext)
        val url = "${SessionManager.serverUrl(applicationContext)}/api/jobs/next?device_id=$deviceId"
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20000; readTimeout = 20000
        }
        return try {
            if (conn.responseCode == 204) null
            else JSONObject(conn.inputStream.bufferedReader().readText()).optJSONObject("job")
        } finally { conn.disconnect() }
    }

    private fun reportJob(id: String, status: String, result: JSONObject) {
        val url = "${SessionManager.serverUrl(applicationContext)}/api/jobs/$id"
        val body = JSONObject().put("status", status).put("result", result)
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Content-Type", "application/json")
            connectTimeout = 20000; readTimeout = 20000
            doOutput = true
        }
        try {
            conn.outputStream.bufferedWriter().use { it.write(body.toString()) }
            Log.i(TAG, "report $id -> $status : HTTP ${conn.responseCode}")
        } finally { conn.disconnect() }
    }
}
