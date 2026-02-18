package com.openclaw.companion

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.util.Base64
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.coroutines.resume

class CameraCapability : DeviceCapability {
    override val name = "camera"

    override fun isAvailable(context: Context): Boolean {
        return context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }

    override fun hasPermission(context: Context): Boolean {
        return ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    }

    override fun requiredPermissions(): List<String> {
        return listOf("android.permission.CAMERA")
    }

    override suspend fun execute(context: Context, params: JSONObject): JSONObject {
        val cameraFacing = params.optString("camera", "back")
        val cameraSelector = if (cameraFacing == "front") CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA

        return withTimeout(15_000L) {
            suspendCancellableCoroutine { cont ->
                val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
                cameraProviderFuture.addListener({
                    try {
                        val cameraProvider = cameraProviderFuture.get()
                        val lifecycleOwner = CameraLifecycleOwner()

                        val imageCapture = ImageCapture.Builder()
                            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                            .build()

                        cameraProvider.unbindAll()
                        lifecycleOwner.start()
                        cameraProvider.bindToLifecycle(lifecycleOwner, cameraSelector, imageCapture)

                        // Small delay to let camera initialize
                        val executor = Executors.newSingleThreadExecutor()
                        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                            imageCapture.takePicture(executor, object : ImageCapture.OnImageCapturedCallback() {
                                override fun onCaptureSuccess(imageProxy: ImageProxy) {
                                    try {
                                        val bitmap = imageProxyToBitmap(imageProxy)
                                        imageProxy.close()

                                        val resized = resizeBitmap(bitmap, 1280)
                                        val baos = ByteArrayOutputStream()
                                        resized.compress(Bitmap.CompressFormat.JPEG, 70, baos)
                                        val base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)

                                        val data = JSONObject().apply {
                                            put("image", base64)
                                            put("width", resized.width)
                                            put("height", resized.height)
                                            put("camera", cameraFacing)
                                            put("mimeType", "image/jpeg")
                                        }

                                        cameraProvider.unbindAll()
                                        lifecycleOwner.stop()

                                        if (cont.isActive) cont.resume(JSONObject().put("status", "success").put("data", data))
                                    } catch (e: Exception) {
                                        cameraProvider.unbindAll()
                                        lifecycleOwner.stop()
                                        if (cont.isActive) cont.resume(
                                            JSONObject().put("status", "error")
                                                .put("error", JSONObject().put("code", "PROCESSING_ERROR").put("message", e.message))
                                        )
                                    }
                                }

                                override fun onError(exception: ImageCaptureException) {
                                    cameraProvider.unbindAll()
                                    lifecycleOwner.stop()
                                    if (cont.isActive) cont.resume(
                                        JSONObject().put("status", "error")
                                            .put("error", JSONObject().put("code", "CAPTURE_ERROR").put("message", exception.message))
                                    )
                                }
                            })
                        }, 500) // 500ms for camera to warm up
                    } catch (e: Exception) {
                        if (cont.isActive) cont.resume(
                            JSONObject().put("status", "error")
                                .put("error", JSONObject().put("code", "CAMERA_INIT_ERROR").put("message", e.message))
                        )
                    }
                }, ContextCompat.getMainExecutor(context))
            }
        }
    }

    private fun imageProxyToBitmap(imageProxy: ImageProxy): Bitmap {
        val buffer = imageProxy.planes[0].buffer
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)

        // Apply rotation
        val rotation = imageProxy.imageInfo.rotationDegrees
        return if (rotation != 0) {
            val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        } else {
            bitmap
        }
    }

    private fun resizeBitmap(bitmap: Bitmap, maxWidth: Int): Bitmap {
        if (bitmap.width <= maxWidth) return bitmap
        val ratio = maxWidth.toFloat() / bitmap.width
        val newHeight = (bitmap.height * ratio).toInt()
        return Bitmap.createScaledBitmap(bitmap, maxWidth, newHeight, true)
    }

    /**
     * A simple LifecycleOwner for CameraX that doesn't depend on AppCompatActivity.
     */
    class CameraLifecycleOwner : LifecycleOwner {
        private val lifecycleRegistry = LifecycleRegistry(this)

        override val lifecycle: Lifecycle
            get() = lifecycleRegistry

        fun start() {
            lifecycleRegistry.currentState = Lifecycle.State.STARTED
        }

        fun stop() {
            lifecycleRegistry.currentState = Lifecycle.State.DESTROYED
        }
    }
}
