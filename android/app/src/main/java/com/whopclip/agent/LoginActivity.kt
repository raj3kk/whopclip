package com.whopclip.agent

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * One-time login screen. Two tabs — Whop and Instagram — each a full
 * WebView where the user signs in normally. When the page looks like a
 * logged-in landing page, we grab the session cookies and upload them.
 *
 * v9: extends platform Activity (not AppCompatActivity) — the AppCompat
 * base was crashing on launch on some devices (tap Instagram/Whop → instant
 * back-out). Root fix matching MainActivity's v6 conversion.
 */
class LoginActivity : Activity() {

    companion object {
        const val EXTRA_SERVICE = "service" // "whop" or "instagram"
        const val WHOP_LOGIN_URL = "https://whop.com/login/"
        const val IG_LOGIN_URL = "https://www.instagram.com/accounts/login/"
        // Heuristic: these hosts mean "logged in" for each service.
        const val WHOP_OK_HOST = "whop.com"
        const val IG_OK_PATH_HINT = "instagram.com"

        fun intentFor(ctx: Context, service: String): Intent =
            Intent(ctx, LoginActivity::class.java).putExtra(EXTRA_SERVICE, service)
    }

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var statusText: TextView
    private lateinit var doneButton: Button
    private var service: String = "whop"
    private var uploaded = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)

        service = intent.getStringExtra(EXTRA_SERVICE) ?: "whop"
        val startUrl = if (service == "whop") WHOP_LOGIN_URL else IG_LOGIN_URL

        webView = findViewById(R.id.loginWebView)
        progress = findViewById(R.id.loginProgress)
        statusText = findViewById(R.id.loginStatus)
        doneButton = findViewById(R.id.loginDoneButton)

        title = if (service == "whop") "Whop me login karo" else "Instagram me login karo"
        statusText.text = "Login karo, phir Done dabao"

        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        cm.setAcceptThirdPartyCookies(webView, true)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = userAgentString.replace("; wv", "")
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                progress.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                progress.visibility = View.GONE
                maybeAutoDetect(url)
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false
        }
        webView.loadUrl(startUrl)

        doneButton.setOnClickListener { finishLogin() }
    }

    /** Light heuristic: if we are on an authenticated landing page, try upload. */
    private fun maybeAutoDetect(url: String?) {
        if (uploaded || url == null) return
        val looksLoggedIn = when (service) {
            "whop" -> url.contains(WHOP_OK_HOST) &&
                !url.contains("/login") && !url.contains("/signup")
            else -> url.contains(IG_OK_PATH_HINT) &&
                !url.contains("/accounts/login")
        }
        if (looksLoggedIn) {
            statusText.text = "Login detect hua — session save ho raha hai…"
            finishLogin()
        }
    }

    private fun finishLogin() {
        if (uploaded) return
        uploaded = true
        doneButton.isEnabled = false
        statusText.text = "Session save ho raha hai…"
        val url = webView.url ?: if (service == "whop") "https://whop.com/" else "https://www.instagram.com/"
        CoroutineScope(Dispatchers.Main).launch {
            val result = SessionManager.uploadSession(this@LoginActivity, service, url)
            if (result is SessionManager.UploadResult.Success) {
                Toast.makeText(this@LoginActivity, "Login save ho gaya ✓", Toast.LENGTH_SHORT).show()
                setResult(RESULT_OK)
                finish()
            } else {
                uploaded = false
                doneButton.isEnabled = true
                val why = when (result) {
                    is SessionManager.UploadResult.NoCookies ->
                        "Cookies nahi mile — login poora karo, phir Done dabao"
                    is SessionManager.UploadResult.ServerError ->
                        "Server ne save nahi kiya (HTTP ${result.code}) — dobara try karo"
                    else -> "Net/server issue — dobara try karo"
                }
                statusText.text = "Session save nahi hua — $why"
                Toast.makeText(this@LoginActivity, why, Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
