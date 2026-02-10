package com.openclaw.companion.live2d

import android.content.res.AssetManager
import android.util.Log
import com.live2d.sdk.cubism.framework.CubismDefaultParameterId.ParameterId
import com.live2d.sdk.cubism.framework.CubismFramework
import com.live2d.sdk.cubism.framework.CubismModelSettingJson
import com.live2d.sdk.cubism.framework.ICubismModelSetting
import com.live2d.sdk.cubism.framework.effect.CubismBreath
import com.live2d.sdk.cubism.framework.effect.CubismEyeBlink
import com.live2d.sdk.cubism.framework.model.CubismModel
import com.live2d.sdk.cubism.framework.model.CubismUserModel
import com.live2d.sdk.cubism.framework.motion.CubismExpressionMotion
import com.live2d.sdk.cubism.framework.motion.CubismMotion
import com.live2d.sdk.cubism.framework.rendering.android.CubismRendererAndroid
import java.io.ByteArrayOutputStream
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

data class ModelConfig(
    val dir: String,
    val displayName: String,
    val emotionMap: Map<String, String>,
    val stateExpressionMap: Map<String, String>,
    val scale: Float = 1.8f,
    val offsetY: Float = -0.3f
)

class LAppModel : CubismUserModel() {

    companion object {
        private const val TAG = "LAppModel"

        val MODEL_CONFIGS = mapOf(
            "Haru" to ModelConfig(
                dir = "Haru",
                displayName = "Haru",
                emotionMap = mapOf(
                    "happy" to "F05", "angry" to "F02", "sad" to "F03",
                    "surprised" to "F06", "thinking" to "F08", "confused" to "F04",
                    "laughing" to "F07", "neutral" to "F01", "love" to "F07"
                ),
                stateExpressionMap = mapOf(
                    "idle" to "F01", "listening" to "F06", "thinking" to "F08",
                    "speaking" to "F01", "disconnected" to "F03"
                ),
                scale = 1.8f, offsetY = -0.3f
            ),
            "Hiyori" to ModelConfig(
                dir = "Hiyori",
                displayName = "Hiyori",
                emotionMap = emptyMap(), // No expressions
                stateExpressionMap = emptyMap(),
                scale = 1.8f, offsetY = -0.5f
            ),
            "Mark" to ModelConfig(
                dir = "Mark",
                displayName = "Mark",
                emotionMap = emptyMap(),
                stateExpressionMap = emptyMap(),
                scale = 1.8f, offsetY = -0.3f
            ),
            "Natori" to ModelConfig(
                dir = "Natori",
                displayName = "Natori",
                emotionMap = mapOf(
                    "happy" to "Smile", "angry" to "Angry", "sad" to "Sad",
                    "surprised" to "Surprised", "thinking" to "Normal", "confused" to "Normal",
                    "laughing" to "Smile", "neutral" to "Normal", "love" to "Blushing"
                ),
                stateExpressionMap = mapOf(
                    "idle" to "Normal", "listening" to "Surprised", "thinking" to "Normal",
                    "speaking" to "Smile", "disconnected" to "Sad"
                ),
                scale = 1.8f, offsetY = -0.3f
            ),
            "Wanko" to ModelConfig(
                dir = "Wanko",
                displayName = "Wanko",
                emotionMap = emptyMap(),
                stateExpressionMap = emptyMap(),
                scale = 2.5f, offsetY = 0.1f
            ),
            "Mao" to ModelConfig(
                dir = "Mao",
                displayName = "Mao",
                emotionMap = mapOf(
                    "happy" to "exp_02", "angry" to "exp_05", "sad" to "exp_06",
                    "surprised" to "exp_07", "thinking" to "exp_01", "confused" to "exp_03",
                    "laughing" to "exp_04", "neutral" to "exp_03", "love" to "exp_04"
                ),
                stateExpressionMap = mapOf(
                    "idle" to "exp_03", "listening" to "exp_01", "thinking" to "exp_01",
                    "speaking" to "exp_02", "disconnected" to "exp_06"
                ),
                scale = 1.8f, offsetY = -0.3f
            ),
            "Rice" to ModelConfig(
                dir = "Rice",
                displayName = "Rice",
                emotionMap = emptyMap(),
                stateExpressionMap = emptyMap(),
                scale = 2.2f, offsetY = 0.0f
            )
        )

        fun getConfig(modelName: String): ModelConfig {
            return MODEL_CONFIGS[modelName] ?: MODEL_CONFIGS["Haru"]!!
        }
    }

    private var modelDir: String = "Haru"
    private var config: ModelConfig = getConfig("Haru")
    private var modelSetting: ICubismModelSetting? = null
    private val expressions = mutableMapOf<String, CubismExpressionMotion>()
    private val motions = mutableMapOf<String, CubismMotion>()
    private var currentExpression: String? = null
    var isModelLoaded = false
        private set

    // Touch tracking
    private var touchTargetX = 0f
    private var touchTargetY = 0f
    private var isTouching = false

    var lipSyncValue: Float = 0f
    var currentState: String = "idle"
    private var stateTime: Float = 0f
    private var totalTime: Float = 0f

    private var smoothAngleX: Float = 0f
    private var smoothAngleY: Float = 0f
    private var smoothBodyAngleX: Float = 0f
    private var smoothEyeOpenL: Float = 1f
    private var smoothEyeOpenR: Float = 1f

    private var lookTargetX: Float = 0f
    private var lookTargetY: Float = 0f
    private var nextLookChangeTime: Float = 0f

    private var emotionOverride: String? = null
    private var emotionOverrideTime: Float = 0f
    private val EMOTION_DURATION = 5f

    // === Liveliness system ===
    // Micro-movements (subtle random noise)
    private var microNoiseX: Float = 0f
    private var microNoiseY: Float = 0f
    private var microNoisePhase1: Float = Random.nextFloat() * 100f
    private var microNoisePhase2: Float = Random.nextFloat() * 100f
    private var microNoisePhase3: Float = Random.nextFloat() * 100f

    // Quick glances (rapid eye movements)
    private var glanceOffsetX: Float = 0f
    private var glanceOffsetY: Float = 0f
    private var nextGlanceTime: Float = 2f + Random.nextFloat() * 5f
    private var glanceDecayTime: Float = 0f

    // Idle motion cycling
    private var nextIdleMotionTime: Float = 5f + Random.nextFloat() * 8f
    private var currentIdleIndex: Int = 0

    // Idle expression changes (subtle mood shifts)
    private var nextExpressionShiftTime: Float = 8f + Random.nextFloat() * 15f
    private val idleExpressions = listOf("neutral", "happy", "thinking") // Subtle idle moods

    // Touch reactions
    private var touchReactionTime: Float = 0f
    private var touchBlushAmount: Float = 0f

    // Enhanced blink (double blink, varied frequency)  
    private var nextCustomBlinkTime: Float = 3f + Random.nextFloat() * 4f
    private var doDoubleBlink: Boolean = false
    private var doubleBlinkPhase: Int = 0 // 0=none, 1=first blink, 2=pause, 3=second blink
    private var doubleBlinkTimer: Float = 0f

    fun getModelConfig(): ModelConfig = config

    fun loadAssets(assets: AssetManager, modelName: String = "Haru") {
        config = getConfig(modelName)
        modelDir = config.dir
        val modelJson = "$modelDir.model3.json"

        try {
            val settingBytes = readAsset(assets, "$modelDir/$modelJson")
            modelSetting = CubismModelSettingJson(settingBytes)
            val setting = modelSetting ?: return

            // Load moc
            val mocFile = setting.getModelFileName()
            if (mocFile.isNotEmpty()) {
                loadModel(readAsset(assets, "$modelDir/$mocFile"))
            }

            // Load expressions
            for (i in 0 until setting.getExpressionCount()) {
                val name = setting.getExpressionName(i)
                val file = setting.getExpressionFileName(i)
                val exp = loadExpression(readAsset(assets, "$modelDir/$file"))
                if (exp != null) {
                    expressions[name] = exp as CubismExpressionMotion
                }
            }

            // Load physics
            val physicsFile = setting.getPhysicsFileName()
            if (!physicsFile.isNullOrEmpty()) {
                loadPhysics(readAsset(assets, "$modelDir/$physicsFile"))
            }

            // Load pose
            val poseFile = setting.getPoseFileName()
            if (!poseFile.isNullOrEmpty()) {
                loadPose(readAsset(assets, "$modelDir/$poseFile"))
            }

            // User data
            val userDataFile = setting.getUserDataFile()
            if (!userDataFile.isNullOrEmpty()) {
                loadUserData(readAsset(assets, "$modelDir/$userDataFile"))
            }

            // Eye blink
            if (setting.getEyeBlinkParameterCount() > 0) {
                eyeBlink = CubismEyeBlink.create(setting)
            }

            // Breathing
            breath = CubismBreath.create()
            val idm = CubismFramework.getIdManager()
            breath.setParameters(listOf(
                CubismBreath.BreathParameterData(idm.getId(ParameterId.ANGLE_X.id), 0f, 15f, 6.5345f, 0.5f),
                CubismBreath.BreathParameterData(idm.getId(ParameterId.ANGLE_Y.id), 0f, 8f, 3.5345f, 0.5f),
                CubismBreath.BreathParameterData(idm.getId(ParameterId.ANGLE_Z.id), 0f, 10f, 5.5345f, 0.5f),
                CubismBreath.BreathParameterData(idm.getId(ParameterId.BODY_ANGLE_X.id), 0f, 4f, 15.5345f, 0.5f),
                CubismBreath.BreathParameterData(idm.getId(ParameterId.BREATH.id), 0.5f, 0.5f, 3.2345f, 0.5f)
            ))

            // Load motions
            for (g in 0 until setting.getMotionGroupCount()) {
                val groupName = setting.getMotionGroupName(g)
                for (i in 0 until setting.getMotionCount(groupName)) {
                    val file = setting.getMotionFileName(groupName, i)
                    if (!file.isNullOrEmpty()) {
                        try {
                            val motion = loadMotion(readAsset(assets, "$modelDir/$file"))
                            if (motion != null) {
                                val fadeIn = setting.getMotionFadeInTimeValue(groupName, i)
                                val fadeOut = setting.getMotionFadeOutTimeValue(groupName, i)
                                if (fadeIn >= 0) motion.setFadeInTime(fadeIn)
                                if (fadeOut >= 0) motion.setFadeOutTime(fadeOut)
                                motions["${groupName}_$i"] = motion
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "Failed to load motion $file", e)
                        }
                    }
                }
            }

            // Renderer
            setupRenderer(CubismRendererAndroid.create())

            isModelLoaded = true
            Log.i(TAG, "Model '$modelName' loaded. Expressions: ${expressions.keys}, Motions: ${motions.keys}")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load model '$modelName'", e)
        }
    }

    fun getTextureCount(): Int = modelSetting?.getTextureCount() ?: 0

    fun getTextureFileName(index: Int): String {
        val file = modelSetting?.getTextureFileName(index) ?: return ""
        return "$modelDir/$file"
    }

    fun setEmotion(emotionName: String) {
        if (config.emotionMap.isEmpty()) return
        val expName = config.emotionMap[emotionName] ?: config.emotionMap["neutral"] ?: return
        emotionOverride = expName
        emotionOverrideTime = EMOTION_DURATION
        applyExpression(expName)
    }

    fun onStateChanged(state: String) {
        if (currentState != state) {
            currentState = state
            stateTime = 0f
            if (emotionOverrideTime <= 0f && config.stateExpressionMap.isNotEmpty()) {
                val expName = config.stateExpressionMap[state] ?: return
                applyExpression(expName)
            }
        }
    }

    private fun applyExpression(expName: String) {
        val exp = expressions[expName]
        if (exp != null && currentExpression != expName) {
            expressionManager.startMotion(exp)
            currentExpression = expName
        }
    }

    // Motion triggering API
    fun playMotion(group: String, index: Int) {
        val key = "${group}_$index"
        val motion = motions[key]
        if (motion != null) {
            motionManager.startMotion(motion)
            Log.d(TAG, "Playing motion: $key")
        } else {
            Log.w(TAG, "Motion not found: $key")
        }
    }

    fun playRandomMotion(group: String) {
        val groupMotions = motions.keys.filter { it.startsWith("${group}_") }
        if (groupMotions.isNotEmpty()) {
            val key = groupMotions.random()
            motions[key]?.let { motionManager.startMotion(it) }
        }
    }

    fun getAvailableMotionGroups(): List<String> {
        return motions.keys.map { it.substringBeforeLast("_") }.distinct()
    }

    fun getMotionCount(group: String): Int {
        return motions.keys.count { it.startsWith("${group}_") }
    }

    // Touch tracking
    fun setTouchPosition(normalizedX: Float, normalizedY: Float) {
        touchTargetX = normalizedX
        touchTargetY = normalizedY
        isTouching = true
    }

    fun onTouchDown() {
        // React to being touched — blush + surprised expression briefly
        touchReactionTime = 1.5f
        if (config.emotionMap.isNotEmpty() && emotionOverride == null) {
            // Brief surprised/blush reaction
            val blushExp = config.emotionMap["love"] ?: config.emotionMap["surprised"]
            if (blushExp != null) {
                applyExpression(blushExp)
                // Short override so it goes back to normal
                emotionOverride = blushExp
                emotionOverrideTime = 2f
            }
        }
    }

    fun clearTouch() {
        isTouching = false
    }

    fun startIdleMotion() {
        val motion = motions["Idle_0"]
        if (motion != null) {
            motionManager.startMotion(motion)
        }
    }

    fun updateModel(deltaTimeSec: Float) {
        if (!isModelLoaded) return
        val m = model ?: return
        val idm = CubismFramework.getIdManager()

        totalTime += deltaTimeSec
        stateTime += deltaTimeSec

        // Decay emotion override
        if (emotionOverrideTime > 0f) {
            emotionOverrideTime -= deltaTimeSec
            if (emotionOverrideTime <= 0f) {
                emotionOverride = null
                if (config.stateExpressionMap.isNotEmpty()) {
                    val expName = config.stateExpressionMap[currentState] ?: return
                    applyExpression(expName)
                }
            }
        }

        // === MICRO-MOVEMENTS: Subtle organic noise on head/body ===
        microNoisePhase1 += deltaTimeSec * 1.7f
        microNoisePhase2 += deltaTimeSec * 2.3f
        microNoisePhase3 += deltaTimeSec * 0.9f
        microNoiseX = sin(microNoisePhase1) * 0.8f + sin(microNoisePhase2 * 1.3f) * 0.4f + sin(microNoisePhase3 * 2.7f) * 0.2f
        microNoiseY = cos(microNoisePhase1 * 0.8f) * 0.6f + sin(microNoisePhase2 * 0.7f) * 0.3f

        // === QUICK GLANCES: Rapid eye movements ===
        if (totalTime >= nextGlanceTime && !isTouching) {
            glanceOffsetX = (Random.nextFloat() * 2f - 1f) * 0.4f  // Quick look to side
            glanceOffsetY = (Random.nextFloat() - 0.3f) * 0.3f
            glanceDecayTime = 0.15f + Random.nextFloat() * 0.2f  // Glance lasts 150-350ms
            nextGlanceTime = totalTime + 3f + Random.nextFloat() * 7f
        }
        if (glanceDecayTime > 0f) {
            glanceDecayTime -= deltaTimeSec
            if (glanceDecayTime <= 0f) {
                glanceOffsetX = 0f
                glanceOffsetY = 0f
            }
        }

        // === IDLE MOTION CYCLING: Rotate through idle animations ===
        if (currentState == "idle" && totalTime >= nextIdleMotionTime) {
            val idleCount = getMotionCount("Idle")
            if (idleCount > 1) {
                currentIdleIndex = (currentIdleIndex + 1) % idleCount
            }
            playMotion("Idle", currentIdleIndex)
            nextIdleMotionTime = totalTime + 6f + Random.nextFloat() * 10f
        }

        // === IDLE EXPRESSION SHIFTS: Subtle mood changes ===
        if (currentState == "idle" && emotionOverride == null && config.emotionMap.isNotEmpty() 
            && totalTime >= nextExpressionShiftTime) {
            val mood = idleExpressions[Random.nextInt(idleExpressions.size)]
            val expName = config.emotionMap[mood]
            if (expName != null) {
                applyExpression(expName)
            }
            nextExpressionShiftTime = totalTime + 10f + Random.nextFloat() * 20f
        }

        // === TOUCH REACTION: Blush decay ===
        if (touchReactionTime > 0f) {
            touchReactionTime -= deltaTimeSec
            touchBlushAmount = (touchReactionTime / 1.5f).coerceIn(0f, 1f) * 0.6f
        }

        // === DOUBLE BLINK ===
        if (totalTime >= nextCustomBlinkTime && doubleBlinkPhase == 0) {
            doDoubleBlink = Random.nextFloat() < 0.3f  // 30% chance of double blink
            if (doDoubleBlink) {
                doubleBlinkPhase = 1
                doubleBlinkTimer = 0f
            }
            nextCustomBlinkTime = totalTime + 2f + Random.nextFloat() * 5f
        }
        if (doubleBlinkPhase > 0) {
            doubleBlinkTimer += deltaTimeSec
            when (doubleBlinkPhase) {
                1 -> if (doubleBlinkTimer > 0.1f) { doubleBlinkPhase = 2; doubleBlinkTimer = 0f }
                2 -> if (doubleBlinkTimer > 0.08f) { doubleBlinkPhase = 3; doubleBlinkTimer = 0f }
                3 -> if (doubleBlinkTimer > 0.1f) { doubleBlinkPhase = 0; doubleBlinkTimer = 0f }
            }
        }

        // Random look direction
        if (totalTime >= nextLookChangeTime) {
            lookTargetX = Random.nextFloat() * 2f - 1f
            lookTargetY = Random.nextFloat() * 1.5f - 0.5f
            nextLookChangeTime = totalTime + 2f + Random.nextFloat() * 3f
        }

        val (targetAngleX, targetAngleY, targetBodyX, targetEyeL, targetEyeR) = when (currentState) {
            "listening" -> {
                val tilt = sin(stateTime * 0.8f) * 3f + microNoiseX
                StateParams(tilt, 5f + sin(stateTime * 1.2f) * 2f + microNoiseY, tilt * 0.3f, 1.15f, 1.15f)
            }
            "thinking" -> {
                val drift = sin(stateTime * 0.5f) * 5f
                StateParams(10f + drift + microNoiseX, 8f + sin(stateTime * 0.7f) * 3f + microNoiseY, 3f + drift * 0.2f, 0.75f, 0.65f)
            }
            "speaking" -> {
                val energy = lipSyncValue * 0.5f + 0.5f
                if (isTouching) {
                    val touchAngleX = touchTargetX * 20f + sin(stateTime * 2.5f) * 3f * energy + microNoiseX
                    val touchAngleY = touchTargetY * 20f + microNoiseY
                    val bodySway = touchTargetX * 5f + sin(stateTime * 1.3f) * 2f * energy
                    StateParams(touchAngleX, touchAngleY, bodySway, 1.0f, 1.0f)
                } else {
                    val headBob = sin(stateTime * 2.5f) * 5f * energy + microNoiseX
                    val bodySway = sin(stateTime * 1.3f) * 3f * energy
                    StateParams(headBob + lookTargetX * 5f, sin(stateTime * 1.8f) * 4f + microNoiseY, bodySway, 1.0f, 1.0f)
                }
            }
            "disconnected" -> {
                StateParams(sin(stateTime * 0.3f) * 2f + microNoiseX * 0.3f, -5f + microNoiseY * 0.3f, 0f, 0.4f, 0.4f)
            }
            else -> { // idle
                if (isTouching) {
                    val touchAngleX = touchTargetX * 30f + microNoiseX
                    val touchAngleY = touchTargetY * 30f + microNoiseY
                    val touchBodyX = touchTargetX * 10f
                    StateParams(touchAngleX, touchAngleY, touchBodyX, 1.0f, 1.0f)
                } else {
                    val gentleX = lookTargetX * 8f + sin(stateTime * 0.6f) * 3f + microNoiseX * 1.5f
                    val gentleY = lookTargetY * 5f + sin(stateTime * 0.4f) * 2f + microNoiseY
                    val bodyDrift = sin(stateTime * 0.3f) * 2f + microNoiseX * 0.3f
                    StateParams(gentleX, gentleY, bodyDrift, 1.0f, 1.0f)
                }
            }
        }

        val lerpSpeed = 3f * deltaTimeSec
        smoothAngleX += (targetAngleX - smoothAngleX) * lerpSpeed
        smoothAngleY += (targetAngleY - smoothAngleY) * lerpSpeed
        smoothBodyAngleX += (targetBodyX - smoothBodyAngleX) * lerpSpeed
        smoothEyeOpenL += (targetEyeL - smoothEyeOpenL) * lerpSpeed * 2f
        smoothEyeOpenR += (targetEyeR - smoothEyeOpenR) * lerpSpeed * 2f

        m.loadParameters()
        val motionUpdated = motionManager.updateMotion(m, deltaTimeSec)
        if (!motionUpdated) startIdleMotion()
        m.saveParameters()

        expressionManager.updateMotion(m, deltaTimeSec)

        // Enhanced blink with double-blink support
        if (currentState != "thinking" && currentState != "disconnected") {
            eyeBlink?.updateParameters(m, deltaTimeSec)
            // Double blink override
            if (doubleBlinkPhase == 1 || doubleBlinkPhase == 3) {
                m.setParameterValue(idm.getId(ParameterId.EYE_L_OPEN.id), 0f)
                m.setParameterValue(idm.getId(ParameterId.EYE_R_OPEN.id), 0f)
            }
        }

        breath?.updateParameters(m, deltaTimeSec)
        physics?.evaluate(m, deltaTimeSec)
        pose?.updateParameters(m, deltaTimeSec)

        m.addParameterValue(idm.getId(ParameterId.ANGLE_X.id), smoothAngleX, 0.6f)
        m.addParameterValue(idm.getId(ParameterId.ANGLE_Y.id), smoothAngleY, 0.6f)
        m.addParameterValue(idm.getId(ParameterId.BODY_ANGLE_X.id), smoothBodyAngleX, 0.5f)

        m.addParameterValue(idm.getId(ParameterId.EYE_L_OPEN.id), smoothEyeOpenL - 1.0f, 0.4f)
        m.addParameterValue(idm.getId(ParameterId.EYE_R_OPEN.id), smoothEyeOpenR - 1.0f, 0.4f)

        // Eye ball follows head + quick glances
        val eyeBallX = smoothAngleX / 30f + glanceOffsetX
        val eyeBallY = smoothAngleY / 30f + glanceOffsetY
        m.addParameterValue(idm.getId(ParameterId.EYE_BALL_X.id), eyeBallX, 0.3f)
        m.addParameterValue(idm.getId(ParameterId.EYE_BALL_Y.id), eyeBallY, 0.3f)

        if (lipSync) {
            val lipSyncN = modelSetting?.getLipSyncParameterCount() ?: 0
            for (i in 0 until lipSyncN) {
                val paramId = modelSetting?.getLipSyncParameterId(i)
                if (paramId != null) {
                    m.addParameterValue(paramId, lipSyncValue, 0.8f)
                }
            }
            m.addParameterValue(idm.getId(ParameterId.MOUTH_OPEN_Y.id), lipSyncValue * 0.7f, 0.5f)
        }

        m.update()
    }

    fun getModelInstance(): CubismModel? = model

    private fun readAsset(assets: AssetManager, path: String): ByteArray {
        val stream = assets.open(path)
        val buffer = ByteArrayOutputStream()
        val data = ByteArray(4096)
        var count: Int
        while (stream.read(data).also { count = it } != -1) {
            buffer.write(data, 0, count)
        }
        stream.close()
        return buffer.toByteArray()
    }

    private data class StateParams(
        val angleX: Float, val angleY: Float, val bodyX: Float,
        val eyeL: Float, val eyeR: Float
    )
}
