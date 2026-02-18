package com.openclaw.companion

import android.content.Context
import org.json.JSONObject

interface DeviceCapability {
    val name: String
    fun isAvailable(context: Context): Boolean
    fun hasPermission(context: Context): Boolean
    fun requiredPermissions(): List<String>
    suspend fun execute(context: Context, params: JSONObject): JSONObject
}

class CommandDispatcher(private val context: Context) {
    private val capabilities = mutableMapOf<String, DeviceCapability>()

    fun register(cap: DeviceCapability) {
        capabilities[cap.name] = cap
    }

    fun getCapabilitiesReport(): JSONObject {
        val report = JSONObject()
        capabilities.forEach { (name, cap) ->
            report.put(name, JSONObject().apply {
                put("available", cap.isAvailable(context))
                put("permissionGranted", cap.hasPermission(context))
            })
        }
        return report
    }

    suspend fun execute(command: String, params: JSONObject): JSONObject {
        val cap = capabilities[command]
            ?: return JSONObject()
                .put("status", "error")
                .put("error", JSONObject()
                    .put("code", "UNKNOWN_COMMAND")
                    .put("message", "Unknown command: $command"))

        if (!cap.isAvailable(context))
            return JSONObject()
                .put("status", "error")
                .put("error", JSONObject()
                    .put("code", "NOT_AVAILABLE")
                    .put("message", "$command not available"))

        if (!cap.hasPermission(context))
            return JSONObject()
                .put("status", "error")
                .put("error", JSONObject()
                    .put("code", "PERMISSION_DENIED")
                    .put("message", "$command permission not granted"))

        return try {
            cap.execute(context, params)
        } catch (e: Exception) {
            JSONObject()
                .put("status", "error")
                .put("error", JSONObject()
                    .put("code", "EXECUTION_ERROR")
                    .put("message", e.message ?: "Unknown error"))
        }
    }

    fun getMissingPermissions(): List<String> {
        return capabilities.values.flatMap { cap ->
            if (!cap.hasPermission(context)) cap.requiredPermissions() else emptyList()
        }.distinct()
    }
}
