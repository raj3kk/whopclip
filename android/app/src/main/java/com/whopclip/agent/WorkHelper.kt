package com.whopclip.agent

import android.content.Context
import android.util.Log
import androidx.work.Configuration
import androidx.work.WorkManager

/**
 * Lazy WorkManager access — AutoClip-style (Scheduler.ensureInitialized).
 *
 * ROOT CAUSE of the v11 "WorkManager start nahi hua — dobara try karo"
 * dead-end: the old ensure() called WorkManager.initialize() BLINDLY on
 * every call. initialize() throws IllegalStateException("WorkManager is
 * already initialized") when WorkManager is already up in this process.
 * The exception was swallowed, ensure() returned false FOREVER, and the
 * Online button could never start automation no matter how many times the
 * user tapped it.
 *
 * Fixed pattern: ask for getInstance() FIRST; call initialize() only when
 * it throws IllegalStateException (genuinely not initialized yet). Every
 * path that ends with a usable WorkManager returns true. The last failure
 * is kept in [lastError] and surfaced in the UI, so a failure is never a
 * mystery again.
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
     * Thread-safe: a lost init race is detected and recovered via the
     * verification getInstance() below.
     */
    fun ensure(ctx: Context): Boolean {
        // 1) Already up? Done — also covers "someone else initialized it".
        try {
            WorkManager.getInstance(ctx)
            lastError = ""
            return true
        } catch (e: IllegalStateException) {
            // Genuinely not initialized yet — fall through and init below.
            Log.i(TAG, "WorkManager not initialized yet — initializing now")
        } catch (t: Throwable) {
            lastError = "getInstance: ${t.javaClass.simpleName}: ${t.message}"
            Log.e(TAG, "WorkManager.getInstance failed", t)
            return false
        }
        // 2) Lazy manual init (no androidx.startup provider in the manifest).
        try {
            WorkManager.initialize(
                ctx.applicationContext,
                Configuration.Builder()
                    .setMinimumLoggingLevel(Log.INFO)
                    .build()
            )
        } catch (t: Throwable) {
            // 3) Lost a race (initialized between our check and init)?
            //    Verify before giving up.
            try {
                WorkManager.getInstance(ctx)
                lastError = ""
                Log.i(TAG, "WorkManager became available during init race")
                return true
            } catch (_: Throwable) { }
            lastError = "initialize: ${t.javaClass.simpleName}: ${t.message}"
            Log.e(TAG, "lazy WorkManager init failed", t)
            return false
        }
        // 4) Verify the init actually took.
        return try {
            WorkManager.getInstance(ctx)
            lastError = ""
            Log.i(TAG, "WorkManager initialized lazily")
            true
        } catch (t: Throwable) {
            lastError = "verify: ${t.javaClass.simpleName}: ${t.message}"
            Log.e(TAG, "WorkManager init did not take", t)
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
