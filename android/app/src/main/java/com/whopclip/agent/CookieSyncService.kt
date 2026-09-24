package com.whopclip.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * v21: keeps login cookies flowing to the server automatically — now on a
 * slow 6-hour cadence (user request 2026-09-24: aggressive per-minute sync
 * stopped; sessions stay fresh without constant traffic).
 *
 * A foreground service (persistent notification) that re-syncs Instagram /
 * Whop / Content Rewards cookies every 6 hours. Only non-empty (valid)
 * cookies are uploaded; a source with no cookies is skipped so a logged-out
 * page never wipes the last good server-side jar.
 *
 * Started from MainActivity.onCreate and re-started on BOOT_COMPLETED /
 * MY_PACKAGE_REPLACED via BootReceiver.
 */
class CookieSyncService : Service() {
    companion object {
        const val CHANNEL_ID = "whopclip_cookiesync"
        const val NOTIF_ID = 1002
        const val INTERVAL_MS = 6 * 60 * 60 * 1000L // 6 hours
        private const val TAG = "CookieSyncService"

        fun start(ctx: Context) {
            val i = Intent(ctx, CookieSyncService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
                else ctx.startService(i)
            } catch (e: Exception) {
                Log.w(TAG, "start failed", e)
            }
        }

        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, CookieSyncService::class.java)) } catch (_: Exception) { }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var handler: Handler? = null
    private var lastRun = 0L

    private val tick = object : Runnable {
        override fun run() {
            val now = System.currentTimeMillis()
            // Debounce: never run more often than ~50s even if rescheduled.
            if (now - lastRun >= 50_000L) {
                lastRun = now
                scope.launch {
                    try {
                        val res = CookieSync.syncAll(this@CookieSyncService)
                        if (res.isNotEmpty()) updateNotif(res.values.sum())
                    } catch (e: Exception) {
                        Log.w(TAG, "tick failed", e)
                    }
                }
            }
            handler?.postDelayed(this, INTERVAL_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildNotif(null))
        handler = Handler(Looper.getMainLooper())
        handler?.post(tick)
        Log.i(TAG, "cookie auto-sync started (6h)")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        handler?.removeCallbacks(tick)
        scope.cancel()
        super.onDestroy()
    }

    private fun buildNotif(synced: Int?): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Cookie sync", NotificationManager.IMPORTANCE_LOW)
                )
            }
        }
        val text = if (synced != null) "Last sync: $synced cookies server pe bheje ✓"
                   else "Har 6 ghante me login cookies server pe sync honge"
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("WhopClip cookie sync")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .build()
    }

    private fun updateNotif(synced: Int) {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIF_ID, buildNotif(synced))
        } catch (_: Exception) { }
    }
}
