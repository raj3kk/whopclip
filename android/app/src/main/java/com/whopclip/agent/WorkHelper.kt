package com.whopclip.agent

import android.content.Context
import android.util.Log
import androidx.work.WorkManager

/**
 * Lazy WorkManager access — v13: auto-init via androidx.startup.
 *
 * v12 HISTORY: manual WorkManager.initialize() hit an on-device
 * NoClassDefFoundError ("Failed resolution") that exhaustive static dex
 * analysis could NOT explain — all 407 work-runtime classes, Room/SQLite/
 * Guava/startup/Kotlin-FunctionN, and Room's generated _Impl classes are
 * present in the dex. Root cause of the v11 dead-end was the blind
 * initialize() + swallowed IllegalStateException; v12 surfaced the real
 * error but manual init stayed broken on-device.
 *
 * v13 FIX: use the OFFICIAL init path — androidx.startup.InitializationProvider
 * (declared in AndroidManifest) auto-initializes WorkManager at process
 * start via WorkManagerInitializer. No manual initialize() call anywhere.
 * ensure() now only asks getInstance(); if auto-init failed, the error is
 * reported instead of retrying a broken manual path.
 *
 * Call [ensure] only from a user action ("Online"), from PollService, or
 * from BootReceiver — never from Application.onCreate / Activity.onCreate.
 */
object WorkHelper {
    private const val TAG = "WorkHelper"

    /** Last init failure (empty = none). Shown in Live tab diagnostics. */
    @Volatile var lastError: String = ""
        private set

    /**
     * True when WorkManager is usable in this process. Never throws.
     * Relies on androidx.startup auto-init (see AndroidManifest).
     */
    fun ensure(ctx: Context): Boolean {
        return try {
            WorkManager.getInstance(ctx)
            lastError = ""
            true
        } catch (t: Throwable) {
            // Auto-init did not happen (provider missing/disabled) or failed.
            // Do NOT attempt manual initialize() — v12 proved that path
            // throws NoClassDefFoundError on-device.
            lastError = "getInstance: ${t.javaClass.simpleName}: ${t.message}"
            Log.e(TAG, "WorkManager.getInstance failed (auto-init missing?)", t)
            false
        }
    }

    fun isReady(ctx: Context): Boolean = try {
        WorkManager.getInstance(ctx); true
    } catch (_: Throwable) { false }

    /** Cancels ALL WhopClip work (periodic + immediate). Offline path. */
    fun cancel(ctx: Context) {
        try {
            if (!isReady(ctx)) return
            val wm = WorkManager.getInstance(ctx)
            wm.cancelUniqueWork(PollService.WORK_NAME)
            wm.cancelUniqueWork(PollService.WORK_NOW_NAME)
            wm.cancelUniqueWork("${PollService.WORK_NAME}-boot")
        } catch (_: Throwable) { }
    }
}
