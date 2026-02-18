package com.openclaw.companion

import android.app.ActivityManager
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

class SystemInfoCapability : DeviceCapability {
    override val name = "system_info"

    override fun isAvailable(context: Context) = true

    override fun hasPermission(context: Context): Boolean {
        // Network state doesn't require runtime permission
        // Bluetooth connect is only needed on API 31+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ContextCompat.checkSelfPermission(context, android.Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        }
        return true
    }

    override fun requiredPermissions(): List<String> {
        val perms = mutableListOf("android.permission.ACCESS_NETWORK_STATE")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            perms.add("android.permission.BLUETOOTH_CONNECT")
        }
        return perms
    }

    override suspend fun execute(context: Context, params: JSONObject): JSONObject {
        val data = JSONObject()

        // Battery
        data.put("battery", getBatteryInfo(context))

        // Storage
        data.put("storage", getStorageInfo())

        // RAM
        data.put("ram", getRamInfo(context))

        // Network
        data.put("network", getNetworkInfo(context))

        // Bluetooth
        data.put("bluetooth", getBluetoothInfo(context))

        // Device
        data.put("device", JSONObject().apply {
            put("model", Build.MODEL)
            put("manufacturer", Build.MANUFACTURER)
            put("android", Build.VERSION.RELEASE)
            put("sdk", Build.VERSION.SDK_INT)
        })

        // Uptime in seconds
        data.put("uptime", SystemClock.elapsedRealtime() / 1000)

        return JSONObject().put("status", "success").put("data", data)
    }

    private fun getBatteryInfo(context: Context): JSONObject {
        val batteryIntent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val json = JSONObject()
        if (batteryIntent != null) {
            val level = batteryIntent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = batteryIntent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            val pct = if (scale > 0) (level * 100) / scale else -1
            json.put("level", pct)

            val status = batteryIntent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            val isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
            json.put("charging", isCharging)

            val plugged = batteryIntent.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)
            val chargeType = when (plugged) {
                BatteryManager.BATTERY_PLUGGED_AC -> "AC"
                BatteryManager.BATTERY_PLUGGED_USB -> "USB"
                BatteryManager.BATTERY_PLUGGED_WIRELESS -> "WIRELESS"
                else -> "NONE"
            }
            json.put("chargeType", chargeType)

            val temp = batteryIntent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0)
            json.put("temperature", temp / 10.0)
        }
        return json
    }

    private fun getStorageInfo(): JSONObject {
        val stat = StatFs(Environment.getDataDirectory().path)
        val freeBytes = stat.availableBytes
        val totalBytes = stat.totalBytes
        return JSONObject().apply {
            put("freeGB", Math.round(freeBytes / 1_073_741_824.0 * 10) / 10.0)
            put("totalGB", Math.round(totalBytes / 1_073_741_824.0 * 10) / 10.0)
        }
    }

    private fun getRamInfo(context: Context): JSONObject {
        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(memInfo)
        return JSONObject().apply {
            put("availableMB", memInfo.availMem / (1024 * 1024))
            put("totalMB", memInfo.totalMem / (1024 * 1024))
        }
    }

    private fun getNetworkInfo(context: Context): JSONObject {
        val json = JSONObject()
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork
        val caps = if (network != null) cm.getNetworkCapabilities(network) else null

        if (caps == null) {
            json.put("type", "NONE")
            return json
        }

        val type = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WIFI"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "CELLULAR"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ETHERNET"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "BLUETOOTH"
            else -> "OTHER"
        }
        json.put("type", type)

        if (type == "WIFI") {
            try {
                val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                @Suppress("DEPRECATION")
                val wifiInfo = wifiManager.connectionInfo
                if (wifiInfo != null) {
                    val ssid = wifiInfo.ssid?.removeSurrounding("\"") ?: "unknown"
                    json.put("ssid", ssid)
                    json.put("signalStrength", wifiInfo.rssi)
                }
            } catch (_: Exception) {}
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            json.put("signalStrength", caps.signalStrength)
        }

        return json
    }

    private fun getBluetoothInfo(context: Context): JSONArray {
        val arr = JSONArray()
        try {
            val btManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager ?: return arr
            val adapter = btManager.adapter ?: return arr

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                ContextCompat.checkSelfPermission(context, android.Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                return arr
            }

            val bondedDevices: Set<BluetoothDevice> = adapter.bondedDevices ?: emptySet()
            for (device in bondedDevices) {
                // We can only list bonded devices; connected status requires profile proxies
                val deviceType = when (device.bluetoothClass?.majorDeviceClass) {
                    0x0400 -> "AUDIO"  // Audio/Video major class
                    0x0200 -> "PHONE"
                    0x0100 -> "COMPUTER"
                    0x0500 -> "PERIPHERAL"
                    else -> "OTHER"
                }
                arr.put(JSONObject().apply {
                    put("name", device.name ?: "Unknown")
                    put("type", deviceType)
                    put("address", device.address)
                })
            }
        } catch (_: Exception) {}
        return arr
    }
}
