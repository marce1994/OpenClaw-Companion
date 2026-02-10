package com.openclaw.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import androidx.localbroadcastmanager.content.LocalBroadcastManager

class VoiceService : Service() {

    private var mediaSession: MediaSession? = null
    private val CHANNEL_ID = "openclaw_companion"
    private val NOTIFICATION_ID = 1
    private var botName = "Assistant"

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        botName = intent?.getStringExtra("bot_name") ?: "Assistant"
        startForeground(NOTIFICATION_ID, buildNotification())
        setupMediaSession()
        return START_STICKY
    }

    private fun setupMediaSession() {
        mediaSession?.release()
        mediaSession = MediaSession(this, "OpenClawCompanion").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                    val event = mediaButtonIntent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)
                        ?: return super.onMediaButtonEvent(mediaButtonIntent)

                    if (event.keyCode == KeyEvent.KEYCODE_HEADSETHOOK ||
                        event.keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {

                        // Toggle mode: only react to DOWN
                        if (event.action == KeyEvent.ACTION_DOWN) {
                            Log.d("OpenClaw", "MediaSession: button TOGGLE")
                            sendToActivity("media_button_toggle")
                            return true
                        }
                        // Consume UP silently
                        if (event.action == KeyEvent.ACTION_UP) return true
                    }
                    return super.onMediaButtonEvent(mediaButtonIntent)
                }
            })

            setPlaybackState(
                PlaybackState.Builder()
                    .setState(PlaybackState.STATE_PLAYING, 0, 1f)
                    .setActions(PlaybackState.ACTION_PLAY_PAUSE)
                    .build()
            )
            isActive = true
        }
    }

    private fun sendToActivity(extraKey: String) {
        val action = when (extraKey) {
            "media_button_toggle" -> "com.openclaw.companion.MEDIA_BUTTON_TOGGLE"
            else -> return
        }
        val intent = Intent(action)
        LocalBroadcastManager.getInstance(this).sendBroadcast(intent)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "OpenClaw Companion",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "OpenClaw Companion voice service"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pending = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title_dynamic, botName))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        mediaSession?.release()
        super.onDestroy()
    }
}
