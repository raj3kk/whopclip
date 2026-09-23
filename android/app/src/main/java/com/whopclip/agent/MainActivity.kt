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
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
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
    private lateinit var liveFrameImg: ImageView
    private lateinit var liveHistoryText: TextView
    private var livePoll: Job? = null

    // Profile tab
    private lateinit var profileConnText: TextView
    private lateinit var profileServerText: TextView
    private lateinit var loginDetailsText: TextView
    private lateinit var connectBox: LinearLayout
    private lateinit var onlineBox: LinearLayout
    private lateinit var pairInput: EditText
    private lateinit var versionText: TextView
    private lateinit var serverInput: EditText

    /** Latest server-side session details, for the tap-to-view dialog. */
    private var lastSessionDetails: String = ""

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
        // AutoClip-style auto-start: agar user ne automation ON chhoda tha
        // (paired + online + logins), to app khulne pe background automation
        // khud shuru ho jaye — dobara Online dabane ka wait nahi.
        // Offline choice ka poora samman: saved offline = kuch shuru nahi.
        autoStartAutomationIfOnline()
    }

    /**
     * AutoClip behavior (startAutomationIfAllowed): app launch pe saved
     * ONLINE state mili to automation apne aap background me shuru —
     * foreground service + turant worker run + periodic backbone.
     * Bilkul silent nahi: user ko toast se pata chalta hai.
     */
    private fun autoStartAutomationIfOnline() {
        if (!SessionManager.isPaired(this) || !SessionManager.isOnline(this)) return
        if (!SessionManager.isWhopLinked(this) || !SessionManager.isIgLinked(this)) return
        CoroutineScope(Dispatchers.IO).launch {
            val ok = PollService.startAutomation(this@MainActivity)
            android.util.Log.i("MainActivity", "launch auto-start automation: $ok")
            if (ok) postPresence(true) // server ko batao device online hai
            withContext(Dispatchers.Main) {
                if (ok) Toast.makeText(this@MainActivity,
                    "Background automation auto-start ho gaya ✓",
                    Toast.LENGTH_SHORT).show()
                else {
                    val why = WorkHelper.lastError.ifBlank { "unknown error" }
                    Toast.makeText(this@MainActivity,
                        "Auto-start fail: $why", Toast.LENGTH_LONG).show()
                }
                refreshProfile()
                refreshLive()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshProfile()
        if (tabLive.visibility == View.VISIBLE) { refreshLive(); startLivePoll() }
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
        if (idx == 1) { refreshLive(); startLivePoll() } else { stopLivePoll() }
        if (idx == 2) refreshProfile()
    }

    override fun onPause() {
        super.onPause()
        stopLivePoll()
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

    /** Auto-detect login: when the user lands logged-in, upload session once.
     * Uses the actual cookie jar (sessionid etc.), not URL guesses — and
     * re-checks shortly after page load since cookies can land via XHR. */
    private fun autoDetectSession(url: String?) {
        if (url == null) return
        val host = try { URL(url).host } catch (_: Exception) { return }
        val service = when {
            host.endsWith("whop.com") -> "whop"
            host.endsWith("instagram.com") -> "instagram"
            else -> return
        }
        val done = if (service == "whop") SessionManager.isWhopLinked(this)
                   else SessionManager.isIgLinked(this)
        if (done) return
        CoroutineScope(Dispatchers.Main).launch {
            // Small delay: let XHR-set cookies land after page finished.
            kotlinx.coroutines.delay(2500)
            val cookies = SessionManager.readCookies(url)
            if (!SessionManager.isLoggedInByCookies(service, cookies, url)) return@launch
            val account = extractAccount(service)
            when (SessionManager.uploadSession(this@MainActivity, service, url, account)) {
                is SessionManager.UploadResult.Success -> {
                    val who = if (account.isNotEmpty()) " (@$account)" else ""
                    Toast.makeText(this@MainActivity,
                        "$service login auto-save ho gaya$who ✓",
                        Toast.LENGTH_LONG).show()
                    refreshProfile()
                }
                else -> { /* silent — user can tap Session save manually */ }
            }
        }
    }

    /**
     * Best-effort username/handle extraction from the current Browser page.
     * Runs on the UI thread (WebView.evaluateJavascript needs it).
     */
    private suspend fun extractAccount(service: String): String =
        kotlinx.coroutines.suspendCancellableCoroutine { cont ->
            val js = when (service) {
                "instagram" -> """
                    (function(){
                      try {
                        var html = document.documentElement.innerHTML;
                        var m = html.match(/"username"\s*:\s*"([A-Za-z0-9._]{2,30})"/);
                        if (m) return m[1];
                        var link = document.querySelector('a[href^="/"][href$="/"]');
                        return "";
                      } catch(e){ return ""; }
                    })()
                """.trimIndent()
                else -> """
                    (function(){
                      try {
                        var html = document.documentElement.innerHTML;
                        var m = html.match(/"(?:username|handle)"\s*:\s*"([A-Za-z0-9._-]{2,40})"/);
                        if (m) return m[1];
                        return "";
                      } catch(e){ return ""; }
                    })()
                """.trimIndent()
            }
            try {
                browserWebView.evaluateJavascript(js) { raw ->
                    val v = raw?.trim()?.trim('"') ?: ""
                    if (cont.isActive) cont.resume(
                        if (v.isNotEmpty() && v != "null") v else "",
                        onCancellation = null
                    )
                }
            } catch (_: Exception) {
                if (cont.isActive) cont.resume("", onCancellation = null)
            }
            // Safety timeout — never hang the save flow on JS.
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                if (cont.isActive) cont.resume("", onCancellation = null)
            }, 8000)
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
            val account = extractAccount(service)
            val msg = when (val r = SessionManager.uploadSession(this@MainActivity, service, url, account)) {
                is SessionManager.UploadResult.Success -> {
                    val who = if (account.isNotEmpty()) " (@$account)" else ""
                    "$service session server pe save ✓$who"
                }
                is SessionManager.UploadResult.NoCookies -> {
                    val loggedIn = SessionManager.isLoggedInByCookies(service, SessionManager.readCookies(url), url)
                    if (loggedIn) "Cookies mil gaye lekin session adhura hai — page refresh karke dobara try karo"
                    else "Is page pe login nahi dikha — pehle $service me login poora karo, phir save dabao"
                }
                is SessionManager.UploadResult.ServerError ->
                    "Server ne save nahi kiya (HTTP ${r.code}) — thodi der me dobara try karo"
                is SessionManager.UploadResult.NetworkError ->
                    "Server tak pahunch nahi paya — net check karke dobara try karo"
            }
            Toast.makeText(this@MainActivity, msg, Toast.LENGTH_LONG).show()
            refreshProfile()
        }
    }

    // ================= LIVE TAB =================

    private fun setupLiveTab() {
        liveStatusText = findViewById(R.id.liveStatusText)
        liveJobText = findViewById(R.id.liveJobText)
        liveFrameImg = findViewById(R.id.liveFrameImg)
        liveHistoryText = findViewById(R.id.liveHistoryText)
        findViewById<Button>(R.id.liveRefreshBtn).setOnClickListener { refreshLive() }
    }

    /**
     * Live tab auto-refresh: jab tak Live tab khula hai, har 10s me server
     * se latest live frame (phone ki screen ka screenshot) + running job
     * ka step laata hai. Screenshot upar, history neeche — dashboard jaisa.
     */
    private fun startLivePoll() {
        stopLivePoll()
        livePoll = CoroutineScope(Dispatchers.Main).launch {
            while (isActive) {
                fetchLiveFrame()
                delay(10000)
            }
        }
    }

    private fun stopLivePoll() {
        livePoll?.cancel()
        livePoll = null
    }

    private suspend fun fetchLiveFrame() {
        val frameUrl: String
        val runningStep: String?
        val runningType: String?
        try {
            val deviceId = SessionManager.deviceId(this@MainActivity)
            val url = "${SessionManager.serverUrl(this@MainActivity)}/api/devices/$deviceId/live"
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15000
                readTimeout = 15000
            }
            val code = conn.responseCode
            val body = conn.inputStream.bufferedReader().readText()
            conn.disconnect()
            if (code !in 200..299) return
            val root = JSONObject(body)
            val live = root.optJSONObject("live")
            frameUrl = live?.optString("frame_url").orEmpty()
            val running = root.optJSONObject("running_job")
            runningType = running?.optString("type")
            runningStep = running?.optString("current_step")?.takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            return // network fail = purana frame rehne do
        }
        // Server pe running job hai par local tracker khaali (background worker)
        // to step yahan dikhao.
        if (JobEngine.currentJobInfo() == null && runningType != null) {
            liveJobText.text = "Chal raha: $runningType" +
                (if (runningStep != null) " — $runningStep" else "")
        }
        if (frameUrl.isBlank()) return
        val bmp: Bitmap? = withContext(Dispatchers.IO) {
            try {
                val c2 = (URL(frameUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15000
                    readTimeout = 15000
                }
                val b = android.graphics.BitmapFactory.decodeStream(c2.inputStream)
                c2.disconnect()
                b
            } catch (_: Exception) {
                null
            }
        }
        if (bmp != null) {
            liveFrameImg.setImageBitmap(bmp)
            liveFrameImg.visibility = View.VISIBLE
        }
    }

    private fun refreshLive() {
        val online = SessionManager.isOnline(this)
        val paired = SessionManager.isPaired(this)
        // WorkManager diagnostic line: failure kabhi silent nahi.
        val wmLine = when {
            WorkHelper.isReady(this) -> "WorkManager: ready ✓"
            WorkHelper.lastError.isNotBlank() -> "WorkManager: FAILED — ${WorkHelper.lastError}"
            else -> "WorkManager: not started"
        }
        liveStatusText.text = when {
            !paired -> "Status: not connected\n$wmLine"
            online -> "Status: ● ONLINE — automation chal raha hai\n$wmLine"
            else -> "Status: ○ OFFLINE — automation ruka hai\n$wmLine"
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
        loginDetailsText = findViewById(R.id.loginDetailsText)
        connectBox = findViewById(R.id.connectBox)
        onlineBox = findViewById(R.id.onlineBox)
        pairInput = findViewById(R.id.pairInput)
        versionText = findViewById(R.id.versionText)
        serverInput = findViewById(R.id.serverInput)
        serverInput.setText(SessionManager.serverUrl(this))

        // Tappable login-details section: shows full server-side session info.
        loginDetailsText.setOnClickListener {
            val details = lastSessionDetails.ifBlank { "Abhi tak koi login detail server se nahi aaya." }
            AlertDialog.Builder(this)
                .setTitle("🔐 Login details")
                .setMessage(details)
                .setPositiveButton("OK", null)
                .show()
        }

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
        // Server-side login/session details (tappable section).
        CoroutineScope(Dispatchers.Main).launch {
            refreshLoginDetails()
        }
    }

    /** Fetches /api/sessions/status and renders the tappable Login details section. */
    private suspend fun refreshLoginDetails() {
        val summary = fetchSessionStatus()
        if (summary != null) {
            loginDetailsText.text = summary.first
            lastSessionDetails = summary.second
        } else {
            loginDetailsText.text = "🔐 Login details: server se load nahi hua (tap)"
            lastSessionDetails = "Server se session details nahi mil paye — net check karo."
        }
    }

    /**
     * GET /api/sessions/status?device_id=...
     * Returns Pair(summary line, full details for the dialog), or null on failure.
     */
    private suspend fun fetchSessionStatus(): Pair<String, String>? = withContext(Dispatchers.IO) {
        try {
            val deviceId = SessionManager.deviceId(this@MainActivity)
            val url = "${SessionManager.serverUrl(this@MainActivity)}/api/sessions/status?device_id=$deviceId"
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15000
                readTimeout = 15000
            }
            val code = conn.responseCode
            val body = try { conn.inputStream.bufferedReader().readText() } catch (_: Exception) { "" }
            conn.disconnect()
            if (code !in 200..299) return@withContext null
            val services = JSONObject(body).optJSONObject("services") ?: return@withContext null
            val full = StringBuilder()
            val summ = StringBuilder("🔐 Login details (tap karo):\n")
            for (svc in listOf("whop", "instagram")) {
                val s = services.optJSONObject(svc) ?: continue
                val linked = s.optBoolean("linked", false)
                val stale = s.optBoolean("stale", false)
                val account = s.optString("account", "")
                val updated = s.optString("updated_at", "")
                val label = svc.replaceFirstChar { it.uppercase() }
                val state = when {
                    !linked -> "✗ not linked"
                    stale -> "⚠ linked lekin stale (dobara login karo)"
                    else -> "✓ linked"
                }
                summ.append("$label: $state")
                if (account.isNotEmpty()) summ.append(" (@$account)")
                summ.append("\n")
                full.append("$label\n")
                full.append("Status: $state\n")
                if (account.isNotEmpty()) full.append("Account: @$account\n")
                if (updated.isNotEmpty()) full.append("Saved: ${updated.take(16).replace("T", " ")}\n")
                full.append("Server in cookies ko automation ke liye use kar sakta hai.\n\n")
            }
            Pair(summ.toString().trimEnd(), full.toString().trimEnd())
        } catch (_: Exception) { null }
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
     * Real online/offline mechanism: local automation start/stop, saved
     * state, and server presence — is order me taaki saved state hamesha
     * reality bataye. v12: single PollService.startAutomation() entry point
     * (foreground service + turant worker run + periodic backbone), aur
     * failure pe ASLI error toast me — "dobara try karo" wala andhera nahi.
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
            if (online) {
                // Pehle local automation — fail hua to online state save hi
                // nahi hogi (server ko jhoothi online presence nahi).
                val started = withContext(Dispatchers.IO) {
                    PollService.startAutomation(this@MainActivity)
                }
                if (!started) {
                    val why = WorkHelper.lastError.ifBlank { "unknown error" }
                    android.util.Log.e("MainActivity", "automation start failed: $why")
                    Toast.makeText(this@MainActivity,
                        "Automation start nahi hua: $why",
                        Toast.LENGTH_LONG).show()
                    refreshLive()
                    return@launch
                }
                SessionManager.setOnline(this@MainActivity, true)
                val serverOk = postPresence(true)
                Toast.makeText(this@MainActivity,
                    if (serverOk) "Online ✓ — background automation chal raha hai"
                    else "Online ✓ (local) — server sync fail, net check karo",
                    Toast.LENGTH_SHORT).show()
            } else {
                PollService.stop(this@MainActivity)
                WorkHelper.cancel(this@MainActivity)
                SessionManager.setOnline(this@MainActivity, false)
                val serverOk = postPresence(false)
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
