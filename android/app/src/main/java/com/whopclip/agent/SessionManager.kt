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

    // TODO: replace with the real deployed server URL (Vercel).
    private const val DEFAULT_SERVER_URL = "https://whopclip.vercel.app"

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

    /**
     * Claims a website-generated pairing code (POST /api/pair action=claim).
     * Links this phone to the owner's dashboard permanently.
     */
    suspend fun pairDevice(ctx: Context, code: String): Boolean =
        withContext(Dispatchers.IO) {
            try {
                val clean = code.trim().uppercase().replace(" ", "")
                if (clean.isEmpty()) return@withContext false
                val body = JSONObject().apply {
                    put("action", "claim")
                    put("code", clean)
                    put("device_id", deviceId(ctx))
                    put("app_version", "3")
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
                val ok = conn.responseCode in 200..299
                conn.disconnect()
                if (ok) {
                    prefs(ctx).edit().putBoolean(KEY_PAIRED, true).apply()
                    Log.i(TAG, "device paired with code $clean")
                } else {
                    Log.w(TAG, "pair failed: HTTP ${conn.responseCode}")
                }
                ok
            } catch (e: Exception) {
                Log.e(TAG, "pairDevice failed", e)
                false
            }
        }

    /**
     * Pull cookies for [url] out of the WebView cookie store and POST them
     * to the server as this device's session for [service] ("whop"|"instagram").
     * Returns true when the server acknowledged the session.
     */
    suspend fun uploadSession(ctx: Context, service: String, url: String): Boolean =
        withContext(Dispatchers.IO) {
            try {
                val raw = CookieManager.getInstance().getCookie(url) ?: ""
                if (raw.isBlank()) {
                    Log.w(TAG, "no cookies for $service at $url")
                    return@withContext false
                }
                val cookies = raw.split(";").mapNotNull {
                    val kv = it.trim().split("=", limit = 2)
                    if (kv.size == 2) kv[0] to kv[1] else null
                }.toMap()

                val body = JSONObject().apply {
                    put("device_id", deviceId(ctx))
                    put("service", service)
                    put("cookies", JSONObject(cookies as Map<*, *>))
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
                    Log.i(TAG, "$service session uploaded")
                    true
                } else {
                    Log.w(TAG, "session upload failed: HTTP $code")
                    false
                }
            } catch (e: Exception) {
                Log.e(TAG, "uploadSession failed", e)
                false
            }
        }
}
