package com.openclaw.companion

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat

class BluetoothAudioCapability(private val context: Context) {
    companion object {
        private const val TAG = "BluetoothAudio"
        private const val MAX_SCO_RETRIES = 3
        private const val SCO_RETRY_DELAY_MS = 2000L
    }

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val handler = Handler(Looper.getMainLooper())
    private var scoRetryCount = 0
    private var scoActive = false
    private var scoDesired = false

    private val scoReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action == AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED) {
                val state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_DISCONNECTED)
                when (state) {
                    AudioManager.SCO_AUDIO_STATE_CONNECTED -> {
                        Log.i(TAG, "SCO audio connected")
                        scoActive = true
                        scoRetryCount = 0
                    }
                    AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> {
                        Log.i(TAG, "SCO audio disconnected")
                        scoActive = false
                        if (scoDesired && scoRetryCount < MAX_SCO_RETRIES) {
                            scoRetryCount++
                            Log.i(TAG, "SCO retry $scoRetryCount/$MAX_SCO_RETRIES")
                            handler.postDelayed({ startScoInternal() }, SCO_RETRY_DELAY_MS)
                        }
                    }
                    AudioManager.SCO_AUDIO_STATE_ERROR -> {
                        Log.e(TAG, "SCO audio error")
                        scoActive = false
                    }
                }
            }
        }
    }

    private var receiverRegistered = false

    fun isBluetoothAudioAvailable(): Boolean {
        if (!hasBluetoothPermission()) return false

        // Check if SCO is available
        if (!audioManager.isBluetoothScoAvailableOffCall) return false

        // Check if HFP device is connected
        val btManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = btManager?.adapter ?: return false

        return try {
            adapter.getProfileConnectionState(BluetoothProfile.HEADSET) == BluetoothProfile.STATE_CONNECTED
        } catch (e: SecurityException) {
            false
        }
    }

    fun startSco() {
        if (!hasBluetoothPermission()) {
            Log.w(TAG, "Missing BLUETOOTH_CONNECT permission")
            return
        }
        scoDesired = true
        scoRetryCount = 0
        registerReceiver()
        startScoInternal()
    }

    fun stopSco() {
        scoDesired = false
        scoRetryCount = 0
        try {
            audioManager.stopBluetoothSco()
            audioManager.isBluetoothScoOn = false
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping SCO", e)
        }
        scoActive = false
    }

    fun isScoActive(): Boolean = scoActive

    fun destroy() {
        stopSco()
        unregisterReceiver()
        handler.removeCallbacksAndMessages(null)
    }

    private fun startScoInternal() {
        try {
            audioManager.startBluetoothSco()
            audioManager.isBluetoothScoOn = true
            Log.i(TAG, "startBluetoothSco called")
        } catch (e: Exception) {
            Log.e(TAG, "Error starting SCO", e)
        }
    }

    private fun registerReceiver() {
        if (!receiverRegistered) {
            val filter = IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
            context.registerReceiver(scoReceiver, filter)
            receiverRegistered = true
        }
    }

    private fun unregisterReceiver() {
        if (receiverRegistered) {
            try {
                context.unregisterReceiver(scoReceiver)
            } catch (_: Exception) {}
            receiverRegistered = false
        }
    }

    private fun hasBluetoothPermission(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ContextCompat.checkSelfPermission(context, android.Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        }
        return true
    }
}
