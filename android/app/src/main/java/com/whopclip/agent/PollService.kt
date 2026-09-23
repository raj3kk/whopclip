package com.whopclip.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Foreground service that keeps the job poller alive, plus a
 * WorkManager periodic backup so polling survives process death.
 *
 * v12 automation model (AutoClip-style):
 * - startAutomation(): ONE entry point — foreground service (persistent
 *   notification) + immediate worker run NOW + durable 15-min periodic
 *   backbone. Used by the Online button AND by app-launch auto-start.
 * - The periodic work requires CONNECTED network: phone offline ho to
 *   WorkManager wait karta hai, network wapas aate hi worker khud chal
 *   padta hai ("mobile online aye → automatic background me chalne lage").
 */
class PollService : Service() {
    companion object {
        const val CHANNEL_ID = "whopclip_poll"
        const val NOTIF_ID = 1001
        const val WORK_NAME = "whopclip-poll"
        const val WORK_NOW_NAME = "whopclip-poll-now"
        private const val TAG = "PollService"

        fun start(ctx: Context) {
            val i = Intent(ctx, PollService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        /** Real stop: kills the foreground service + cancels all work. */
        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, PollService::class.java)) } catch (_: Exception) { }
            WorkHelper.cancel(ctx)
        }

        /**
         * Full automation start — the single entry point. Returns false only
         * when WorkManager itself is unusable (error in WorkHelper.lastError).
         */
        fun startAutomation(ctx: Context): Boolean {
            if (!WorkHelper.ensure(ctx)) {
                Log.e(TAG, "startAutomation: WorkManager unusable: ${WorkHelper.lastError}")
                return false
            }
            return try {
                start(ctx)            // foreground service + persistent notification
                runNow(ctx)           // immediate PollWorker run — automation starts NOW
                schedulePeriodic(ctx) // durable 15-min backbone
                Log.i(TAG, "automation started (service + immediate run + periodic)")
                true
            } catch (t: Throwable) {
                Log.e(TAG, "startAutomation failed", t)
                false
            }
        }

        /**
         * One immediate PollWorker run. `name` separates user taps / launch
         * auto-start from boot re-arming so they don't cancel each other.
         */
        fun runNow(ctx: Context, name: String = WORK_NOW_NAME) {
            if (!WorkHelper.ensure(ctx)) return
            val req = OneTimeWorkRequestBuilder<PollWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                name, ExistingWorkPolicy.REPLACE, req
            )
        }

        fun schedulePeriodic(ctx: Context) {
            // Lazy init: Application no longer touches WorkManager at launch.
            if (!WorkHelper.ensure(ctx)) return
            // CONNECTED constraint: network wapas aate hi WorkManager worker
            // khud chala dega — no manual retry needed.
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val req = PeriodicWorkRequestBuilder<PollWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()
            // UPDATE (not KEEP): purani bina-constraint wali periodic work ko
            // nayi constraint wali se replace karo.
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, req
            )
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "WhopClip background",
                NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = android.app.PendingIntent.getActivity(
            this, 0, openIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )
        val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("WhopClip background me chal raha hai")
            .setContentText("Automation ON — jobs ka wait ho raha hai (tap karke kholo)")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
        startForeground(NOTIF_ID, notif)
        schedulePeriodic(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int =
        START_STICKY
}

/** Re-arm polling after a reboot / app update — only if automation was ON. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        // v20: cookie auto-sync bhi re-arm karo (paired device pe hamesha).
        if (SessionManager.isPaired(ctx)) {
            try { CookieSyncService.start(ctx) } catch (t: Throwable) {
                android.util.Log.w("BootReceiver", "cookie sync start blocked", t)
            }
        }
        // Respect the user's choice: only auto-start if they left it ONLINE.
        if (!SessionManager.isPaired(ctx) || !SessionManager.isOnline(ctx)) {
            android.util.Log.i("BootReceiver", "was offline — not auto-starting")
            return
        }
        android.util.Log.i("BootReceiver", "re-arming background automation after $action")
        try {
            // Pre-Android 12: foreground service starts fine from boot.
            // On 12+ this throws ForegroundServiceStartNotAllowedException —
            // caught below, expedited worker covers it.
            PollService.start(ctx)
        } catch (t: Throwable) {
            android.util.Log.w("BootReceiver",
                "foreground start blocked (${t.javaClass.simpleName}) — using expedited work")
        }
        // Immediate run + durable backbone on every version.
        try { PollService.runNow(ctx, "${PollService.WORK_NAME}-boot") } catch (_: Throwable) { }
        try { PollService.schedulePeriodic(ctx) } catch (_: Throwable) { }
    }
}
