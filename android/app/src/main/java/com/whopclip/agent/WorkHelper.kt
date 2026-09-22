package com.whopclip.agent

import android.content.Context
import android.util.Log
import androidx.work.Configuration
import androidx.work.WorkManager

/**
 * Lazy WorkManager access. The Application no longer touches WorkManager at
 * launch (that was the v3–v5 crash suspect). Call [ensure] only from a user
 * action (e.g. "Automation start karo") or from PollService, never from
 * Application.onCreate or Activity.onCreate.
 */
object WorkHelper {
    private const val TAG = "WorkHelper"
    @Volatile private var inited = false

    @Synchronized
    fun ensure(ctx: Context): Boolean {
        if (inited) return true
        return try {
            val appCtx = ctx.applicationContext
            // Manual init (no androidx.startup provider in the manifest).
            androidx.work.impl.WorkManagerImpl::class.java // touch class
            WorkManager.initialize(
                appCtx,
                Configuration.Builder()
                    .setMinimumLoggingLevel(Log.INFO)
                    .build()
            )
            inited = true
            Log.i(TAG, "WorkManager initialized lazily")
            true
        } catch (t: Throwable) {
            Log.e(TAG, "lazy WorkManager init failed", t)
            false
        }
    }

    fun isReady(ctx: Context): Boolean = try {
        WorkManager.getInstance(ctx); true
    } catch (_: Throwable) { false }

    /** Cancels the periodic poll work (offline/disconnect path). */
    fun cancel(ctx: Context) {
        try {
            if (isReady(ctx))
                WorkManager.getInstance(ctx).cancelUniqueWork(PollService.WORK_NAME)
        } catch (_: Throwable) { }
    }
}
