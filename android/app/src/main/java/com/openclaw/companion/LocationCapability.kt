package com.openclaw.companion

import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import androidx.core.content.ContextCompat
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import kotlin.coroutines.resume

class LocationCapability : DeviceCapability {
    override val name = "location"

    override fun isAvailable(context: Context): Boolean {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        return lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }

    override fun hasPermission(context: Context): Boolean {
        return ContextCompat.checkSelfPermission(context, android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(context, android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    override fun requiredPermissions(): List<String> {
        return listOf(
            "android.permission.ACCESS_FINE_LOCATION",
            "android.permission.ACCESS_COARSE_LOCATION"
        )
    }

    @Suppress("MissingPermission")
    override suspend fun execute(context: Context, params: JSONObject): JSONObject {
        val accuracy = params.optString("accuracy", "fine")
        val priority = if (accuracy == "coarse") Priority.PRIORITY_BALANCED_POWER_ACCURACY else Priority.PRIORITY_HIGH_ACCURACY

        val fusedClient = LocationServices.getFusedLocationProviderClient(context)
        val cancellationTokenSource = CancellationTokenSource()

        val location = withTimeout(10_000L) {
            suspendCancellableCoroutine { cont ->
                cont.invokeOnCancellation { cancellationTokenSource.cancel() }

                val request = CurrentLocationRequest.Builder()
                    .setPriority(priority)
                    .setMaxUpdateAgeMillis(5000)
                    .build()

                fusedClient.getCurrentLocation(request, cancellationTokenSource.token)
                    .addOnSuccessListener { loc ->
                        if (cont.isActive) cont.resume(loc)
                    }
                    .addOnFailureListener { e ->
                        if (cont.isActive) cont.resume(null)
                    }
            }
        }

        if (location == null) {
            return JSONObject()
                .put("status", "error")
                .put("error", JSONObject()
                    .put("code", "LOCATION_UNAVAILABLE")
                    .put("message", "Could not get current location"))
        }

        val data = JSONObject().apply {
            put("latitude", location.latitude)
            put("longitude", location.longitude)
            put("accuracy", location.accuracy.toDouble())
            put("altitude", location.altitude)
            put("speed", location.speed.toDouble())
            put("provider", "fused")
            put("timestamp", location.time)
        }

        return JSONObject().put("status", "success").put("data", data)
    }
}
