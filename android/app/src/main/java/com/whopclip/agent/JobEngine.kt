package com.whopclip.agent

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Executes server-sent JSON step specs inside a WebView.
 *
 * Step schema (each step is a JSONObject):
 *   {"action":"goto","url":"https://..."}
 *   {"action":"wait","ms":2000}
 *   {"action":"wait_text","text":"Share","timeout_ms":30000}
 *   {"action":"assert_text","text":"likes"}          - fail fast if text absent
 *   {"action":"click_text","text":"Next","timeout_ms":15000}
 *   {"action":"type","selector":"textarea","text":"caption..."}
 *   {"action":"js","code":"...return document.title;"}
 *   {"action":"upload","selector":"input[type=file]"} - clicks the file input;
 *        needs JobRunnerActivity's onShowFileChooser (foreground). Headless
 *        runs throw JobFailed("needs_foreground...") so the worker requeues.
 *   {"action":"extract","key":"post_url","code":"...return location.href;"}
 *
 * Special result contract: if the page shows a login wall, steps should
 * include {"session_expired": true, "service": "whop"|"instagram"} in the
 * reported result — the server then flags the session stale (re-login prompt).
 *
 * Returns JSONObject of extracted values on success, or throws JobFailed.
 *
 * Live reporting: after every step the engine POSTs a heartbeat to
 * /api/jobs/{id}/heartbeat (current step) and uploads a downscaled live
 * frame (key "live") to /api/frames — the dashboard Live tab shows the
 * phone's screen at the top with job history below. Reporting failures
 * never fail the job.
 */
class JobEngine(private val ctx: Context) {
    private val TAG = "JobEngine"

    class JobFailed(msg: String) : Exception(msg)
    /** Owner ne dashboard se cancel kiya — heartbeat ne cancel_requested dekha. */
    class JobCancelled(msg: String) : Exception(msg)

    companion object {
        /** In-memory tracker of the currently running job, for the Live tab. */
        @Volatile private var currentJobDesc: String? = null

        fun setCurrentJob(desc: String?) { currentJobDesc = desc }
        fun currentJobInfo(): String? = currentJobDesc
    }

    @Volatile private var lastJsResult: String? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    /** Video URI pre-downloaded from the job's video_url (auto-supplied to file inputs). */
    @Volatile private var pendingVideoUri: Uri? = null

    /**
     * Called by JobRunnerActivity.onShowFileChooser. Returns true if the engine
     * auto-supplied the pre-downloaded video (no picker needed).
     */
    fun handleFileChooser(callback: ValueCallback<Array<Uri>>): Boolean {
        val uri = pendingVideoUri
        if (uri != null) {
            pendingVideoUri = null // one-shot
            mainHandler.post { callback.onReceiveValue(arrayOf(uri)) }
            Log.i(TAG, "file chooser auto-supplied: $uri")
            return true
        }
        return false
    }

    /**
     * Downloads job.payload.video_url (set by the orchestrator) into the app
     * cache and returns a FileProvider content URI, or null when absent/failed.
     */
    private suspend fun prepareUploadVideo(job: JSONObject): Uri? =
        withContext(Dispatchers.IO) {
            val url = job.optJSONObject("payload")?.optString("video_url").orEmpty()
            if (url.isBlank()) return@withContext null
            try {
                val dir = File(ctx.cacheDir, "uploads").apply { mkdirs() }
                val out = File(dir, "job_${job.optString("id", "vid")}.mp4")
                if (!out.exists() || out.length() == 0L) {
                    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                        instanceFollowRedirects = true
                        connectTimeout = 30000
                        readTimeout = 120000
                        setRequestProperty("User-Agent", "WhopClip/1.0")
                    }
                    if (conn.responseCode !in 200..299)
                        throw Exception("video download HTTP ${conn.responseCode}")
                    conn.inputStream.use { inp ->
                        FileOutputStream(out).use { o -> inp.copyTo(o) }
                    }
                    conn.disconnect()
                }
                if (out.length() == 0L) return@withContext null
                FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", out)
            } catch (e: Exception) {
                Log.w(TAG, "prepareUploadVideo failed: ${e.message}")
                null
            }
        }

    private inner class JsBridge {
        @JavascriptInterface
        fun onResult(value: String) {
            lastJsResult = value
        }
    }

    /**
     * Captures the WebView's current visible content as a PNG in the app
     * cache (frames/). Returns the absolute file path. Must be called off
     * the main thread; the bitmap capture itself hops to the UI thread.
     */
    private suspend fun captureScreenshot(wv: WebView, key: String): String =
        withContext(Dispatchers.IO) {
            val safeName = key.replace(Regex("[^A-Za-z0-9._-]"), "_")
            val dir = File(ctx.cacheDir, "frames").apply { mkdirs() }
            val out = File(dir, safeName)
            val bmp = suspendCancellableCoroutine<android.graphics.Bitmap> { cont ->
                mainHandler.post {
                    try {
                        val b = android.graphics.Bitmap.createBitmap(
                            wv.width.coerceAtLeast(1),
                            wv.height.coerceAtLeast(1),
                            android.graphics.Bitmap.Config.ARGB_8888
                        )
                        val canvas = android.graphics.Canvas(b)
                        wv.draw(canvas)
                        cont.resume(b)
                    } catch (e: Exception) {
                        cont.resume(
                            android.graphics.Bitmap.createBitmap(
                                1, 1, android.graphics.Bitmap.Config.ARGB_8888
                            )
                        )
                        Log.w(TAG, "screenshot capture failed: ${e.message}")
                    }
                }
            }
            try {
                FileOutputStream(out).use { fos ->
                    bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 90, fos)
                }
            } finally {
                bmp.recycle()
            }
            Log.i(TAG, "screenshot saved: ${out.absolutePath} (${out.length()} bytes)")
            out.absolutePath
        }

    /**
     * Uploads a captured frame to POST /api/frames (device-authenticated via
     * device_id + job id). Returns the server URL on success, null otherwise.
     * Frame upload failure never fails the job by itself — the caller decides.
     * NOTE: single output stream for the whole multipart body — reopening
     * HttpURLConnection's stream mid-request breaks the upload.
     */
    private suspend fun uploadFrame(
        job: JSONObject,
        key: String,
        path: String,
        contentType: String = "image/png",
        extraFields: Map<String, String> = emptyMap()
    ): String? =
        withContext(Dispatchers.IO) {
            try {
                val file = File(path)
                if (!file.exists() || file.length() == 0L) return@withContext null
                val boundary = "WhopClipFrame${System.currentTimeMillis()}"
                val deviceId = SessionManager.deviceId(ctx)
                val jobId = job.optString("id", "")
                val url = "${SessionManager.serverUrl(ctx)}/api/frames"
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                    connectTimeout = 30000
                    readTimeout = 60000
                    doOutput = true
                }
                val out = conn.outputStream.buffered()
                fun field(name: String, value: String) {
                    out.write("--$boundary\r\n".toByteArray())
                    out.write("Content-Disposition: form-data; name=\"$name\"\r\n\r\n".toByteArray())
                    out.write("$value\r\n".toByteArray())
                }
                field("device_id", deviceId)
                field("job_id", jobId)
                field("key", key)
                for ((k, v) in extraFields) field(k, v)
                out.write("--$boundary\r\n".toByteArray())
                out.write("Content-Disposition: form-data; name=\"frame\"; filename=\"$key\"\r\n".toByteArray())
                out.write("Content-Type: $contentType\r\n\r\n".toByteArray())
                file.inputStream().use { it.copyTo(out) }
                out.write("\r\n--$boundary--\r\n".toByteArray())
                out.flush()
                out.close()
                val code = conn.responseCode
                val body = try {
                    conn.inputStream.bufferedReader().readText()
                } catch (_: Exception) { "" }
                finally { conn.disconnect() }
                if (code !in 200..299) {
                    Log.w(TAG, "frame upload failed: HTTP $code")
                    return@withContext null
                }
                JSONObject(body).optString("url", "").ifBlank { null }
            } catch (e: Exception) {
                Log.w(TAG, "frame upload error: ${e.message}")
                null
            }
        }

    /**
     * Live reporting after every job step: sends a heartbeat to
     * POST /api/jobs/{id}/heartbeat (server knows the job is alive and
     * which step it's on) and uploads a downscaled live frame (key "live")
     * to POST /api/frames (dashboard Live tab shows the phone's screen).
     * All failures are swallowed — reporting must never fail the job.
     */
    private suspend fun reportLive(job: JSONObject, wv: WebView, stepDesc: String) {
        setCurrentJob(
            "Chal raha: ${job.optString("type", "job")} " +
                "${job.optString("id", "").take(8)} — $stepDesc"
        )
        try {
            // Owner ne cancel kiya ho to turant ruko — ye exception run()
            // ke finally se hote hue caller tak jaati hai jo "cancelled"
            // report karta hai. Reporting kabhi job fail nahi karti.
            if (postHeartbeat(job, stepDesc)) {
                Log.i(TAG, "cancel requested by owner — aborting job")
                throw JobCancelled("owner ne dashboard se cancel kiya")
            }
        } catch (e: JobCancelled) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "heartbeat failed: ${e.message}")
        }
        try {
            uploadLiveFrame(job, wv, stepDesc)
        } catch (e: Exception) {
            Log.w(TAG, "live frame failed: ${e.message}")
        }
    }

    /**
     * Heartbeat bhejta hai; true lautaata hai jab server ne cancel_requested
     * bheja ho (owner ne job cancel kiya).
     */
    private suspend fun postHeartbeat(job: JSONObject, step: String): Boolean =
        withContext(Dispatchers.IO) {
            val deviceId = SessionManager.deviceId(ctx)
            val jobId = job.optString("id", "")
            if (jobId.isBlank()) return@withContext false
            val url = "${SessionManager.serverUrl(ctx)}/api/jobs/$jobId/heartbeat"
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                connectTimeout = 15000
                readTimeout = 15000
                doOutput = true
            }
            try {
                val body = JSONObject()
                    .put("device_id", deviceId)
                    .put("current_step", step)
                    .toString()
                conn.outputStream.use { it.write(body.toByteArray()) }
                val code = conn.responseCode
                Log.i(TAG, "heartbeat -> $step (HTTP $code)")
                if (code !in 200..299) return@withContext false
                val resp = try {
                    JSONObject(conn.inputStream.bufferedReader().readText())
                } catch (_: Exception) {
                    JSONObject()
                }
                resp.optBoolean("cancel_requested", false)
            } finally {
                conn.disconnect()
            }
        }

    /**
     * Captures the WebView, downscales to 360px wide JPEG (quality 55) and
     * uploads as key "live" with job_type + current_step fields.
     */
    private suspend fun uploadLiveFrame(job: JSONObject, wv: WebView, step: String) =
        withContext(Dispatchers.IO) {
            val bmp = suspendCancellableCoroutine<android.graphics.Bitmap> { cont ->
                mainHandler.post {
                    try {
                        val b = android.graphics.Bitmap.createBitmap(
                            wv.width.coerceAtLeast(1),
                            wv.height.coerceAtLeast(1),
                            android.graphics.Bitmap.Config.ARGB_8888
                        )
                        wv.draw(android.graphics.Canvas(b))
                        cont.resume(b)
                    } catch (e: Exception) {
                        cont.resumeWithException(e)
                    }
                }
            }
            try {
                val sw = 360
                val sh = (bmp.height * sw / bmp.width).coerceAtLeast(1)
                val scaled = android.graphics.Bitmap.createScaledBitmap(bmp, sw, sh, true)
                val dir = File(ctx.cacheDir, "frames").apply { mkdirs() }
                val out = File(dir, "live.jpg")
                FileOutputStream(out).use { fos ->
                    scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, 55, fos)
                }
                scaled.recycle()
                Log.i(TAG, "live frame: ${out.length()} bytes")
                uploadFrame(
                    job, "live", out.absolutePath, "image/jpeg",
                    mapOf(
                        "job_type" to job.optString("type", ""),
                        "current_step" to step
                    )
                )
            } finally {
                bmp.recycle()
            }
        }

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    private fun makeWebView(): WebView {
        val wv = WebView(ctx)
        // v17: SOFTWARE layer — a hardware-accelerated detached WebView's
        // draw(Canvas) captures a stale GPU buffer (showed the phone's home
        // screen instead of the page). Software rendering makes live frames
        // capture the actual page content.
        wv.setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.mediaPlaybackRequiresUserGesture = false
        android.webkit.CookieManager.getInstance().setAcceptCookie(true)
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true)
        wv.addJavascriptInterface(JsBridge(), "WhopClip")
        wv.webChromeClient = WebChromeClient()
        return wv
    }

    private suspend fun evalJs(wv: WebView, code: String, timeoutMs: Long = 20000): String =
        withTimeoutOrNull(timeoutMs) {
            suspendCancellableCoroutine { cont ->
                lastJsResult = null
                mainHandler.post {
                    wv.evaluateJavascript("(function(){try{var r=($code);WhopClip.onResult(JSON.stringify(r));}catch(e){WhopClip.onResult(JSON.stringify({__err:String(e)}));}})()") {}
                }
                Thread {
                    val t0 = System.currentTimeMillis()
                    while (System.currentTimeMillis() - t0 < timeoutMs) {
                        lastJsResult?.let { cont.resume(it); return@Thread }
                        Thread.sleep(100)
                    }
                    if (cont.isActive) cont.resume("null")
                }.start()
            }
        } ?: throw JobFailed("js timeout: ${code.take(80)}")

    private suspend fun waitFor(wv: WebView, jsCondition: String, timeoutMs: Long, label: String) {
        val t0 = System.currentTimeMillis()
        while (System.currentTimeMillis() - t0 < timeoutMs) {
            val r = evalJs(wv, jsCondition, 8000)
            if (r == "true") return
            kotlinx.coroutines.delay(700)
        }
        throw JobFailed("wait timeout: $label")
    }

    /**
     * Runs all steps; returns extracted values. Must be called off the main thread.
     * @param externalWebView when JobRunnerActivity hosts the WebView (file chooser
     * wired) — the engine uses it and does NOT destroy it afterwards.
     */
    suspend fun run(job: JSONObject, externalWebView: WebView? = null): JSONObject =
        withContext(Dispatchers.IO) {
            val extracted = JSONObject()
            val steps: JSONArray = job.optJSONArray("steps") ?: JSONArray()
            val ownsWebView = externalWebView == null
            val jobDesc = "${job.optString("type", "job")} ${job.optString("id", "").take(8)}"
            setCurrentJob("Chal raha: $jobDesc (${steps.length()} steps)")
            Log.i(TAG, "job start: $jobDesc")

            val wv: WebView = if (externalWebView != null) {
                suspendCancellableCoroutine { cont ->
                    mainHandler.post {
                        externalWebView.addJavascriptInterface(JsBridge(), "WhopClip")
                        cont.resume(Unit)
                    }
                }
                externalWebView
            } else {
                var created: WebView? = null
                suspendCancellableCoroutine<Unit> { cont ->
                    mainHandler.post {
                        val wv2 = makeWebView()
                        // Headless WebView ko viewport do taaki live frames
                        // aur verify screenshots ka size real ho (bina layout
                        // ke width/height 0 hote hain).
                        wv2.layout(0, 0, 480, 854)
                        created = wv2
                        cont.resume(Unit)
                    }
                }
                created ?: throw JobFailed("webview init failed")
            }

            try {
                // Pre-download the orchestrator-provided video so file inputs can
                // be auto-filled without the system picker (see handleFileChooser).
                // Only when the job actually has an upload step — skip the
                // download for pure browsing/click jobs.
                val needsUpload = (0 until steps.length()).any {
                    steps.getJSONObject(it).optString("action") == "upload"
                }
                pendingVideoUri = if (needsUpload) prepareUploadVideo(job) else null
                for (i in 0 until steps.length()) {
                    val s = steps.getJSONObject(i)
                    when (s.optString("action")) {
                        "goto" -> {
                            var url = s.getString("url")
                            // "__POST_URL__" placeholder: substitute the post_url
                            // extracted earlier by an `extract` step (see igPostJob).
                            // Fail closed: never navigate to the literal placeholder.
                            if (url.contains("__POST_URL__")) {
                                val real = extracted.optString("post_url", "")
                                if (real.isBlank() || real == "__POST_URL__")
                                    throw JobFailed("goto: __POST_URL__ placeholder unresolved — post_url not extracted yet")
                                url = url.replace("__POST_URL__", real)
                            }
                            val target = url
                            val latch = java.util.concurrent.CountDownLatch(1)
                            mainHandler.post {
                                wv.webViewClient = object : WebViewClient() {
                                    override fun onPageFinished(view: WebView?, u: String?) {
                                        latch.countDown()
                                    }
                                }
                                wv.loadUrl(target)
                            }
                            if (!latch.await(45, java.util.concurrent.TimeUnit.SECONDS))
                                throw JobFailed("goto timeout: $target")
                            kotlinx.coroutines.delay(1500)
                        }
                        "wait" -> kotlinx.coroutines.delay(s.optLong("ms", 2000))
                        "wait_text" -> {
                            val t = s.getString("text").replace("'", "\\'")
                            waitFor(
                                wv,
                                "document.body && document.body.innerText.includes('$t')",
                                s.optLong("timeout_ms", 30000), "text:$t"
                            )
                        }
                        "assert_text" -> {
                            val t = s.getString("text").replace("'", "\\'")
                            val r = evalJs(
                                wv,
                                "!!(document.body && document.body.innerText.includes('$t'))"
                            )
                            if (r != "true") throw JobFailed("assert_text missing: $t")
                        }
                        "click_text" -> {
                            val t = s.getString("text").replace("'", "\\'")
                            val timeout = s.optLong("timeout_ms", 15000)
                            val clicked = withTimeoutOrNull(timeout) {
                                while (true) {
                                    val r = evalJs(
                                        wv, """
                                        (function(){
                                          var els=[...document.querySelectorAll('button,a,[role=button]')];
                                          for(var e of els){ if((e.innerText||'').trim().toLowerCase()==='${t.lowercase()}'){e.click();return true;} }
                                          return false;
                                        })()
                                        """.trimIndent(), 8000
                                    )
                                    if (r == "true") return@withTimeoutOrNull true
                                    kotlinx.coroutines.delay(800)
                                }
                                @Suppress("UNREACHABLE_CODE") false
                            } ?: throw JobFailed("click_text not found: $t")
                            if (!clicked) throw JobFailed("click_text failed: $t")
                            kotlinx.coroutines.delay(1500)
                        }
                        "type" -> {
                            val sel = s.getString("selector").replace("'", "\\'")
                            val text = s.getString("text")
                                .replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
                            evalJs(
                                wv, """
                                (function(){var el=document.querySelector('$sel');if(!el)return 'no-el';
                                el.focus();document.execCommand('selectAll',false,null);
                                document.execCommand('insertText',false,'$text');
                                el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()
                                """.trimIndent()
                            )
                            kotlinx.coroutines.delay(1000)
                        }
                        "js" -> evalJs(wv, s.getString("code"))
                        "extract" -> {
                            val key = s.getString("key")
                            val r = evalJs(wv, s.getString("code"))
                            extracted.put(key, r.trim('"'))
                        }
                        "screenshot" -> {
                            // Captures the WebView's visible bitmap (for frame-level
                            // live-reel verification at 1s/7s/15s/25s). Saves to the
                            // app cache and records the file path in `extracted`
                            // under the step's "key" (default "frame_<i>.png").
                            // Optionally uploads to the server when "upload" is true
                            // (POST /api/frames, device-authenticated).
                            val key = s.optString("key", "frame_$i.png")
                            val path = captureScreenshot(wv, key)
                            extracted.put(key, path)
                            if (s.optBoolean("upload", false)) {
                                val url = uploadFrame(job, key, path)
                                if (url != null) extracted.put("${key}_url", url)
                            }
                        }
                        "upload" -> {
                            // Headless PollWorker has no activity/file-picker: fail
                            // fast so the job is requeued and the user is notified
                            // (no pointless 90s wait here).
                            if (ownsWebView)
                                throw JobFailed("needs_foreground: upload needs the app open (file picker)")
                            // Arm BEFORE the JS click: the auto-supply path in
                            // onShowFileChooser -> handleFileChooser signals the
                            // latch that awaitFile() is waiting on.
                            UploadBridge.arm()
                            val sel = s.optString("selector", "input[type=file]").replace("'", "\\'")
                            val r = evalJs(
                                wv,
                                "(function(){var el=document.querySelector('$sel');if(!el)return 'no-el';el.click();return 'clicked';})()"
                            )
                            if (r.trim('"') != "clicked")
                                throw JobFailed("upload: file input not found ($sel)")
                            // JobRunnerActivity's onShowFileChooser shows the picker and
                            // signals UploadBridge. If the picker never fires -> requeue.
                            if (!UploadBridge.awaitFile(90000))
                                throw JobFailed("needs_foreground: upload needs the app open (file picker)")
                            kotlinx.coroutines.delay(2000)
                        }
                        else -> throw JobFailed("unknown action: ${s.optString("action")}")
                    }
                    Log.i(TAG, "step $i ok: ${s.optString("action")}")
                    // Live reporting: heartbeat + live frame after every step.
                    // Never fails the job — errors are caught inside.
                    reportLive(job, wv, "step ${i + 1}/${steps.length()}: ${s.optString("action")}")
                }
            } finally {
                if (ownsWebView) mainHandler.post { wv.destroy() }
                setCurrentJob(null)
                Log.i(TAG, "job done: $jobDesc")
            }
            extracted
        }
}
