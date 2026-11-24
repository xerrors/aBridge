package dev.abridge.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.PowerManager
import android.util.Log

/** Foreground ownership follows the existing accessibility service and explicit local opt-in. */
internal class Standby(private val service: Service) {
    private var foreground = false
    private val wakeLock = service.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "aBridge:standby").apply { setReferenceCounted(false) }

    fun update(enabled: Boolean, connected: Boolean, state: InteractionState): Boolean {
        if (!enabled) {
            stop()
            return false
        }
        return try {
            val manager = service.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "设备后台待命", NotificationManager.IMPORTANCE_LOW))
            val open = PendingIntent.getActivity(service, 0,
                Intent(service, SettingsActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val text = when {
                state == InteractionState.Locked -> "解锁设备后，Agent 可继续屏幕操作"
                state == InteractionState.ScreenOff -> "设备已熄屏，亮屏并解锁后可继续操作"
                connected -> "设备已连接，可在应用中暂停 Agent 操作"
                else -> "正在等待服务连接"
            }
            val notification = Notification.Builder(service, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("aBridge 后台待命")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build()
            if (!foreground) {
                if (Build.VERSION.SDK_INT >= 34)
                    service.startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
                else service.startForeground(ID, notification)
                foreground = true
            } else manager.notify(ID, notification)
            // Renewed by the connection heartbeat. A failed service loop cannot leave the CPU held forever.
            if (connected) wakeLock.acquire(120_000) else releaseWakeLock()
            true
        } catch (error: RuntimeException) {
            Log.w("aBridge", "Background standby unavailable: ${error.javaClass.simpleName}")
            stop()
            false
        }
    }

    fun releaseWakeLock() {
        if (wakeLock.isHeld) wakeLock.release()
    }

    fun stop() {
        releaseWakeLock()
        if (foreground) service.stopForeground(Service.STOP_FOREGROUND_REMOVE)
        foreground = false
    }

    private companion object {
        const val CHANNEL = "device-standby"
        const val ID = 1
    }
}
