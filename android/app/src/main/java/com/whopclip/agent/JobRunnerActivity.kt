package com.whopclip.agent

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Foreground job runner. Opened from the "upload ready" notification (or
 * manually) when a job needs the system file picker — something a
 * background WebView cannot do. Hosts the WebView, wires
 * onShowFileChooser -> system picker -> UploadBridge, and runs the job
 * through JobEngine.
 *
 * v14: platform Activity (was AppCompatActivity). The manifest gives this
 * activity the platform Theme.WhopClip; AppCompatActivity REQUIRES a
 * Theme.AppCompat descendant and would die with "You need to use a
 * Theme.AppCompat theme" the moment the upload flow opened this screen.
 * The modern registerForActivityResult API needs ComponentActivity, so the
 * file picker uses the classic startActivityForResult/onActivityResult —
 * no AppCompat, no androidx.activity on this path at all.
 */
class JobRunnerActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var statusText: TextView
    private lateinit var progress: ProgressBar
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val engine: JobEngine by lazy { JobEngine(this) }

    private companion object { const val REQ_FILE_PICK = 4211 }

    /** Classic platform file-picker result — replaces registerForActivityResult. */
    @Deprecated("platform callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILE_PICK) return
        val cb = filePathCallback
        filePathCallback = null
        val uri: Uri? = if (resultCode == RESULT_OK) data?.data else null
        UploadBridge.signal(uri != null)
        cb?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_job_runner)
        title = "WhopClip job chal raha hai"

        webView = findViewById(R.id.jobWebView)
        // v17: SOFTWARE layer so live-frame capture (draw) shows the page,
        // not a stale GPU buffer (home screen).
        webView.setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null)
        statusText = findViewById(R.id.jobStatus)
        progress = findViewById(R.id.jobProgress)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
        }
        android.webkit.CookieManager.getInstance().setAcceptCookie(true)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                if (callback != null && engine.handleFileChooser(callback)) {
                    // Engine auto-supplied the pre-downloaded video — signal the
                    // waiting "upload" step directly, no picker needed.
                    UploadBridge.signal(true)
                    return true
                }
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                UploadBridge.arm()
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "video/*"
                    addCategory(Intent.CATEGORY_OPENABLE)
                }
                return try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(intent, REQ_FILE_PICK)
                    true
                } catch (e: Exception) {
                    filePathCallback = null
                    UploadBridge.signal(false)
                    false
                }
            }
        }

        runNextJob()
    }

    private fun runNextJob() {
        statusText.text = "Job le rahe hain…"
        progress.visibility = View.VISIBLE
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val job = claimJob() ?: runOnUiThread {
                    statusText.text = "Koi job nahi hai"
                    progress.visibility = View.GONE
                }.let { return@launch }

                runOnUiThread { statusText.text = "Job chal raha hai: ${job.optString("type")}" }
                try {
                    val out = engine.run(job, webView)
                    reportJob(job.getString("id"), "done", out)
                    runOnUiThread {
                        statusText.text = "Job ho gaya ✓"
                        progress.visibility = View.GONE
                        Toast.makeText(this@JobRunnerActivity, "Job complete ✓", Toast.LENGTH_SHORT).show()
                    }
                } catch (e: Exception) {
                    // needs_foreground = job is still valid, just needs the app
                    // open — requeue it (server accepts status "requeue") instead
                    // of losing it as "failed", mirroring PollWorker.
                    val needsFg = e is JobEngine.JobFailed &&
                        (e.message ?: "").startsWith("needs_foreground")
                    val status = when {
                        e is JobEngine.JobCancelled -> "cancelled"
                        needsFg -> "requeue"
                        else -> "failed"
                    }
                    reportJob(job.getString("id"), status,
                        JSONObject().put("error", e.message ?: "unknown"))
                    if (needsFg) Log.w("JobRunner", "job requeued: ${e.message}")
                    runOnUiThread {
                        statusText.text = when {
                            e is JobEngine.JobCancelled -> "Job cancel ho gaya"
                            needsFg -> "Job queue me wapas ✓"
                            else -> "Job fail: ${e.message}"
                        }
                        progress.visibility = View.GONE
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    statusText.text = "Error: ${e.message}"
                    progress.visibility = View.GONE
                }
            }
        }
    }

    private fun claimJob(): JSONObject? {
        val deviceId = SessionManager.deviceId(this)
        val appV = SessionManager.appVersionCode(this)
        val model = java.net.URLEncoder.encode(
            "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}", "UTF-8")
        val url = "${SessionManager.serverUrl(this)}/api/jobs/next" +
            "?device_id=$deviceId&app_version=$appV&device_model=$model"
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20000; readTimeout = 20000
        }
        return try {
            if (conn.responseCode == 204) null
            else JSONObject(conn.inputStream.bufferedReader().readText()).optJSONObject("job")
        } finally { conn.disconnect() }
    }

    private fun reportJob(id: String, status: String, result: JSONObject) {
        val url = "${SessionManager.serverUrl(this)}/api/jobs/$id"
        val body = JSONObject().put("status", status).put("result", result)
            .put("device_id", SessionManager.deviceId(this))
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Content-Type", "application/json")
            connectTimeout = 20000; readTimeout = 20000
            doOutput = true
        }
        try {
            conn.outputStream.bufferedWriter().use { it.write(body.toString()) }
            conn.responseCode
        } finally { conn.disconnect() }
    }

    override fun onDestroy() {
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        webView.destroy()
        super.onDestroy()
    }
}
