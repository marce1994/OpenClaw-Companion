package com.openclaw.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.view.KeyEvent
import androidx.localbroadcastmanager.content.LocalBroadcastManager

class MediaButtonReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Intent.ACTION_MEDIA_BUTTON == intent.action) {
            val event = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return
            if (event.keyCode == KeyEvent.KEYCODE_HEADSETHOOK ||
                event.keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
                // Toggle mode: only react to DOWN
                if (event.action == KeyEvent.ACTION_DOWN) {
                    LocalBroadcastManager.getInstance(context)
                        .sendBroadcast(Intent("com.openclaw.companion.MEDIA_BUTTON_TOGGLE"))
                    abortBroadcast()
                } else if (event.action == KeyEvent.ACTION_UP) {
                    // Consume UP silently
                    abortBroadcast()
                }
            }
        }
    }
}
