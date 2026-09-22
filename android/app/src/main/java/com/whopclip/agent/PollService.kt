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
import androidx.core.app.NotificationCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Foreground service that keeps the job poller alive, plus a
 * WorkManager periodic backup so polling survives process death.
 */
class PollService : Service() {
    companion object {
        const val CHANNEL_ID = "whopclip_poll"
        const val NOTIF_ID = 1001
        const val WORK_NAME = "whopclip-poll"

        fun start(ctx: Context) {
            val i = Intent(ctx, PollService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        /** Real stop: kills the foreground service + cancels periodic work. */
        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, PollService::class.java)) } catch (_: Exception) { }
            try {
                if (WorkHelper.isReady(ctx))
                    WorkManager.getInstance(ctx).cancelUniqueWork(WORK_NAME)
            } catch (_: Exception) { }
        }

        fun schedulePeriodic(ctx: Context) {
            // Lazy init: Application no longer touches WorkManager at launch.
            if (!WorkHelper.ensure(ctx)) return
            val req = PeriodicWorkRequestBuilder<PollWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req
            )
        }

        /**
         * One-shot expedited run — used after boot on Android 12+, where a
         * direct startForegroundService() from the background is blocked.
         * The worker promotes itself to foreground (notification) via
         * setForeground(), which IS allowed from the background.
         */
        fun scheduleExpedited(ctx: Context) {
            if (!WorkHelper.ensure(ctx)) return
            val req = OneTimeWorkRequestBuilder<PollWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                "$WORK_NAME-boot", ExistingWorkPolicy.KEEP, req
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
            try { PollService.scheduleExpedited(ctx) } catch (_: Throwable) { }
        }
        // Durable backbone on every version.
        try { PollService.schedulePeriodic(ctx) } catch (_: Throwable) { }
    }
}
