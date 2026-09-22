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

        fun schedulePeriodic(ctx: Context) {
            // Lazy init: Application no longer touches WorkManager at launch.
            if (!WorkHelper.ensure(ctx)) return
            val req = PeriodicWorkRequestBuilder<PollWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req
            )
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "WhopClip polling",
                NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
        val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("WhopClip chal raha hai")
            .setContentText("Automation jobs ka wait ho raha hai")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .build()
        startForeground(NOTIF_ID, notif)
        schedulePeriodic(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int =
        START_STICKY
}

/** Re-arm polling after a reboot. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            PollService.schedulePeriodic(ctx)
        }
    }
}
