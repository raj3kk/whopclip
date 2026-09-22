package com.whopclip.agent

import android.app.Application
import android.util.Log
import androidx.work.Configuration
import androidx.work.WorkManager

/**
 * Manual WorkManager init (we don't use androidx.startup's InitializationProvider,
 * so the manifest stays minimal and deterministic).
 *
 * Hardening (v5): WorkManager init must NEVER kill the app at launch. If the
 * init throws on some device, we stash the error (shown in MainActivity status)
 * and let the app open so the user can still pair / see diagnostics.
 */
class WhopClipApp : Application(), Configuration.Provider {
    companion object {
        private const val TAG = "WhopClipApp"
        @Volatile var workInitError: String? = null
            private set
    }

    override val workManagerConfiguration: Configuration =
        Configuration.Builder()
            .setMinimumLoggingLevel(android.util.Log.INFO)
            .build()

    override fun onCreate() {
        super.onCreate()
        // Trigger init early so PollWorker can be enqueued from any activity.
        // Wrapped: a WorkManager init failure must not crash the launch.
        try {
            WorkManager.getInstance(this)
        } catch (t: Throwable) {
            workInitError = "${t.javaClass.simpleName}: ${t.message}"
            Log.e(TAG, "WorkManager init failed (non-fatal)", t)
        }
    }
}
