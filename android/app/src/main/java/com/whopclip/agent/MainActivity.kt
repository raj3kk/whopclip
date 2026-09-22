package com.whopclip.agent

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * v9: 3-tab app — Browser | Live | Profile.
 *
 * BROWSER tab: full in-app browser (search bar + Google search + any URL).
 * User logs in to Whop / Instagram here; WebView cookies persist on the
 * device. "Session save" uploads the current site's cookies to the server
 * so the server can act logged-in. Quick buttons jump to Whop / Instagram.
 *
 * LIVE tab: automation tracking — current job + step, and run history.
 *
 * PROFILE tab: pairing gate. Until the phone is paired with the server,
 * a permanent connect prompt is shown. After pairing, the tab mirrors what
 * the website shows for this device (online/offline state, sessions,
 * earnings), with real Online / Offline / Disconnect buttons.
 *
 * Root fix vs v8: LoginActivity (AppCompat) crashed on launch on some
 * devices (tap → instant back-out). v9 converts it to platform Activity,
 * and the browser tab replaces the separate login screen entirely.
 */
class MainActivity : Activity() {

    companion object {
        private const val REQ_NOTIFICATIONS = 1001
        private const val WHOP_URL = "https://whop.com/"
        private const val IG_URL = "https://www.instagram.com/"
        private const val GOOGLE_SEARCH = "https://www.google.com/search?q="
    }

    private lateinit var tabBrowser: LinearLayout
    private lateinit var tabLive: ScrollView
    private lateinit var tabProfile: ScrollView

    // Browser tab
    private lateinit var browserWebView: WebView
    private lateinit var browserUrlBar: EditText
    private lateinit var browserProgress: ProgressBar

    // Live tab
    private lateinit var liveStatusText: TextView
    private lateinit var liveJobText: TextView
    private lateinit var liveHistoryText: TextView

    // Profile tab
    private lateinit var profileConnText: TextView
    private lateinit var profileServerText: TextView
    private lateinit var connectBox: LinearLayout
    private lateinit var onlineBox: LinearLayout
    private lateinit var pairInput: EditText
    private lateinit var versionText: TextView
    private lateinit var serverInput: EditText

    private var connectDialogShown = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tabBrowser = findViewById(R.id.tabBrowser)
        tabLive = findViewById(R.id.tabLive)
        tabProfile = findViewById(R.id.tabProfile)

        setupBrowserTab()
        setupLiveTab()
        setupProfileTab()

        findViewById<Button>(R.id.tabBtnBrowser).setOnClickListener { showTab(0) }
        findViewById<Button>(R.id.tabBtnLive).setOnClickListener { showTab(1) }
        findViewById<Button>(R.id.tabBtnProfile).setOnClickListener { showTab(2) }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
        }

        showTab(2) // start on Profile so pairing state is obvious
        refreshProfile()
    }

    override fun onResume() {
        super.onResume()
        refreshProfile()
        if (tabLive.visibility == View.VISIBLE) refreshLive()
        // Permanent connect prompt until paired.
        if (!SessionManager.isPaired(this) && !connectDialogShown) {
            connectDialogShown = true
            showConnectDialog()
        }
    }

    private fun showTab(idx: Int) {
        tabBrowser.visibility = if (idx == 0) View.VISIBLE else View.GONE
        tabLive.visibility = if (idx == 1) View.VISIBLE else View.GONE
        tabProfile.visibility = if (idx == 2) View.VISIBLE else View.GONE
        if (idx == 1) refreshLive()
        if (idx == 2) refreshProfile()
    }

    // ================= BROWSER TAB =================

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupBrowserTab() {
        browserWebView = findViewById(R.id.browserWebView)
        browserUrlBar = findViewById(R.id.browserUrlBar)
        browserProgress = findViewById(R.id.browserProgress)

        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        cm.setAcceptThirdPartyCookies(browserWebView, true)

        browserWebView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = userAgentString.replace("; wv", "")
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        browserWebView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                browserProgress.visibility = View.VISIBLE
                browserProgress.progress = newProgress
                if (newProgress >= 100) browserProgress.visibility = View.GONE
            }
        }
        browserWebView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                browserUrlBar.setText(url ?: "")
            }
            override fun onPageFinished(view: WebView?, url: String?) {
                browserUrlBar.setText(url ?: "")
                autoDetectSession(url)
            }
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false
        }

        val go: () -> Unit = {
            val q = browserUrlBar.text.toString().trim()
            if (q.isNotEmpty()) browserWebView.loadUrl(toUrl(q))
        }
        findViewById<Button>(R.id.browserGoBtn).setOnClickListener { go() }
        browserUrlBar.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) { go(); true } else false
        }
        findViewById<Button>(R.id.browserBackBtn).setOnClickListener {
            if (browserWebView.canGoBack()) browserWebView.goBack()
        }
        findViewById<Button>(R.id.browserFwdBtn).setOnClickListener {
            if (browserWebView.canGoForward()) browserWebView.goForward()
        }
        findViewById<Button>(R.id.quickWhopBtn).setOnClickListener {
            browserWebView.loadUrl(WHOP_URL)
        }
        findViewById<Button>(R.id.quickIgBtn).setOnClickListener {
            browserWebView.loadUrl(IG_URL)
        }
        findViewById<Button>(R.id.saveSessionBtn).setOnClickListener {
            saveCurrentSession()
        }

        browserWebView.loadUrl(GOOGLE_SEARCH + "whop+content+rewards")
    }

    private fun toUrl(q: String): String {
        if (q.startsWith("http://") || q.startsWith("https://")) return q
        if (q.contains(".") && !q.contains(" ")) return "https://$q"
        return GOOGLE_SEARCH + q.replace(" ", "+")
    }

    /** Auto-detect login: when the user lands logged-in, upload session once. */
    private fun autoDetectSession(url: String?) {
        if (url == null) return
        val host = try { URL(url).host } catch (_: Exception) { return }
        val service = when {
            host.endsWith("whop.com") && !url.contains("/login") && !url.contains("/signup") -> "whop"
            host.endsWith("instagram.com") && !url.contains("/accounts/login") -> "instagram"
            else -> return
        }
        val done = if (service == "whop") SessionManager.isWhopLinked(this)
                   else SessionManager.isIgLinked(this)
        if (done) return
        CoroutineScope(Dispatchers.Main).launch {
            val ok = SessionManager.uploadSession(this@MainActivity, service, url)
            if (ok) {
                Toast.makeText(this@MainActivity,
                    "$service login save ho gaya ✓ — server ab is session se kaam karega",
                    Toast.LENGTH_LONG).show()
                refreshProfile()
            }
        }
    }

    private fun saveCurrentSession() {
        val url = browserWebView.url ?: run {
            Toast.makeText(this, "Pehle koi site kholo", Toast.LENGTH_SHORT).show()
            return
        }
        val host = try { URL(url).host } catch (_: Exception) { "" }
        val service = when {
            host.endsWith("whop.com") -> "whop"
            host.endsWith("instagram.com") -> "instagram"
            else -> {
                Toast.makeText(this, "Ye site Whop/Instagram nahi hai", Toast.LENGTH_SHORT).show()
                return
            }
        }
        CoroutineScope(Dispatchers.Main).launch {
            Toast.makeText(this@MainActivity, "Session save ho raha hai…", Toast.LENGTH_SHORT).show()
            val ok = SessionManager.uploadSession(this@MainActivity, service, url)
            Toast.makeText(this@MainActivity,
                if (ok) "$service session server pe save ✓"
                else "Cookies nahi mile — pehle login poora karo",
                Toast.LENGTH_LONG).show()
            refreshProfile()
        }
    }

    // ================= LIVE TAB =================

    private fun setupLiveTab() {
        liveStatusText = findViewById(R.id.liveStatusText)
        liveJobText = findViewById(R.id.liveJobText)
        liveHistoryText = findViewById(R.id.liveHistoryText)
        findViewById<Button>(R.id.liveRefreshBtn).setOnClickListener { refreshLive() }
    }

    private fun refreshLive() {
        val online = SessionManager.isOnline(this)
        val paired = SessionManager.isPaired(this)
        liveStatusText.text = when {
            !paired -> "Status: not connected"
            online -> "Status: ● ONLINE — automation chal raha hai"
            else -> "Status: ○ OFFLINE — automation ruka hai"
        }
        // Current job from JobEngine's in-memory tracker, else server.
        val cur = JobEngine.currentJobInfo()
        liveJobText.text = cur ?: "Koi job nahi chal raha"
        CoroutineScope(Dispatchers.Main).launch {
            val hist = fetchHistory()
            liveHistoryText.text = hist
        }
    }

    private suspend fun fetchHistory(): String = withContext(Dispatchers.IO) {
        try {
            val deviceId = SessionManager.deviceId(this@MainActivity)
            val url = "${SessionManager.serverUrl(this@MainActivity)}/api/devices/jobs/history?device_id=$deviceId"
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15000
                readTimeout = 15000
            }
            val code = conn.responseCode
            val body = conn.inputStream.bufferedReader().readText()
            conn.disconnect()
            if (code !in 200..299) return@withContext "History load nahi hui ($code)"
            val arr = JSONObject(body).optJSONArray("jobs") ?: return@withContext "Koi history nahi"
            if (arr.length() == 0) return@withContext "Koi history nahi"
            val sb = StringBuilder()
            for (i in 0 until minOf(arr.length(), 10)) {
                val j = arr.getJSONObject(i)
                sb.append("• ${j.optString("type")} — ${j.optString("status")}")
                val step = j.optString("current_step")
                if (step.isNotEmpty()) sb.append(" ($step)")
                sb.append("\n")
            }
            sb.toString()
        } catch (e: Exception) {
            "History load fail: ${e.message}"
        }
    }

    // ================= PROFILE TAB =================

    private fun setupProfileTab() {
        profileConnText = findViewById(R.id.profileConnText)
        profileServerText = findViewById(R.id.profileServerText)
        connectBox = findViewById(R.id.connectBox)
        onlineBox = findViewById(R.id.onlineBox)
        pairInput = findViewById(R.id.pairInput)
        versionText = findViewById(R.id.versionText)
        serverInput = findViewById(R.id.serverInput)
        serverInput.setText(SessionManager.serverUrl(this))

        findViewById<Button>(R.id.saveServerBtn).setOnClickListener {
            val u = serverInput.text.toString().trim()
            if (u.isNotEmpty()) {
                SessionManager.setServerUrl(this, u)
                Toast.makeText(this, "Server save ho gaya", Toast.LENGTH_SHORT).show()
                refreshProfile()
            }
        }
        val pairBtn = findViewById<Button>(R.id.pairBtn)
        pairBtn.setOnClickListener {
            val code = pairInput.text.toString().trim()
            if (code.isEmpty()) {
                Toast.makeText(this, "Pairing code daalo (website /connect se)",
                    Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            pairBtn.isEnabled = false
            CoroutineScope(Dispatchers.Main).launch {
                val ok = SessionManager.pairDevice(this@MainActivity, code)
                pairBtn.isEnabled = true
                if (ok) {
                    pairInput.text.clear()
                    Toast.makeText(this@MainActivity, "Phone pair ho gaya ✓",
                        Toast.LENGTH_SHORT).show()
                    refreshProfile()
                } else {
                    val why = SessionManager.lastPairError
                        .ifBlank { "Pair nahi hua — code check karo (30 min expiry)" }
                    Toast.makeText(this@MainActivity, why, Toast.LENGTH_LONG).show()
                }
            }
        }
        findViewById<Button>(R.id.goOnlineBtn).setOnClickListener { setOnline(true) }
        findViewById<Button>(R.id.goOfflineBtn).setOnClickListener { setOnline(false) }
        findViewById<Button>(R.id.disconnectBtn).setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle("Disconnect?")
                .setMessage("Phone server se unpair ho jayega. Automation ruk jayegi.")
                .setPositiveButton("Disconnect") { _, _ -> doDisconnect() }
                .setNegativeButton("Cancel", null)
                .show()
        }
    }

    private fun showConnectDialog() {
        AlertDialog.Builder(this)
            .setTitle("Connect karo")
            .setMessage("Automation ke liye phone ko server se connect karo.\n\nWebsite pe /connect kholo, code banao, aur yahan Profile tab me dalo.")
            .setPositiveButton("Profile kholo") { _, _ -> showTab(2) }
            .setCancelable(false)
            .show()
    }

    private fun refreshProfile() {
        val paired = SessionManager.isPaired(this)
        val online = SessionManager.isOnline(this)
        val whop = if (SessionManager.isWhopLinked(this)) "✓ linked" else "✗ not linked"
        val ig = if (SessionManager.isIgLinked(this)) "✓ linked" else "✗ not linked"

        profileConnText.text = when {
            !paired -> "✗ Not connected"
            online -> "● ONLINE"
            else -> "○ OFFLINE (connected)"
        }
        connectBox.visibility = if (paired) View.GONE else View.VISIBLE
        onlineBox.visibility = if (paired) View.VISIBLE else View.GONE
        versionText.text = "v${appVersionName()} (${SessionManager.appVersionCode(this)})"

        profileServerText.text = "Device: ${SessionManager.deviceId(this).take(8)}…\n" +
                "Whop: $whop\nInstagram: $ig\nServer se sync ho raha hai…"

        // Mirror what the website shows for this device.
        CoroutineScope(Dispatchers.Main).launch {
            val info = fetchDeviceInfo()
            if (info != null) profileServerText.text = info
        }
    }

    private suspend fun fetchDeviceInfo(): String? = withContext(Dispatchers.IO) {
        try {
            val deviceId = SessionManager.deviceId(this@MainActivity)
            val url = "${SessionManager.serverUrl(this@MainActivity)}/api/devices/$deviceId/status"
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15000
                readTimeout = 15000
            }
            val code = conn.responseCode
            val body = conn.inputStream.bufferedReader().readText()
            conn.disconnect()
            if (code !in 200..299) return@withContext null
            val j = JSONObject(body)
            val sb = StringBuilder()
            sb.append("Device: ${deviceId.take(8)}…\n")
            sb.append("Server status: ${j.optString("status", "—")}\n")
            sb.append("Last seen: ${j.optString("last_seen", "—")}\n")
            val earn = j.optString("earnings", "")
            if (earn.isNotEmpty()) sb.append("Earnings: $earn\n")
            val jobs = j.optString("jobs_today", "")
            if (jobs.isNotEmpty()) sb.append("Jobs today: $jobs\n")
            sb.toString()
        } catch (_: Exception) { null }
    }

    /**
     * Real online/offline mechanism: tells the server this device's
     * availability, and starts/stops the local poll worker to match.
     */
    private fun setOnline(online: Boolean) {
        if (!SessionManager.isPaired(this)) {
            Toast.makeText(this, "Pehle pair karo", Toast.LENGTH_SHORT).show()
            return
        }
        if (!SessionManager.isWhopLinked(this) || !SessionManager.isIgLinked(this)) {
            Toast.makeText(this, "Pehle Browser tab me Whop + Instagram login karo",
                Toast.LENGTH_LONG).show()
            return
        }
        CoroutineScope(Dispatchers.Main).launch {
            val serverOk = postPresence(online)
            if (online) {
                if (!WorkHelper.ensure(this@MainActivity)) {
                    Toast.makeText(this@MainActivity,
                        "WorkManager start nahi hua — dobara try karo", Toast.LENGTH_LONG).show()
                    return@launch
                }
                PollService.start(this@MainActivity)
                SessionManager.setOnline(this@MainActivity, true)
                Toast.makeText(this@MainActivity,
                    if (serverOk) "Online ✓ — automation chal raha hai"
                    else "Online (local) — server sync fail, net check karo",
                    Toast.LENGTH_SHORT).show()
            } else {
                PollService.stop(this@MainActivity)
                WorkHelper.cancel(this@MainActivity)
                SessionManager.setOnline(this@MainActivity, false)
                Toast.makeText(this@MainActivity,
                    if (serverOk) "Offline ✓ — automation ruk gaya"
                    else "Offline (local) — server sync fail",
                    Toast.LENGTH_SHORT).show()
            }
            refreshProfile()
            refreshLive()
        }
    }

    private suspend fun postPresence(online: Boolean): Boolean = withContext(Dispatchers.IO) {
        try {
            val body = JSONObject().apply {
                put("device_id", SessionManager.deviceId(this@MainActivity))
                put("online", online)
                put("app_version", SessionManager.appVersionCode(this@MainActivity))
            }
            val conn = (URL("${SessionManager.serverUrl(this@MainActivity)}/api/devices/presence")
                .openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                connectTimeout = 15000
                readTimeout = 15000
                doOutput = true
            }
            OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }
            val code = conn.responseCode
            conn.disconnect()
            code in 200..299
        } catch (_: Exception) { false }
    }

    /** Real disconnect: server unpairs the device, local state wiped, worker stopped. */
    private fun doDisconnect() {
        CoroutineScope(Dispatchers.Main).launch {
            withContext(Dispatchers.IO) {
                try {
                    val body = JSONObject().apply {
                        put("device_id", SessionManager.deviceId(this@MainActivity))
                    }
                    val conn = (URL("${SessionManager.serverUrl(this@MainActivity)}/api/devices/disconnect")
                        .openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"
                        setRequestProperty("Content-Type", "application/json")
                        connectTimeout = 15000
                        readTimeout = 15000
                        doOutput = true
                    }
                    OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }
                    conn.responseCode
                    conn.disconnect()
                } catch (_: Exception) { }
            }
            PollService.stop(this@MainActivity)
            WorkHelper.cancel(this@MainActivity)
            SessionManager.unpair(this@MainActivity)
            connectDialogShown = false
            Toast.makeText(this@MainActivity, "Disconnected — dobara pair karo",
                Toast.LENGTH_LONG).show()
            refreshProfile()
        }
    }

    @Suppress("DEPRECATION")
    private fun appVersionName(): String = try {
        val pi = packageManager.getPackageInfo(packageName, 0)
        pi.versionName ?: "?"
    } catch (_: Exception) { "?" }

    override fun onBackPressed() {
        if (tabBrowser.visibility == View.VISIBLE && browserWebView.canGoBack()) {
            browserWebView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
