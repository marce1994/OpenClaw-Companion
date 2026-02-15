package com.openclaw.companion

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.*
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

class OrbView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    enum class State { IDLE, AMBIENT, LISTENING, THINKING, SPEAKING, DISCONNECTED }

    private var state = State.IDLE
    private var amplitude = 0f
    private var phase = 0f
    private var currentSkin = "Default"
    private var currentEmotion = "neutral"
    private val emotionHandler = Handler(Looper.getMainLooper())
    private var emotionResetRunnable: Runnable? = null

    private val orbPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)

    private val skinColors = mapOf(
        "Default" to mapOf(
            State.IDLE to intArrayOf(0xFF1565C0.toInt(), 0xFF42A5F5.toInt()),
            State.AMBIENT to intArrayOf(0xFF0D47A1.toInt(), 0xFF2196F3.toInt()),
            State.LISTENING to intArrayOf(0xFFE53935.toInt(), 0xFFFF7043.toInt()),
            State.THINKING to intArrayOf(0xFFFFA000.toInt(), 0xFFFFD54F.toInt()),
            State.SPEAKING to intArrayOf(0xFF00897B.toInt(), 0xFF4DD0E1.toInt()),
            State.DISCONNECTED to intArrayOf(0xFF424242.toInt(), 0xFF757575.toInt())
        ),
        "Jarvis" to mapOf(
            State.IDLE to intArrayOf(0xFF0099BB.toInt(), 0xFF00DDFF.toInt()),
            State.AMBIENT to intArrayOf(0xFF007799.toInt(), 0xFF00BBDD.toInt()),
            State.LISTENING to intArrayOf(0xFFCC5500.toInt(), 0xFFFF6600.toInt()),
            State.THINKING to intArrayOf(0xFFCCAA00.toInt(), 0xFFFFDD00.toInt()),
            State.SPEAKING to intArrayOf(0xFF0066CC.toInt(), 0xFF0088FF.toInt()),
            State.DISCONNECTED to intArrayOf(0xFF424242.toInt(), 0xFF757575.toInt())
        ),
        "Fuego" to mapOf(
            State.IDLE to intArrayOf(0xFFCC3300.toInt(), 0xFFFF4400.toInt()),
            State.AMBIENT to intArrayOf(0xFF992200.toInt(), 0xFFCC3300.toInt()),
            State.LISTENING to intArrayOf(0xFFCC1100.toInt(), 0xFFFF3300.toInt()),
            State.THINKING to intArrayOf(0xFFCC8800.toInt(), 0xFFFFAA00.toInt()),
            State.SPEAKING to intArrayOf(0xFFDD5500.toInt(), 0xFFFF7700.toInt()),
            State.DISCONNECTED to intArrayOf(0xFF424242.toInt(), 0xFF757575.toInt())
        ),
        "Matrix" to mapOf(
            State.IDLE to intArrayOf(0xFF003311.toInt(), 0xFF006622.toInt()),
            State.AMBIENT to intArrayOf(0xFF002208.toInt(), 0xFF004411.toInt()),
            State.LISTENING to intArrayOf(0xFF00BB00.toInt(), 0xFF00FF41.toInt()),
            State.THINKING to intArrayOf(0xFF55AA00.toInt(), 0xFF88FF00.toInt()),
            State.SPEAKING to intArrayOf(0xFF00CC33.toInt(), 0xFF33FF66.toInt()),
            State.DISCONNECTED to intArrayOf(0xFF424242.toInt(), 0xFF757575.toInt())
        ),
        "Cósmico" to mapOf(
            State.IDLE to intArrayOf(0xFF6600CC.toInt(), 0xFF9933FF.toInt()),
            State.AMBIENT to intArrayOf(0xFF4400AA.toInt(), 0xFF7722DD.toInt()),
            State.LISTENING to intArrayOf(0xFFCC00CC.toInt(), 0xFFFF33FF.toInt()),
            State.THINKING to intArrayOf(0xFFDD3388.toInt(), 0xFFFF66AA.toInt()),
            State.SPEAKING to intArrayOf(0xFF5500AA.toInt(), 0xFF7733DD.toInt()),
            State.DISCONNECTED to intArrayOf(0xFF424242.toInt(), 0xFF757575.toInt())
        )
    )

    // Cute face paints
    private val facePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val eyeWhitePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val pupilPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK }
    private val mouthPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF333333.toInt(); style = Paint.Style.STROKE; strokeWidth = 6f; strokeCap = Paint.Cap.ROUND
    }
    private val mouthFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF333333.toInt(); style = Paint.Style.FILL
    }
    private val eyelidPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val browPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF555555.toInt(); style = Paint.Style.STROKE; strokeWidth = 5f; strokeCap = Paint.Cap.ROUND
    }
    private val blushPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x40FF6B8A.toInt()
    }
    private val tearPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF88CCFF.toInt()
    }
    private val heartPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFFF4466.toInt(); style = Paint.Style.FILL
    }

    private var blinkPhase = 0f
    private var lastBlinkTime = 0L
    private var isBlinking = false
    private var lookX = 0f
    private var lookY = 0f
    private var lastLookChange = 0L

    private val animator = ValueAnimator.ofFloat(0f, (2 * Math.PI).toFloat()).apply {
        duration = 3000
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener {
            phase = it.animatedValue as Float
            if (currentSkin == "Cute") {
                val now = System.currentTimeMillis()
                // Blink
                if ((state == State.IDLE || state == State.AMBIENT) && !isBlinking && now - lastBlinkTime > 3000 + (Math.random() * 1000).toLong()) {
                    isBlinking = true
                    lastBlinkTime = now
                    blinkPhase = 0f
                }
                if (isBlinking) {
                    blinkPhase += 0.15f
                    if (blinkPhase > 1f) { isBlinking = false; blinkPhase = 0f }
                }
                // Random look direction (idle)
                if ((state == State.IDLE || state == State.AMBIENT) && now - lastLookChange > 2000 + (Math.random() * 3000).toLong()) {
                    lookX = (Math.random().toFloat() - 0.5f) * 0.4f
                    lookY = (Math.random().toFloat() - 0.5f) * 0.3f
                    lastLookChange = now
                }
            }
            invalidate()
        }
    }

    init {
        animator.start()
    }

    fun setState(newState: State) {
        if (state == newState) return
        state = newState
        // Reset emotion on state change
        currentEmotion = "neutral"
        emotionResetRunnable?.let { emotionHandler.removeCallbacks(it) }
        animator.duration = when (state) {
            State.IDLE -> 3000
            State.AMBIENT -> 4000
            State.LISTENING -> 1500
            State.THINKING -> 600
            State.SPEAKING -> 2000
            State.DISCONNECTED -> 4000
        }
        invalidate()
    }

    fun setAmplitude(amp: Float) {
        amplitude = amp.coerceIn(0f, 1f)
    }

    fun setSkin(skinName: String) {
        currentSkin = skinName
        invalidate()
    }

    fun getSkin(): String = currentSkin

    fun setEmotion(emotion: String) {
        currentEmotion = emotion
        // Reset to neutral after 5 seconds
        emotionResetRunnable?.let { emotionHandler.removeCallbacks(it) }
        if (emotion != "neutral") {
            emotionResetRunnable = Runnable { currentEmotion = "neutral"; invalidate() }
            emotionHandler.postDelayed(emotionResetRunnable!!, 5000)
        }
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (currentSkin == "Cute") {
            drawCuteFace(canvas)
        } else {
            drawOrb(canvas)
        }
    }

    private fun drawOrb(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val maxRadius = min(width, height) / 2f * 0.7f

        val breathe = when (state) {
            State.IDLE -> 0.05f * sin(phase).toFloat()
            State.AMBIENT -> 0.08f * sin(phase).toFloat() + 0.03f * sin(phase * 2.5).toFloat()
            State.LISTENING -> 0.15f * amplitude + 0.05f * sin(phase).toFloat()
            State.THINKING -> 0.10f * sin(phase * 3).toFloat() + 0.04f * sin(phase * 7).toFloat()
            State.SPEAKING -> 0.12f * amplitude + 0.04f * sin(phase).toFloat()
            State.DISCONNECTED -> 0.02f * sin(phase).toFloat()
        }
        val radius = maxRadius * (0.85f + breathe)

        val colors = skinColors[currentSkin] ?: skinColors["Default"]!!
        val c = colors[state] ?: skinColors["Default"]!![state]!!
        val gradient = RadialGradient(cx, cy, radius * 1.5f, c[1], c[0], Shader.TileMode.CLAMP)

        glowPaint.shader = RadialGradient(cx, cy, radius * 1.8f,
            intArrayOf(Color.argb(80, Color.red(c[1]), Color.green(c[1]), Color.blue(c[1])), Color.TRANSPARENT),
            floatArrayOf(0.3f, 1f), Shader.TileMode.CLAMP)
        canvas.drawCircle(cx, cy, radius * 1.8f, glowPaint)

        orbPaint.shader = gradient
        canvas.drawCircle(cx, cy, radius, orbPaint)

        val hlPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        hlPaint.shader = RadialGradient(cx - radius * 0.2f, cy - radius * 0.2f, radius * 0.6f,
            Color.argb(60, 255, 255, 255), Color.TRANSPARENT, Shader.TileMode.CLAMP)
        canvas.drawCircle(cx - radius * 0.2f, cy - radius * 0.2f, radius * 0.6f, hlPaint)

        // Pulsing ring for AMBIENT state (smart listening)
        if (state == State.AMBIENT) {
            val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                strokeWidth = 2f
                val pulseAlpha = (40 + 30 * sin(phase * 1.5)).toInt().coerceIn(10, 70)
                color = Color.argb(pulseAlpha, Color.red(c[1]), Color.green(c[1]), Color.blue(c[1]))
            }
            val ringRadius = radius * (1.2f + 0.15f * sin(phase).toFloat())
            canvas.drawCircle(cx, cy, ringRadius, ringPaint)
            val ringRadius2 = radius * (1.35f + 0.1f * sin(phase + 2f).toFloat())
            ringPaint.alpha = (20 + 15 * sin(phase * 1.2)).toInt().coerceIn(5, 40)
            canvas.drawCircle(cx, cy, ringRadius2, ringPaint)
        }

        // Orbiting dots during THINKING state
        if (state == State.THINKING) {
            val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)
            val orbitRadius = radius * 1.35f
            val dotCount = 3
            for (i in 0 until dotCount) {
                val angle = phase * 2.5 + (i * 2.0 * Math.PI / dotCount)
                val dx = cx + (orbitRadius * cos(angle)).toFloat()
                val dy = cy + (orbitRadius * sin(angle)).toFloat()
                val alpha = (150 + 105 * sin(phase * 3 + i)).toInt().coerceIn(80, 255)
                dotPaint.color = Color.argb(alpha, Color.red(c[1]), Color.green(c[1]), Color.blue(c[1]))
                canvas.drawCircle(dx, dy, radius * 0.06f, dotPaint)
            }
        }
    }

    private fun drawCuteFace(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val faceRadius = min(width, height) / 2f * 0.65f

        // Face background
        val faceColor = when (state) {
            State.DISCONNECTED -> 0xFF888899.toInt()
            else -> 0xFF87CEEB.toInt()
        }
        facePaint.color = faceColor
        eyelidPaint.color = faceColor

        // Slight tilt for thinking
        val tiltAngle = if (state == State.THINKING || currentEmotion == "thinking") 5f else 0f
        canvas.save()
        canvas.rotate(tiltAngle, cx, cy)

        canvas.drawCircle(cx, cy, faceRadius, facePaint)

        // Subtle glow
        val glowP = Paint(Paint.ANTI_ALIAS_FLAG)
        glowP.shader = RadialGradient(cx, cy, faceRadius * 1.3f,
            Color.argb(40, 135, 206, 235), Color.TRANSPARENT, Shader.TileMode.CLAMP)
        canvas.drawCircle(cx, cy, faceRadius * 1.3f, glowP)

        val eyeSpacing = faceRadius * 0.35f
        val eyeY = cy - faceRadius * 0.1f
        val baseEyeRadius = faceRadius * 0.22f

        // Eye scale based on state and emotion
        val eyeScale = when {
            currentEmotion == "surprised" -> 1.4f
            currentEmotion == "angry" -> 0.8f
            currentEmotion == "happy" || currentEmotion == "laughing" -> 0.9f
            state == State.LISTENING -> 1.2f
            else -> 1f
        }
        val eyeRadius = baseEyeRadius * eyeScale

        // Pupil size
        val pupilRadius = when {
            state == State.LISTENING -> eyeRadius * 0.55f
            else -> eyeRadius * 0.45f
        }

        // Pupil offset based on state/emotion
        val pOffX = when {
            currentEmotion == "thinking" -> eyeRadius * 0.3f
            currentEmotion == "confused" -> eyeRadius * 0.35f
            state == State.THINKING -> eyeRadius * 0.3f
            state == State.IDLE || state == State.AMBIENT -> lookX * eyeRadius
            else -> 0f
        }
        val pOffY = when {
            currentEmotion == "thinking" -> -eyeRadius * 0.3f
            state == State.THINKING -> -eyeRadius * 0.3f
            state == State.IDLE || state == State.AMBIENT -> lookY * eyeRadius
            else -> 0f
        }

        // Eyelid closure
        val eyelidClose = when {
            state == State.DISCONNECTED -> 0.6f
            isBlinking -> if (blinkPhase < 0.5f) blinkPhase * 2f else (1f - blinkPhase) * 2f
            else -> 0f
        }

        // Check if we need happy-closed eyes (^_^)
        val happyEyes = currentEmotion == "happy" || currentEmotion == "laughing"
        val loveEyes = currentEmotion == "love"

        // Draw eyes
        for (side in listOf(-1f, 1f)) {
            val ex = cx + eyeSpacing * side

            if (happyEyes) {
                // ^_^ eyes - curved arcs
                val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = 0xFF333333.toInt(); style = Paint.Style.STROKE; strokeWidth = 5f; strokeCap = Paint.Cap.ROUND
                }
                val arcRect = RectF(ex - eyeRadius, eyeY - eyeRadius * 0.6f, ex + eyeRadius, eyeY + eyeRadius * 0.6f)
                canvas.drawArc(arcRect, 200f, 140f, false, arcPaint)
            } else if (loveEyes) {
                // Heart eyes
                drawHeart(canvas, ex, eyeY, eyeRadius * 0.8f)
            } else {
                // Normal eyes
                canvas.drawCircle(ex, eyeY, eyeRadius, eyeWhitePaint)
                canvas.drawCircle(ex + pOffX, eyeY + pOffY, pupilRadius, pupilPaint)

                // Eyelid
                if (eyelidClose > 0f) {
                    canvas.save()
                    canvas.clipRect(ex - eyeRadius, eyeY - eyeRadius, ex + eyeRadius, eyeY - eyeRadius + eyeRadius * 2f * eyelidClose)
                    canvas.drawCircle(ex, eyeY, eyeRadius + 2f, eyelidPaint)
                    canvas.restore()
                }
            }
        }

        // Tear for sad emotion
        if (currentEmotion == "sad") {
            val tearX = cx + eyeSpacing + baseEyeRadius * 0.3f
            val tearY = eyeY + baseEyeRadius + 4f
            canvas.drawCircle(tearX, tearY, baseEyeRadius * 0.2f, tearPaint)
            canvas.drawCircle(tearX, tearY + baseEyeRadius * 0.35f, baseEyeRadius * 0.12f, tearPaint)
        }

        // --- Eyebrows ---
        drawEyebrows(canvas, cx, eyeY, eyeSpacing, eyeRadius, faceRadius)

        // --- Blush / Cheeks ---
        val showBlush = state == State.IDLE || state == State.AMBIENT || state == State.SPEAKING ||
            currentEmotion == "happy" || currentEmotion == "laughing" || currentEmotion == "love"
        if (showBlush) {
            val blushAlpha = if (currentEmotion == "laughing" || currentEmotion == "love") 0x60 else 0x40
            blushPaint.color = Color.argb(blushAlpha, 0xFF, 0x6B, 0x8A)
            val blushY = eyeY + eyeRadius * 1.1f
            val blushR = faceRadius * 0.12f
            canvas.drawCircle(cx - eyeSpacing - eyeRadius * 0.3f, blushY, blushR, blushPaint)
            canvas.drawCircle(cx + eyeSpacing + eyeRadius * 0.3f, blushY, blushR, blushPaint)
        }

        // --- Mouth ---
        drawMouth(canvas, cx, cy, faceRadius)

        canvas.restore() // tilt
    }

    private fun drawEyebrows(canvas: Canvas, cx: Float, eyeY: Float, eyeSpacing: Float, eyeRadius: Float, faceRadius: Float) {
        val browY = eyeY - eyeRadius - faceRadius * 0.06f

        when {
            currentEmotion == "angry" -> {
                // Very furrowed, angled down toward center
                for (side in listOf(-1f, 1f)) {
                    val bx = cx + eyeSpacing * side
                    val path = Path()
                    path.moveTo(bx - eyeRadius * 0.8f * side, browY + eyeRadius * 0.3f)
                    path.lineTo(bx + eyeRadius * 0.8f * side, browY - eyeRadius * 0.1f)
                    canvas.drawPath(path, browPaint)
                }
            }
            currentEmotion == "surprised" -> {
                // Very raised
                for (side in listOf(-1f, 1f)) {
                    val bx = cx + eyeSpacing * side
                    val path = Path()
                    path.moveTo(bx - eyeRadius * 0.7f, browY - eyeRadius * 0.5f)
                    path.quadTo(bx, browY - eyeRadius * 0.8f, bx + eyeRadius * 0.7f, browY - eyeRadius * 0.5f)
                    canvas.drawPath(path, browPaint)
                }
            }
            currentEmotion == "confused" -> {
                // One up, one down
                val leftBx = cx - eyeSpacing
                val rightBx = cx + eyeSpacing
                val pathL = Path()
                pathL.moveTo(leftBx - eyeRadius * 0.7f, browY - eyeRadius * 0.4f)
                pathL.quadTo(leftBx, browY - eyeRadius * 0.6f, leftBx + eyeRadius * 0.7f, browY - eyeRadius * 0.4f)
                canvas.drawPath(pathL, browPaint)
                val pathR = Path()
                pathR.moveTo(rightBx - eyeRadius * 0.7f, browY)
                pathR.quadTo(rightBx, browY - eyeRadius * 0.15f, rightBx + eyeRadius * 0.7f, browY)
                canvas.drawPath(pathR, browPaint)
            }
            currentEmotion == "sad" || state == State.DISCONNECTED -> {
                // Drooping brows
                for (side in listOf(-1f, 1f)) {
                    val bx = cx + eyeSpacing * side
                    val path = Path()
                    path.moveTo(bx - eyeRadius * 0.7f * side, browY - eyeRadius * 0.15f)
                    path.quadTo(bx, browY - eyeRadius * 0.05f, bx + eyeRadius * 0.7f * side, browY + eyeRadius * 0.1f)
                    canvas.drawPath(path, browPaint)
                }
            }
            currentEmotion == "thinking" || state == State.THINKING -> {
                // Furrowed, one lower
                val leftBx = cx - eyeSpacing
                val rightBx = cx + eyeSpacing
                val pathL = Path()
                pathL.moveTo(leftBx - eyeRadius * 0.7f, browY - eyeRadius * 0.1f)
                pathL.quadTo(leftBx, browY - eyeRadius * 0.3f, leftBx + eyeRadius * 0.7f, browY + eyeRadius * 0.05f)
                canvas.drawPath(pathL, browPaint)
                val pathR = Path()
                pathR.moveTo(rightBx - eyeRadius * 0.7f, browY + eyeRadius * 0.05f)
                pathR.quadTo(rightBx, browY - eyeRadius * 0.25f, rightBx + eyeRadius * 0.7f, browY - eyeRadius * 0.1f)
                canvas.drawPath(pathR, browPaint)
            }
            state == State.LISTENING -> {
                // Raised (attention)
                for (side in listOf(-1f, 1f)) {
                    val bx = cx + eyeSpacing * side
                    val path = Path()
                    path.moveTo(bx - eyeRadius * 0.7f, browY - eyeRadius * 0.3f)
                    path.quadTo(bx, browY - eyeRadius * 0.55f, bx + eyeRadius * 0.7f, browY - eyeRadius * 0.3f)
                    canvas.drawPath(path, browPaint)
                }
            }
            else -> {
                // Relaxed
                for (side in listOf(-1f, 1f)) {
                    val bx = cx + eyeSpacing * side
                    val path = Path()
                    path.moveTo(bx - eyeRadius * 0.7f, browY - eyeRadius * 0.15f)
                    path.quadTo(bx, browY - eyeRadius * 0.3f, bx + eyeRadius * 0.7f, browY - eyeRadius * 0.15f)
                    canvas.drawPath(path, browPaint)
                }
            }
        }
    }

    private fun drawMouth(canvas: Canvas, cx: Float, cy: Float, faceRadius: Float) {
        val mouthY = cy + faceRadius * 0.35f
        val mouthWidth = faceRadius * 0.3f

        when {
            currentEmotion == "happy" -> {
                // Wide smile
                val path = Path()
                path.moveTo(cx - mouthWidth * 1.2f, mouthY)
                path.quadTo(cx, mouthY + faceRadius * 0.2f, cx + mouthWidth * 1.2f, mouthY)
                canvas.drawPath(path, mouthPaint)
            }
            currentEmotion == "sad" || state == State.DISCONNECTED -> {
                // Sad frown
                val path = Path()
                path.moveTo(cx - mouthWidth, mouthY + faceRadius * 0.05f)
                path.quadTo(cx, mouthY - faceRadius * 0.12f, cx + mouthWidth, mouthY + faceRadius * 0.05f)
                canvas.drawPath(path, mouthPaint)
            }
            currentEmotion == "surprised" -> {
                // Big O
                canvas.drawCircle(cx, mouthY + faceRadius * 0.05f, faceRadius * 0.12f, mouthPaint)
            }
            currentEmotion == "laughing" -> {
                // Big open mouth
                val path = Path()
                path.moveTo(cx - mouthWidth * 1.3f, mouthY)
                path.quadTo(cx, mouthY + faceRadius * 0.3f, cx + mouthWidth * 1.3f, mouthY)
                path.close()
                canvas.drawPath(path, mouthFillPaint)
                canvas.drawPath(path, mouthPaint)
            }
            currentEmotion == "angry" -> {
                // Tight line
                canvas.drawLine(cx - mouthWidth * 0.7f, mouthY, cx + mouthWidth * 0.7f, mouthY, mouthPaint)
            }
            currentEmotion == "confused" -> {
                // Zigzag
                val path = Path()
                path.moveTo(cx - mouthWidth, mouthY)
                path.lineTo(cx - mouthWidth * 0.33f, mouthY - faceRadius * 0.05f)
                path.lineTo(cx + mouthWidth * 0.33f, mouthY + faceRadius * 0.05f)
                path.lineTo(cx + mouthWidth, mouthY)
                canvas.drawPath(path, mouthPaint)
            }
            currentEmotion == "love" -> {
                // Smile
                val path = Path()
                path.moveTo(cx - mouthWidth, mouthY)
                path.quadTo(cx, mouthY + faceRadius * 0.18f, cx + mouthWidth, mouthY)
                canvas.drawPath(path, mouthPaint)
            }
            state == State.SPEAKING -> {
                // Mouth opens/closes with amplitude
                val openAmount = 0.1f + 0.9f * amplitude
                val mouthH = faceRadius * 0.22f * openAmount
                val path = Path()
                path.moveTo(cx - mouthWidth, mouthY)
                path.quadTo(cx, mouthY + mouthH, cx + mouthWidth, mouthY)
                if (openAmount > 0.3f) {
                    path.close()
                    canvas.drawPath(path, mouthFillPaint)
                }
                canvas.drawPath(path, mouthPaint)
            }
            state == State.LISTENING -> {
                // Small O
                canvas.drawCircle(cx, mouthY + faceRadius * 0.03f, faceRadius * 0.07f, mouthPaint)
            }
            state == State.THINKING -> {
                // Straight line
                canvas.drawLine(cx - mouthWidth * 0.6f, mouthY, cx + mouthWidth * 0.6f, mouthY, mouthPaint)
            }
            else -> {
                // IDLE: soft smile
                val path = Path()
                path.moveTo(cx - mouthWidth * 0.8f, mouthY)
                path.quadTo(cx, mouthY + faceRadius * 0.1f, cx + mouthWidth * 0.8f, mouthY)
                canvas.drawPath(path, mouthPaint)
            }
        }
    }

    private fun drawHeart(canvas: Canvas, cx: Float, cy: Float, size: Float) {
        val path = Path()
        path.moveTo(cx, cy + size * 0.5f)
        path.cubicTo(cx - size, cy, cx - size * 0.6f, cy - size * 0.7f, cx, cy - size * 0.3f)
        path.cubicTo(cx + size * 0.6f, cy - size * 0.7f, cx + size, cy, cx, cy + size * 0.5f)
        path.close()
        canvas.drawPath(path, heartPaint)
    }

    override fun onDetachedFromWindow() {
        animator.cancel()
        emotionResetRunnable?.let { emotionHandler.removeCallbacks(it) }
        super.onDetachedFromWindow()
    }
}
