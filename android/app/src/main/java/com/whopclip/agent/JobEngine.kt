package com.whopclip.agent

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume

/**
 * Executes server-sent JSON step specs inside a WebView.
 *
 * Step schema (each step is a JSONObject):
 *   {"action":"goto","url":"https://..."}
 *   {"action":"wait","ms":2000}
 *   {"action":"wait_text","text":"Share","timeout_ms":30000}
 *   {"action":"click_text","text":"Next","timeout_ms":15000}
 *   {"action":"type","selector":"textarea","text":"caption..."}
 *   {"action":"js","code":"...return document.title;"}
 *   {"action":"upload","selector":"input[type=file]","file":"/path/on/device"}
 *   {"action":"extract","key":"post_url","code":"...return location.href;"}
 *
 * Returns JSONObject of extracted values on success, or throws JobFailed.
 */
class JobEngine(private val ctx: Context) {
    private val TAG = "JobEngine"

    class JobFailed(msg: String) : Exception(msg)

    @Volatile private var lastJsResult: String? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    private inner class JsBridge {
        @JavascriptInterface
        fun onResult(value: String) {
            lastJsResult = value
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    private fun makeWebView(onPageDone: (String?) -> Unit): WebView {
        val wv = WebView(ctx)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.mediaPlaybackRequiresUserGesture = false
        android.webkit.CookieManager.getInstance().setAcceptCookie(true)
        android.webkit.CookieManager.getInstance()
            .setAcceptThirdPartyCookies(wv, true)
        wv.addJavascriptInterface(JsBridge(), "WhopClip")
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                onPageDone(url)
            }
        }
        return wv
    }

    private suspend fun evalJs(wv: WebView, code: String, timeoutMs: Long = 20000): String =
        withTimeoutOrNull(timeoutMs) {
            suspendCancellableCoroutine { cont ->
                lastJsResult = null
                mainHandler.post {
                    wv.evaluateJavascript("(function(){try{var r=($code);WhopClip.onResult(JSON.stringify(r));}catch(e){WhopClip.onResult(JSON.stringify({__err:String(e)}));}})()") {}
                }
                // poll for the bridge callback
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

    /** Runs all steps; returns extracted values. Must be called off the main thread. */
    suspend fun run(job: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val extracted = JSONObject()
        val steps: JSONArray = job.optJSONArray("steps") ?: JSONArray()
        var wvRef: WebView? = null
        val pageLatch = java.util.concurrent.CountDownLatch(1)
        var lastUrl: String? = null

        suspendCancellableCoroutine<Unit> { cont ->
            mainHandler.post {
                wvRef = makeWebView { url -> lastUrl = url; pageLatch.countDown() }
                cont.resume(Unit)
            }
        }
        val wv = wvRef ?: throw JobFailed("webview init failed")

        try {
            for (i in 0 until steps.length()) {
                val s = steps.getJSONObject(i)
                when (s.optString("action")) {
                    "goto" -> {
                        val url = s.getString("url")
                        pageLatch.let { /* reset */ }
                        val latch = java.util.concurrent.CountDownLatch(1)
                        mainHandler.post {
                            wv.webViewClient = object : WebViewClient() {
                                override fun onPageFinished(view: WebView?, u: String?) { latch.countDown() }
                            }
                            wv.loadUrl(url)
                        }
                        if (!latch.await(45, java.util.concurrent.TimeUnit.SECONDS))
                            throw JobFailed("goto timeout: $url")
                        kotlinx.coroutines.delay(1500)
                    }
                    "wait" -> kotlinx.coroutines.delay(s.optLong("ms", 2000))
                    "wait_text" -> {
                        val t = s.getString("text").replace("'", "\\'")
                        waitFor(wv, "document.body && document.body.innerText.includes('$t')",
                            s.optLong("timeout_ms", 30000), "text:$t")
                    }
                    "click_text" -> {
                        val t = s.getString("text").replace("'", "\\'")
                        val timeout = s.optLong("timeout_ms", 15000)
                        val clicked = withTimeoutOrNull(timeout) {
                            while (true) {
                                val r = evalJs(wv, """
                                    (function(){
                                      var els=[...document.querySelectorAll('button,a,[role=button]')];
                                      for(var e of els){ if((e.innerText||'').trim().toLowerCase()==='${t.lowercase()}'){e.click();return true;} }
                                      return false;
                                    })()
                                """.trimIndent(), 8000)
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
                        evalJs(wv, """
                            (function(){var el=document.querySelector('$sel');if(!el)return 'no-el';
                            el.focus();document.execCommand('selectAll',false,null);
                            document.execCommand('insertText',false,'$text');
                            el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()
                        """.trimIndent())
                        kotlinx.coroutines.delay(1000)
                    }
                    "js" -> evalJs(wv, s.getString("code"))
                    "extract" -> {
                        val key = s.getString("key")
                        val r = evalJs(wv, s.getString("code"))
                        extracted.put(key, r.trim('"'))
                    }
                    "upload" -> {
                        // NOTE: file picking needs a WebChromeClient onShowFileChooser
                        // wired to an activity result. v1: server sends the file path and
                        // the engine injects via hidden input when the page allows it.
                        Log.w(TAG, "upload step: needs activity file-chooser wiring (v1 TODO)")
                        throw JobFailed("upload step not wired in v1 — needs onShowFileChooser")
                    }
                    else -> throw JobFailed("unknown action: ${s.optString("action")}")
                }
                Log.i(TAG, "step $i ok: ${s.optString("action")}")
            }
        } finally {
            mainHandler.post { wv.destroy() }
        }
        extracted
    }
}
