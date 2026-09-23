package com.whopclip.agent

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * v20: automatic cookie sync — no manual "Session save" tap needed.
 *
 * Every minute the [CookieSyncService] calls [syncAll], which pulls the
 * WebView cookie jar for Instagram / Whop / Content Rewards and uploads
 * each service's session to the server. Merge semantics on the server keep
 * whop.com + contentrewards.com cookies coexisting in one jar.
 *
 * "Only valid cookies sync": cookies with empty values are dropped, and a
 * source with zero cookies is skipped silently (no upload, server keeps the
 * last good jar — a logged-out page never wipes a good session).
 */
object CookieSync {
    private const val TAG = "CookieSync"

    private data class Source(val service: String, val url: String)

    private val SOURCES = listOf(
        Source("instagram", "https://www.instagram.com/"),
        Source("whop", "https://whop.com/"),
        Source("whop", "https://contentrewards.com/"),
    )

    /** Sync every source. Returns per-source cookie counts that were uploaded. */
    suspend fun syncAll(ctx: Context): Map<String, Int> = withContext(Dispatchers.IO) {
        val out = mutableMapOf<String, Int>()
        for (src in SOURCES) {
            try {
                // Valid-only: readCookies already skips blanks; double-check here.
                val cookies = SessionManager.readCookies(src.url)
                    .filterValues { it.isNotBlank() }
                if (cookies.isEmpty()) {
                    Log.d(TAG, "skip ${src.url}: no cookies")
                    continue
                }
                // Reuse uploadSession's truthful result; it now also sends the
                // capture domain so the server can categorize cookies.
                when (SessionManager.uploadSession(ctx, src.service, src.url)) {
                    is SessionManager.UploadResult.Success -> {
                        out[src.url] = cookies.size
                        Log.i(TAG, "synced ${cookies.size} cookies for ${src.url}")
                    }
                    else -> Log.w(TAG, "sync failed for ${src.url}")
                }
            } catch (e: Exception) {
                Log.w(TAG, "syncAll error for ${src.url}", e)
            }
        }
        out
    }
}
