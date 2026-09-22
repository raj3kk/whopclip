package com.whopclip.agent

import android.app.Application
import androidx.work.Configuration
import androidx.work.WorkManager

/**
 * Manual WorkManager init (we don't use androidx.startup's InitializationProvider,
 * so the manifest stays minimal and deterministic).
 */
class WhopClipApp : Application(), Configuration.Provider {
    override val workManagerConfiguration: Configuration =
        Configuration.Builder()
            .setMinimumLoggingLevel(android.util.Log.INFO)
            .build()

    override fun onCreate() {
        super.onCreate()
        // Trigger init early so PollWorker can be enqueued from any activity.
        WorkManager.getInstance(this)
    }
}
