package com.whopclip.agent

import android.app.Application
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * v6: Application does NOTHING except install a crash recorder.
 *
 * Root-cause history: v3/v4/v5 crashed immediately on launch on the user's
 * phone. v5 wrapped WorkManager.getInstance() in try/catch but the crash
 * persisted, proving the crash was NOT in that call. Suspects eliminated by
 * removal: eager WorkManager Configuration property (ran before onCreate,
 * outside any try/catch), AppCompat on the launch path.
 *
 * WorkManager is now initialized LAZILY (see WorkHelper) only when the user
 * actually starts automation — never at app launch.
 *
 * If anything still crashes at startup, the uncaught-exception handler writes
 * the full stack trace to <files>/crash.log and the next launch shows it in
 * the diagnostic card instead of silently dying.
 */
class WhopClipApp : Application() {
    companion object {
        private const val TAG = "WhopClipApp"
        const val CRASH_FILE = "crash.log"

        fun readCrashLog(app: Application): String? = try {
            val f = File(app.filesDir, CRASH_FILE)
            if (f.exists()) f.readText() else null
        } catch (_: Exception) { null }

        fun clearCrashLog(app: Application) = try {
            File(app.filesDir, CRASH_FILE).delete()
        } catch (_: Exception) { }
    }

    override fun onCreate() {
        super.onCreate()
        val app = this
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
                val sw = java.io.StringWriter()
                throwable.printStackTrace(java.io.PrintWriter(sw))
                val report = "[$ts] thread=${thread.name}\n${throwable}\n${sw}\n"
                File(app.filesDir, CRASH_FILE).appendText(report)
                Log.e(TAG, "crash recorded", throwable)
            } catch (_: Exception) { }
            prev?.uncaughtException(thread, throwable)
        }
        Log.i(TAG, "WhopClipApp started (v6, no WorkManager at launch)")
    }
}
