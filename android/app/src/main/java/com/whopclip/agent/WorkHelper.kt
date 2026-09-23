package com.whopclip.agent

import android.content.Context
import android.util.Log
import androidx.work.Configuration
import androidx.work.WorkManager

/**
 * Lazy WorkManager access — v14: guarded manual init (AutoClip pattern).
 *
 * ROOT-CAUSE HISTORY (all proven from bytecode + dex forensics, 2026-09-23):
 * - v11: ensure() called WorkManager.initialize() BLINDLY on every call.
 *   Already-initialized -> IllegalStateException, swallowed -> ensure()
 *   false FOREVER. Online could never start automation.
 * - v12: fixed to getInstance-first + guarded init, and surfaced the real
 *   error: NoClassDefFoundError "Failed resolution". Static dex analysis
 *   "could not explain it" because it only checked work-runtime classes —
 *   the missing class was androidx.work.R$bool (referenced by
 *   WorkManagerImplExtKt.createWorkManager for
 *   R.bool.workmanager_test_configuration). The manual build only generated
 *   the APP's R class, never the LIBRARY R classes AAR bytecode references.
 * - v13: moved to androidx.startup auto-init. Same bug class, worse timing:
 *   AppInitializer touches androidx.startup.R$string inside
 *   InitializationProvider.onCreate() — before Application.onCreate, outside
 *   any try/catch we control -> app died instantly on launch.
 *
 * v14 FIX (two layers):
 *  1. BUILD (tools/gen_lib_r.py): every AAR's library R class is generated
 *     from its R.txt with the final merged resource ids, compiled and dexed.
 *     The dex guard in build-apk.sh fails the build if any library R class
 *     is missing. This is the true root fix.
 *  2. RUNTIME: no InitializationProvider in the manifest (nothing
 *     WorkManager-related runs at process start, ever). ensure() uses
 *     getInstance-first, then ONE synchronized guarded initialize(), then a
 *     verifying getInstance(). Every Throwable is caught; the real error
 *     stays visible in lastError (toast + Live tab). A WorkManager failure
 *     can delay automation — it can never again kill the app or wedge
 *     Online into a permanent "dobara try karo" state.
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
     * getInstance() first; guarded manual initialize() only when needed.
     */
    fun ensure(ctx: Context): Boolean {
        // Fast path: already initialized in this process.
        try {
            WorkManager.getInstance(ctx)
            lastError = ""
            return true
        } catch (_: Throwable) {
            // Not initialized yet (or init previously failed) — fall through
            // to the single guarded initialize() below.
        }
        return synchronized(this) {
            try {
                // Double-check inside the lock (two threads racing Online).
                try {
                    WorkManager.getInstance(ctx)
                    lastError = ""
                    return true
                } catch (_: Throwable) { }
                WorkManager.initialize(
                    ctx.applicationContext,
                    Configuration.Builder().build()
                )
                WorkManager.getInstance(ctx)
                lastError = ""
                Log.i(TAG, "WorkManager initialized (guarded manual init)")
                true
            } catch (t: Throwable) {
                lastError = "init: ${t.javaClass.simpleName}: ${t.message}"
                Log.e(TAG, "WorkManager init failed", t)
                false
            }
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
