package com.whopclip.agent

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.util.Log
import android.webkit.CookieManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * Holds the device identity + server URL, and uploads extracted
 * login sessions (cookies) to the server exactly once per service.
 */
object SessionManager {
    private const val TAG = "SessionManager"
    private const val PREFS = "whopclip"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_WHOP_DONE = "whop_done"
    private const val KEY_IG_DONE = "ig_done"
    private const val KEY_PAIRED = "paired"

    // Deployed production server (Vercel). Override-able from the app's server field.
    private const val DEFAULT_SERVER_URL = "https://whopclip.vercel.app"

    /**
     * APK's real versionCode from PackageManager (build-apk.sh generates no
     * BuildConfig.java, so this is read at runtime). Sent as app_version on
     * pairing + job claims so the dashboard shows the running build.
     */
    @Suppress("DEPRECATION")
    fun appVersionCode(ctx: Context): String = try {
        val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode.toString()
        else pi.versionCode.toString()
    } catch (_: Exception) { "3" }

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun deviceId(ctx: Context): String {
        val p = prefs(ctx)
        var id = p.getString(KEY_DEVICE_ID, null)
        if (id == null) {
            id = UUID.randomUUID().toString()
            p.edit().putString(KEY_DEVICE_ID, id).apply()
        }
        return id
    }

    fun serverUrl(ctx: Context): String =
        prefs(ctx).getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL

    fun setServerUrl(ctx: Context, url: String) {
        prefs(ctx).edit().putString(KEY_SERVER_URL, url.trimEnd('/')).apply()
    }

    fun isWhopLinked(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_WHOP_DONE, false)
    fun isIgLinked(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_IG_DONE, false)
    fun isPaired(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_PAIRED, false)

    private const val KEY_ONLINE = "online"

    /** Local online/offline flag — automation only polls while true.
     *  Default true: a paired device polls unless the user explicitly
     *  tapped Offline. (Fix 2026-09-26: default false meant a fresh pair
     *  never polled in background until the user found the Online button.) */
    fun isOnline(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_ONLINE, true)
    fun setOnline(ctx: Context, online: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_ONLINE, online).apply()
    }

    /** Full unpair: clears pairing, sessions, online flag. Device must re-pair. */
    fun unpair(ctx: Context) {
        prefs(ctx).edit()
            .putBoolean(KEY_PAIRED, false)
            .putBoolean(KEY_ONLINE, false)
            .putBoolean(KEY_WHOP_DONE, false)
            .putBoolean(KEY_IG_DONE, false)
            .putString(KEY_DEVICE_ID, null)
            .apply()
        // Fresh device identity on next pair.
        deviceId(ctx)
    }

    /**
     * Claims a website-generated pairing code (POST /api/pair action=claim).
     * Links this phone to the owner's dashboard permanently.
     */
    suspend fun pairDevice(ctx: Context, code: String): Boolean =
        withContext(Dispatchers.IO) {
            try {
                // Normalize: uppercase, drop dashes/spaces — "abcd-1234",
                // "abcd1234" and "abcd 1234" must all work.
                val clean = code.trim().uppercase().replace(Regex("[^A-Z0-9]"), "")
                if (clean.isEmpty()) return@withContext false
                val body = JSONObject().apply {
                    put("action", "claim")
                    put("code", clean)
                    put("device_id", deviceId(ctx))
                    put("app_version", appVersionCode(ctx))
                    put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}")
                }
                val conn = (URL("${serverUrl(ctx)}/api/pair").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    setRequestProperty("Content-Type", "application/json")
                    connectTimeout = 20000
                    readTimeout = 20000
                    doOutput = true
                }
                OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }
                val httpCode = conn.responseCode
                // Surface the server's real error (expired vs invalid vs network)
                // so failures are diagnosable instead of a generic toast.
                val errBody = try {
                    (if (httpCode in 200..299) conn.inputStream else conn.errorStream)
                        ?.bufferedReader()?.readText()?.take(200) ?: ""
                } catch (_: Exception) { "" }
                conn.disconnect()
                val ok = httpCode in 200..299
                if (ok) {
                    prefs(ctx).edit().putBoolean(KEY_PAIRED, true).apply()
                    Log.i(TAG, "device paired with code $clean")
                } else {
                    Log.w(TAG, "pair failed: HTTP $httpCode body=$errBody")
                    lastPairError = when {
                        httpCode == 404 -> {
                            val expired = errBody.contains("expir", ignoreCase = true)
                            if (expired) "Code expire ho gaya — website se naya code banao"
                            else "Galat code — website /connect wala code exactly dalo"
                        }
                        httpCode in 500..599 -> {
                            // Server-side problem (not the phone's network).
                            // The kv-upsert 409 class of bugs lives here.
                            "Server me dikkat hai ($httpCode) — net ka issue nahi, thodi der me dobara try karo"
                        }
                        else -> {
                            val detail = errBody.ifBlank { "code $httpCode" }
                            "Pair nahi hua ($detail) — code dobara check karo"
                        }
                    }
                }
                ok
            } catch (e: Exception) {
                Log.e(TAG, "pairDevice failed", e)
                lastPairError = "Network fail — server tak pahunch nahi paya"
                false
            }
        }

    /** Last human-readable pairing failure, shown in the UI toast. */
    @Volatile
    var lastPairError: String = ""

    /** Truthful result of a session upload — the UI shows exactly what happened. */
    sealed class UploadResult {
        data object Success : UploadResult()
        /** No cookies found for the domain (user not logged in here, or WebView hasn't synced yet). */
        data object NoCookies : UploadResult()
        /** Server rejected the upload (HTTP code). */
        data class ServerError(val code: Int) : UploadResult()
        /** Phone couldn't reach the server at all. */
        data object NetworkError : UploadResult()
    }

    /**
     * Definitive login check from the cookie jar (not URL heuristics):
     * Instagram sets `sessionid` only when actually logged in.
     * For Whop we check known auth cookie names, falling back to a
     * heuristic (several cookies present + not on a login page).
     */
    fun isLoggedInByCookies(service: String, cookies: Map<String, String>, url: String): Boolean {
        if (service == "instagram") return cookies.containsKey("sessionid")
        if (service == "whop") {
            val names = cookies.keys.map { it.lowercase() }.toSet()
            val known = listOf(
                "__secure-next-auth.session-token", "next-auth.session-token",
                "__secure-authjs.session-token", "authjs.session-token",
                "whop_session", "whop-session", "session", "__session"
            )
            if (known.any { it in names }) return true
            val onAuthPage = url.contains("/login") || url.contains("/signup") ||
                    url.contains("/sign-in") || url.contains("/auth")
            // Best effort: a logged-in Whop page carries several cookies.
            return !onAuthPage && cookies.size >= 3
        }
        return false
    }

    /** Read cookies for [url], flushing the store first and retrying once. */
    fun readCookies(url: String): Map<String, String> {
        val cm = CookieManager.getInstance()
        // Force any pending Set-Cookie writes into the store before reading.
        try { cm.flush() } catch (_: Exception) { }
        fun parse(raw: String?): Map<String, String> {
            if (raw.isNullOrBlank()) return emptyMap()
            return raw.split(";").mapNotNull {
                val kv = it.trim().split("=", limit = 2)
                if (kv.size == 2 && kv[0].isNotEmpty()) kv[0] to kv[1] else null
            }.toMap()
        }
        var cookies = parse(try { cm.getCookie(url) } catch (_: Exception) { null })
        if (cookies.isEmpty()) {
            // Cookies can land just after page load (XHR-set). One short retry.
            try { Thread.sleep(1500) } catch (_: InterruptedException) { }
            try { cm.flush() } catch (_: Exception) { }
            cookies = parse(try { cm.getCookie(url) } catch (_: Exception) { null })
            // Last resort: try the bare host root (some cookies are path-scoped oddly).
            if (cookies.isEmpty()) {
                try {
                    val host = URL(url).host
                    if (host.isNotEmpty()) cookies = parse(cm.getCookie("https://$host/"))
                } catch (_: Exception) { }
            }
        }
        Log.i(TAG, "readCookies: ${cookies.size} cookies for ${try { URL(url).host } catch (_: Exception) { url }}")
        return cookies
    }

    /**
     * Pull cookies for [url] out of the WebView cookie store and POST them
     * to the server as this device's session for [service] ("whop"|"instagram").
     * Returns a truthful [UploadResult] so the UI can say exactly what happened
     * instead of guessing "login nahi hua".
     *
     * @param account best-effort username/handle (extracted from the page via JS
     * by the caller); "" when unknown.
     */
    suspend fun uploadSession(
        ctx: Context,
        service: String,
        url: String,
        account: String = ""
    ): UploadResult = withContext(Dispatchers.IO) {
        val cookies = readCookies(url)
        if (cookies.isEmpty()) {
            Log.w(TAG, "no cookies for $service at $url")
            return@withContext UploadResult.NoCookies
        }
        try {
            // v20: per-cookie capture domain so the server dashboard can show
            // cookies category-wise (whop.com vs contentrewards.com).
            val host = try { URL(url).host } catch (_: Exception) { "" }
            val domains = cookies.keys.associateWith { host }
            val body = JSONObject().apply {
                put("device_id", deviceId(ctx))
                put("service", service)
                put("cookies", JSONObject(cookies as Map<*, *>))
                put("domains", JSONObject(domains as Map<*, *>))
                put("account", account)
                put("user_agent", System.getProperty("http.agent") ?: "WhopClip/1.0")
                put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}")
            }

            val conn = (URL("${serverUrl(ctx)}/api/sessions").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                connectTimeout = 20000
                readTimeout = 20000
                doOutput = true
            }
            OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }
            val code = conn.responseCode
            conn.disconnect()
            if (code in 200..299) {
                prefs(ctx).edit()
                    .putBoolean(if (service == "whop") KEY_WHOP_DONE else KEY_IG_DONE, true)
                    .apply()
                Log.i(TAG, "$service session uploaded (${cookies.size} cookies, account='$account')")
                UploadResult.Success
            } else {
                Log.w(TAG, "session upload failed: HTTP $code")
                UploadResult.ServerError(code)
            }
        } catch (e: Exception) {
            Log.e(TAG, "uploadSession failed", e)
            UploadResult.NetworkError
        }
    }
}
