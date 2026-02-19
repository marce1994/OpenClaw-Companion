package com.openclaw.companion.live2d

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PixelFormat
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.GLUtils
import android.util.AttributeSet
import android.util.Log
import android.widget.FrameLayout
import kotlin.math.sin
import com.live2d.sdk.cubism.framework.CubismFramework
import com.live2d.sdk.cubism.framework.CubismFrameworkConfig
import com.live2d.sdk.cubism.framework.math.CubismMatrix44
import com.live2d.sdk.cubism.framework.math.CubismViewMatrix
import com.live2d.sdk.cubism.framework.rendering.android.CubismRendererAndroid
import com.openclaw.companion.OrbView
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

class Live2DView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : GLSurfaceView(context, attrs), GLSurfaceView.Renderer {

    companion object {
        private const val TAG = "Live2DView"
        // Track framework state globally since it's a singleton
        private var frameworkInitialized = false
    }

    private var lAppModel: LAppModel? = null
    private var isGlInitialized = false
    private val textureIds = mutableMapOf<Int, Int>()
    private var lastFrameTime = 0L

    private val viewMatrix = CubismViewMatrix()
    private val projectionMatrix = CubismMatrix44.create()

    private var currentState = OrbView.State.IDLE
    private var currentAmplitude = 0f
    private var currentEmotion = "neutral"

    // Model name to load
    private var pendingModelName: String = "Haru"
    private var currentModelName: String = ""
    private var needsReload = false

    // Background color
    private var bgR = 6f / 255f
    private var bgG = 10f / 255f
    private var bgB = 31f / 255f
    private var bgAlpha = 1f
    private var isTransparent = false

    init {
        setEGLContextClientVersion(2)
        preserveEGLContextOnPause = true  // Keep GL context alive when switching apps
    }

    fun startRendering() {
        setRenderer(this)
        renderMode = RENDERMODE_CONTINUOUSLY
    }

    /**
     * Enable transparent GL background so a VideoView behind can show through.
     * Must be called before the surface is created (i.e., before adding to layout or in XML init).
     */
    fun enableTransparentBackground() {
        isTransparent = true
        setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        holder.setFormat(PixelFormat.TRANSLUCENT)
        setZOrderMediaOverlay(true) // Above video, below normal views (controls)
        bgAlpha = 0f
    }

    fun setModelName(name: String) {
        if (name != currentModelName || name != pendingModelName) {
            pendingModelName = name
            needsReload = true
        }
    }

    fun setState(state: OrbView.State) {
        currentState = state
        queueEvent {
            val model = lAppModel ?: return@queueEvent
            val stateName = when (state) {
                OrbView.State.IDLE -> "idle"
                OrbView.State.AMBIENT -> "idle"
                OrbView.State.LISTENING -> "listening"
                OrbView.State.THINKING -> "thinking"
                OrbView.State.SPEAKING -> "speaking"
                OrbView.State.DISCONNECTED -> "disconnected"
            }
            model.onStateChanged(stateName)
            if (state == OrbView.State.IDLE || state == OrbView.State.AMBIENT || state == OrbView.State.DISCONNECTED) {
                model.lipSyncValue = 0f
            }
        }
    }

    fun setAmplitude(amp: Float) {
        currentAmplitude = amp
        queueEvent {
            val model = lAppModel ?: return@queueEvent
            when (currentState) {
                OrbView.State.SPEAKING -> {
                    model.lipSyncValue = amp.coerceIn(0f, 1f)
                }
                OrbView.State.LISTENING -> {
                    model.lipSyncValue = (amp * 0.3f).coerceIn(0f, 0.3f)
                }
                else -> {
                    model.lipSyncValue = 0f
                }
            }
        }
    }

    // Emoji bubble overlay reference
    private var bubbleOverlay: EmojiBubbleOverlay? = null

    fun setEmotion(emotion: String) {
        currentEmotion = emotion
        queueEvent {
            lAppModel?.setEmotion(emotion)
        }
        // Spawn emoji bubble on the overlay
        bubbleOverlay?.spawnBubble(emotion)
    }

    /**
     * Attach an emoji bubble overlay on top of this view.
     * Call after this view has been added to a FrameLayout parent.
     */
    fun attachBubbleOverlay() {
        val parent = parent as? ViewGroup ?: return
        val overlay = EmojiBubbleOverlay(context)
        overlay.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        parent.addView(overlay)
        bubbleOverlay = overlay
    }

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        Log.i(TAG, "onSurfaceCreated called (GL context recreated)")
        GLES20.glClearColor(bgR, bgG, bgB, bgAlpha)
        GLES20.glEnable(GLES20.GL_BLEND)
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA)

        // If framework was previously initialized but GL context was lost,
        // we need to dispose and reinitialize to clear stale GL references
        if (frameworkInitialized) {
            Log.i(TAG, "Reinitializing Cubism Framework (GL context was lost)")
            try {
                lAppModel = null  // Clear model before disposing framework
                textureIds.clear()
                CubismFramework.dispose()
                CubismFramework.cleanUp()
            } catch (e: Exception) {
                Log.w(TAG, "Error disposing framework", e)
            }
            frameworkInitialized = false
        }

        // Initialize framework
        val option = CubismFramework.Option()
        option.loggingLevel = CubismFrameworkConfig.LogLevel.VERBOSE
        CubismFramework.startUp(option)
        CubismFramework.initialize()
        frameworkInitialized = true
        Log.i(TAG, "Cubism Framework initialized")

        // Load model fresh
        currentModelName = ""
        needsReload = true
        loadModel(pendingModelName)

        lastFrameTime = System.nanoTime()
        isGlInitialized = true
        Log.i(TAG, "GL surface created, model ready")
    }

    private fun loadModel(modelName: String) {
        // Clean up old textures
        textureIds.values.forEach { texId ->
            GLES20.glDeleteTextures(1, intArrayOf(texId), 0)
        }
        textureIds.clear()
        lAppModel = null

        val model = LAppModel()
        model.loadAssets(context.assets, modelName)
        lAppModel = model
        currentModelName = modelName
        needsReload = false

        if (model.isModelLoaded) {
            loadTextures(model)
        }

        Log.i(TAG, "Model loaded: $modelName, success: ${model.isModelLoaded}")
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        GLES20.glViewport(0, 0, width, height)
        updateProjection(width, height)
    }

    private fun updateProjection(width: Int, height: Int) {
        val ratio = width.toFloat() / height.toFloat()
        val config = lAppModel?.getModelConfig() ?: LAppModel.getConfig(currentModelName)

        viewMatrix.setScreenRect(-1f, 1f, -1f, 1f)
        viewMatrix.setMaxScreenRect(-2f, 2f, -2f, 2f)
        viewMatrix.setMaxScale(2f)
        viewMatrix.setMinScale(0.8f)

        projectionMatrix.loadIdentity()
        if (width > height) {
            projectionMatrix.scale(1f, ratio)
        } else {
            projectionMatrix.scale(1f / ratio, 1f)
        }

        projectionMatrix.scaleRelative(config.scale, config.scale)
        projectionMatrix.translateRelative(0f, config.offsetY)
    }

    override fun onDrawFrame(gl: GL10?) {
        // Handle model reload on GL thread
        if (needsReload) {
            loadModel(pendingModelName)
            val v = IntArray(4)
            GLES20.glGetIntegerv(GLES20.GL_VIEWPORT, v, 0)
            if (v[2] > 0 && v[3] > 0) updateProjection(v[2], v[3])
        }

        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)

        val model = lAppModel ?: return
        if (!model.isModelLoaded) return

        val now = System.nanoTime()
        val deltaSec = ((now - lastFrameTime) / 1_000_000_000.0).toFloat().coerceIn(0f, 0.1f)
        lastFrameTime = now

        model.updateModel(deltaSec)

        val cubismModel = model.getModelInstance() ?: return
        val renderer = model.getRenderer<CubismRendererAndroid>() ?: return

        val mvp = CubismMatrix44.create()
        mvp.loadIdentity()
        mvp.multiplyByMatrix(projectionMatrix)
        mvp.multiplyByMatrix(viewMatrix)

        renderer.setMvpMatrix(mvp)
        renderer.drawModel()
    }

    private fun loadTextures(model: LAppModel) {
        for (i in 0 until model.getTextureCount()) {
            val texPath = model.getTextureFileName(i)
            if (texPath.isEmpty()) continue

            try {
                val stream = context.assets.open(texPath)
                // Load bitmap WITHOUT premultiplied alpha (Android premultiplies by default since API 19)
                // This prevents double-premultiply which darkens semi-transparent parts like blush
                val opts = BitmapFactory.Options().apply {
                    inPremultiplied = false
                }
                val bitmap = BitmapFactory.decodeStream(stream, null, opts)
                stream.close()

                if (bitmap != null) {
                    val texIds = IntArray(1)
                    GLES20.glGenTextures(1, texIds, 0)
                    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texIds[0])
                    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR_MIPMAP_LINEAR)
                    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)

                    // Upload non-premultiplied texture, then premultiply manually for correct blending
                    val premultiplied = premultiplyAlpha(bitmap)
                    // GLUtils.texImage2D doesn't work with non-premultiplied bitmaps on some devices
                    // So we use the manually premultiplied version
                    // Need to set isPremultiplied on the result bitmap for GLUtils to accept it
                    premultiplied.isPremultiplied = true
                    GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, premultiplied, 0)
                    GLES20.glGenerateMipmap(GLES20.GL_TEXTURE_2D)

                    premultiplied.recycle()
                    bitmap.recycle()

                    val renderer = model.getRenderer<CubismRendererAndroid>()
                    renderer?.bindTexture(i, texIds[0])
                    textureIds[i] = texIds[0]

                    Log.d(TAG, "Loaded texture $i: $texPath -> ${texIds[0]}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load texture: $texPath", e)
            }
        }

        model.getRenderer<CubismRendererAndroid>()?.isPremultipliedAlpha(true)
    }

    private fun premultiplyAlpha(bitmap: Bitmap): Bitmap {
        val result = bitmap.copy(Bitmap.Config.ARGB_8888, true)
        val pixels = IntArray(result.width * result.height)
        result.getPixels(pixels, 0, result.width, 0, 0, result.width, result.height)
        for (i in pixels.indices) {
            val c = pixels[i]
            val a = (c ushr 24) and 0xFF
            val r = ((c ushr 16) and 0xFF) * a / 255
            val g = ((c ushr 8) and 0xFF) * a / 255
            val b = (c and 0xFF) * a / 255
            pixels[i] = (a shl 24) or (r shl 16) or (g shl 8) or b
        }
        result.setPixels(pixels, 0, result.width, 0, 0, result.width, result.height)
        return result
    }

    // Motion triggering proxy methods
    fun playMotion(group: String, index: Int) {
        queueEvent { lAppModel?.playMotion(group, index) }
    }

    fun playRandomMotion(group: String) {
        queueEvent { lAppModel?.playRandomMotion(group) }
    }

    // Touch tracking
    fun setTouchPosition(normalizedX: Float, normalizedY: Float) {
        queueEvent { lAppModel?.setTouchPosition(normalizedX, normalizedY) }
    }

    fun clearTouch() {
        queueEvent { lAppModel?.clearTouch() }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.action) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> {
                val normalizedX = (event.x / width) * 2f - 1f
                val normalizedY = -((event.y / height) * 2f - 1f)
                queueEvent { lAppModel?.setTouchPosition(normalizedX, normalizedY) }
                if (event.action == MotionEvent.ACTION_DOWN) {
                    queueEvent {
                        lAppModel?.playRandomMotion("TapBody")
                        lAppModel?.onTouchDown()
                    }
                }
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                queueEvent { lAppModel?.clearTouch() }
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    fun onActivityPause() {
        onPause()
    }

    fun onActivityResume() {
        onResume()
    }

    fun cleanup() {
        queueEvent {
            textureIds.values.forEach { texId ->
                GLES20.glDeleteTextures(1, intArrayOf(texId), 0)
            }
            textureIds.clear()
            lAppModel = null
            // Don't dispose framework — it's a singleton, will be reused on next Activity
        }
    }
}

/**
 * Transparent overlay view that renders floating emoji bubbles.
 * Drawn on a standard Android Canvas on top of the GLSurfaceView.
 */
class EmojiBubbleOverlay @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    companion object {
        private val EMOTION_EMOJIS = mapOf(
            "happy" to "😄", "laughing" to "😂", "thinking" to "🤔", "confused" to "😵",
            "sad" to "😢", "love" to "❤️", "angry" to "😤", "surprised" to "😮"
        )
        private const val BUBBLE_DURATION_MS = 2500L
        private const val EMOJI_SIZE_SP = 44f
    }

    private data class Bubble(
        val emoji: String,
        val startX: Float,
        val startY: Float,
        val startTime: Long,
        val wobbleOffset: Float
    )

    private val bubbles = mutableListOf<Bubble>()
    private val emojiPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = EMOJI_SIZE_SP * resources.displayMetrics.scaledDensity
    }
    private var animator: ValueAnimator? = null

    fun spawnBubble(emotion: String) {
        val emoji = EMOTION_EMOJIS[emotion] ?: return
        post {
            val cx = width / 2f + (Math.random().toFloat() - 0.5f) * width * 0.2f
            val cy = height * 0.4f
            bubbles.add(Bubble(emoji, cx, cy, System.currentTimeMillis(), (Math.random() * Math.PI * 2).toFloat()))
            ensureAnimating()
        }
    }

    private fun ensureAnimating() {
        if (animator?.isRunning == true) return
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = BUBBLE_DURATION_MS
            repeatCount = ValueAnimator.INFINITE
            addUpdateListener { invalidate() }
            start()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (bubbles.isEmpty()) {
            animator?.cancel()
            animator = null
            return
        }
        val now = System.currentTimeMillis()
        val iter = bubbles.iterator()
        while (iter.hasNext()) {
            val b = iter.next()
            val elapsed = now - b.startTime
            if (elapsed > BUBBLE_DURATION_MS) { iter.remove(); continue }
            val t = elapsed.toFloat() / BUBBLE_DURATION_MS
            val x = b.startX + sin((t * Math.PI * 4 + b.wobbleOffset).toDouble()).toFloat() * 30f
            val y = b.startY - t * height * 0.35f
            emojiPaint.alpha = ((1f - t) * 255).toInt().coerceIn(0, 255)
            canvas.drawText(b.emoji, x, y, emojiPaint)
        }
        if (bubbles.isEmpty()) {
            animator?.cancel()
            animator = null
        }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        animator?.cancel()
        animator = null
    }
}
