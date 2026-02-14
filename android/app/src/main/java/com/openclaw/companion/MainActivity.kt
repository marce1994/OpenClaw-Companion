package com.openclaw.companion

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.media.AudioManager
import android.media.audiofx.NoiseSuppressor
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.net.Uri
import android.provider.MediaStore
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import android.content.BroadcastReceiver
import android.content.IntentFilter
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import io.noties.markwon.Markwon
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit
import android.media.audiofx.Visualizer
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import com.openclaw.companion.live2d.Live2DView

data class EmotionCue(val startMs: Long, val endMs: Long, val text: String, val emotion: String)
data class AudioChunk(val audioB64: String, val emotion: String, val text: String, val index: Int)

class MainActivity : Activity() {

    // Orb mode views
    private lateinit var orbModeLayout: View
    private lateinit var orbView: OrbView
    private lateinit var btnTalk: ImageButton
    private lateinit var btnKeyboard: ImageButton
    private lateinit var btnSettings: ImageButton
    private lateinit var btnCancelProcess: ImageButton
    private lateinit var txtStatus: TextView
    private lateinit var txtTranscript: TextView
    private lateinit var txtReply: TextView
    private lateinit var txtSwipeCancel: TextView

    // Live2D mode views
    private lateinit var live2dModeLayout: View
    private lateinit var live2dView: Live2DView
    private lateinit var videoBackground: android.widget.VideoView
    private lateinit var btnTalkL2d: ImageButton
    private lateinit var btnKeyboardL2d: ImageButton
    private lateinit var btnSettingsL2d: ImageButton
    private lateinit var btnCancelProcessL2d: ImageButton
    private lateinit var txtStatusL2d: TextView
    // txtTranscriptL2d and txtReplyL2d removed — chat now uses RecyclerView in L2D mode
    private lateinit var txtSwipeCancelL2d: TextView

    // Chat RecyclerView
    private lateinit var chatRecyclerView: RecyclerView
    private lateinit var chatRecyclerViewL2d: RecyclerView
    private lateinit var chatAdapter: ChatAdapter
    private lateinit var chatAdapterL2d: ChatAdapter
    private val chatMessages = mutableListOf<ChatMessage>()
    private lateinit var markwon: Markwon
    private lateinit var btnAttach: ImageButton
    private var accumulatedReplyText = StringBuilder()
    private var showL2dChat: (() -> Unit)? = null

    // Smart Listen Mode
    private var listenMode = "push_to_talk" // "push_to_talk" or "smart_listen"
    private var isSmartListening = false
    @Volatile private var smartPaused = false // Pause during AI response/playback
    private var smartRecordThread: Thread? = null
    private var smartAudioRecord: AudioRecord? = null
    private val SILENCE_THRESHOLD_RMS = 300f    // Below this = silence (server filters hallucinations now)
    private val BARGEIN_THRESHOLD_RMS = 1500f  // Higher threshold to barge-in during playback (avoid echo)
    private val SILENCE_DURATION_MS = 1200L     // 1.2s silence = end of speech
    private val MIN_SPEECH_DURATION_MS = 600L   // Min 600ms to count as speech (filters noise bursts)
    private val MAX_SEGMENT_MS = 15000L         // Max 15s per segment
    private lateinit var spinnerListenMode: Spinner
    private val listenModeOptions = arrayOf("Push to Talk", "Smart Listen")

    companion object {
        const val PICK_IMAGE_REQUEST = 100
        const val PICK_FILE_REQUEST = 101
    }

    // Text input bar
    private lateinit var textInputBar: View
    private lateinit var edtMessage: EditText
    private lateinit var btnSendText: ImageButton
    private lateinit var btnTextToVoice: ImageButton
    private var isTextMode = false

    // Conversation history indicator
    private lateinit var txtHistoryCount: TextView

    // Shared views
    private lateinit var connectionDot: View
    private lateinit var btnCancelSettings: Button
    private lateinit var edtServer: EditText
    private lateinit var edtToken: EditText
    private lateinit var edtBotName: EditText
    private lateinit var btnSave: Button
    private lateinit var swAutoPlay: android.widget.Switch
    private lateinit var swVibrate: android.widget.Switch
    private lateinit var settingsPanel: View
    private lateinit var spinnerSkin: Spinner
    private lateinit var spinnerTtsEngine: Spinner
    private val ttsEngineOptions = listOf("🔊 Kokoro (Local GPU)", "☁️ Edge TTS (Cloud)", "🎙️ XTTS v2 (Voice Clone)")
    private val ttsEngineIds = listOf("kokoro", "edge", "xtts")
    private lateinit var prefs: SharedPreferences

    private var webSocket: WebSocket? = null
    private var isConnected = false
    private var isRecording = false
    private var audioRecord: AudioRecord? = null
    private var recordingThread: Thread? = null
    private var audioData = ByteArrayOutputStream()
    private var hasReceivedAudio = false
    private var waitingForResponse = false
    private var reconnectDelay = 1000L
    private var pingRunnable: Runnable? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var toneGenerator: ToneGenerator? = null
    private var headsetRecording = false
    private var mediaPlayer: MediaPlayer? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var gainControl: AutomaticGainControl? = null
    private var mediaButtonReceiver: BroadcastReceiver? = null
    private var visualizer: Visualizer? = null

    // Swipe to cancel
    private var touchStartX = 0f
    private var swipeCancelled = false
    private val swipeThresholdDp = 100f

    private var currentUiState = "idle"
    private val audioChunkQueue = java.util.concurrent.ConcurrentLinkedQueue<AudioChunk>()
    private var isPlayingChunks = false
    private var streamComplete = false
    private val pendingEmotionCues = mutableListOf<EmotionCue>()
    private var emotionCueRunnable: Runnable? = null

    // Skin system: first 6 are orb skins, last 5 are Live2D models
    private val skinOptions = arrayOf("Default", "Jarvis", "Fuego", "Matrix", "Cósmico", "Cute", "Haru", "Hiyori", "Mao", "Mark", "Natori", "Rice", "Wanko")
    private val live2dSkins = setOf("Haru", "Hiyori", "Mao", "Mark", "Natori", "Rice", "Wanko")
    private var isLive2DActive = false

    private val sampleRate = 16000
    private val channelConfig = AudioFormat.CHANNEL_IN_MONO
    private val audioFormat = AudioFormat.ENCODING_PCM_16BIT
    private val handler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private fun getBotName(): String {
        return prefs.getString("bot_name", "Jarvis") ?: "Jarvis"
    }

    private fun dpToPx(dp: Float): Float {
        return dp * resources.displayMetrics.density
    }

    // Active view helpers - route to correct layout
    private fun getActiveTalkBtn(): ImageButton = if (isLive2DActive) btnTalkL2d else btnTalk
    private fun getActiveSwipeCancel(): TextView = if (isLive2DActive) txtSwipeCancelL2d else txtSwipeCancel

    private fun applySkin(skin: String) {
        if (skin in live2dSkins) {
            isLive2DActive = true
            orbModeLayout.visibility = View.GONE
            live2dModeLayout.visibility = View.VISIBLE
            live2dView.setModelName(skin)
        } else {
            isLive2DActive = false
            live2dModeLayout.visibility = View.GONE
            orbModeLayout.visibility = View.VISIBLE
            orbView.setSkin(skin)
        }
    }

    private fun setActiveState(state: OrbView.State) {
        if (isLive2DActive) {
            live2dView.setState(state)
        } else {
            orbView.setState(state)
        }
    }

    private fun setActiveAmplitude(amp: Float) {
        if (isLive2DActive) {
            live2dView.setAmplitude(amp)
        } else {
            orbView.setAmplitude(amp)
        }
    }

    private fun setActiveEmotion(emotion: String) {
        if (isLive2DActive) {
            live2dView.setEmotion(emotion)
        } else {
            orbView.setEmotion(emotion)
        }
    }

    private fun setStatusText(text: String) {
        if (isLive2DActive) {
            txtStatusL2d.text = text
        }
        txtStatus.text = text
    }

    private fun setTranscriptText(text: String) {
        txtTranscript.text = text
    }

    private fun setReplyText(text: String) {
        txtReply.text = text
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
        )

        setContentView(R.layout.activity_main)

        // Orb mode views
        orbModeLayout = findViewById(R.id.orbModeLayout)
        orbView = findViewById(R.id.orbView)
        btnTalk = findViewById(R.id.btnTalk)
        btnKeyboard = findViewById(R.id.btnKeyboard)
        btnSettings = findViewById(R.id.btnSettings)
        btnCancelProcess = findViewById(R.id.btnCancelProcess)
        txtStatus = findViewById(R.id.txtStatus)
        txtTranscript = findViewById(R.id.txtTranscript)
        txtReply = findViewById(R.id.txtReply)
        txtSwipeCancel = findViewById(R.id.txtSwipeCancel)

        // Live2D mode views
        live2dModeLayout = findViewById(R.id.live2dModeLayout)
        live2dView = findViewById(R.id.live2dView)
        videoBackground = findViewById(R.id.videoBackground)
        setupVideoBackground()
        live2dView.startRendering()
        btnTalkL2d = findViewById(R.id.btnTalkL2d)
        btnKeyboardL2d = findViewById(R.id.btnKeyboardL2d)
        btnSettingsL2d = findViewById(R.id.btnSettingsL2d)
        btnCancelProcessL2d = findViewById(R.id.btnCancelProcessL2d)
        txtStatusL2d = findViewById(R.id.txtStatusL2d)
        // txtTranscriptL2d/txtReplyL2d removed — L2D uses chatRecyclerViewL2d
        txtSwipeCancelL2d = findViewById(R.id.txtSwipeCancelL2d)

        // Shared views
        connectionDot = findViewById(R.id.connectionDot)
        edtServer = findViewById(R.id.edtServer)
        edtToken = findViewById(R.id.edtToken)
        edtBotName = findViewById(R.id.edtBotName)
        btnSave = findViewById(R.id.btnSave)
        settingsPanel = findViewById(R.id.settingsPanel)
        swAutoPlay = findViewById(R.id.swAutoPlay)
        swVibrate = findViewById(R.id.swVibrate)
        spinnerSkin = findViewById(R.id.spinnerSkin)
        btnCancelSettings = findViewById(R.id.btnCancelSettings)

        txtHistoryCount = findViewById(R.id.txtHistoryCount)
        txtHistoryCount.setOnLongClickListener {
            clearConversationHistory()
            true
        }

        prefs = getSharedPreferences("openclaw_companion", MODE_PRIVATE)
        edtServer.setText(prefs.getString("server_url", "ws://100.121.248.113:3200"))
        edtToken.setText(prefs.getString("auth_token", "jarvis-voice-2026"))
        edtBotName.setText(getBotName())
        swAutoPlay.isChecked = prefs.getBoolean("auto_play", true)
        swVibrate.isChecked = prefs.getBoolean("vibrate", true)

        // Skin spinner setup
        val skinAdapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, skinOptions)
        skinAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        spinnerSkin.adapter = skinAdapter
        val savedSkin = prefs.getString("skin", "Default") ?: "Default"
        val skinIndex = skinOptions.indexOf(savedSkin)
        if (skinIndex >= 0) spinnerSkin.setSelection(skinIndex)
        applySkin(savedSkin)

        spinnerSkin.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val skin = skinOptions[position]
                applySkin(skin)
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        // Listen mode spinner
        spinnerListenMode = findViewById(R.id.spinnerListenMode)
        val listenModeAdapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, listenModeOptions)
        listenModeAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        spinnerListenMode.adapter = listenModeAdapter
        val savedMode = prefs.getString("listen_mode", "push_to_talk") ?: "push_to_talk"
        listenMode = savedMode
        spinnerListenMode.setSelection(if (savedMode == "smart_listen") 1 else 0)

        // TTS Engine spinner
        spinnerTtsEngine = findViewById(R.id.spinnerTtsEngine)
        val ttsEngineAdapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, ttsEngineOptions)
        ttsEngineAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        spinnerTtsEngine.adapter = ttsEngineAdapter
        val savedEngine = prefs.getString("tts_engine", "kokoro") ?: "kokoro"
        val engineIdx = ttsEngineIds.indexOf(savedEngine)
        if (engineIdx >= 0) spinnerTtsEngine.setSelection(engineIdx)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        }

        // Setup touch listeners for both mic buttons
        setupMicButton(btnTalk)
        setupMicButton(btnTalkL2d)

        // Cancel processing buttons
        btnCancelProcess.setOnClickListener { cancelProcessing() }
        btnCancelProcessL2d.setOnClickListener { cancelProcessing() }

        // Text input bar
        textInputBar = findViewById(R.id.textInputBar)
        edtMessage = findViewById(R.id.edtMessage)
        btnSendText = findViewById(R.id.btnSendText)
        btnTextToVoice = findViewById(R.id.btnTextToVoice)

        // Chat RecyclerView setup
        markwon = Markwon.create(this)
        chatRecyclerView = findViewById(R.id.chatRecyclerView)
        chatAdapter = ChatAdapter(chatMessages, markwon) { buttonValue ->
            sendWs(JSONObject().put("type", "text").put("text", buttonValue))
            addChatMessage(ChatMessage(role = "user", text = buttonValue))
        }
        chatRecyclerView.layoutManager = LinearLayoutManager(this).apply {
            stackFromEnd = true
        }
        chatRecyclerView.adapter = chatAdapter

        // Live2D chat recycler (shares same data)
        chatRecyclerViewL2d = findViewById(R.id.chatRecyclerViewL2d)
        chatAdapterL2d = ChatAdapter(chatMessages, markwon, transparent = true) { buttonValue ->
            sendWs(JSONObject().put("type", "text").put("text", buttonValue.toString()))
            addChatMessage(ChatMessage(role = "user", text = buttonValue.toString()))
        }
        chatRecyclerViewL2d.layoutManager = LinearLayoutManager(this).apply {
            stackFromEnd = true
        }
        chatRecyclerViewL2d.adapter = chatAdapterL2d

        // Auto-fade: each bubble fades out after 5s, scroll reveals all temporarily
        val fadeDelayMs = 5000L
        val fadeHandler = android.os.Handler(mainLooper)
        var l2dScrollRevealed = false
        var l2dScrollHideRunnable: Runnable? = null

        // Schedule fade for a single child view
        fun scheduleFade(child: android.view.View) {
            fadeHandler.postDelayed({
                if (!l2dScrollRevealed) {
                    child.animate().alpha(0f).setDuration(600).start()
                }
            }, fadeDelayMs)
        }

        // When a new item is added to L2D RecyclerView, auto-fade it
        chatRecyclerViewL2d.addOnChildAttachStateChangeListener(object : RecyclerView.OnChildAttachStateChangeListener {
            override fun onChildViewAttachedToWindow(view: android.view.View) {
                if (!l2dScrollRevealed) {
                    view.alpha = 1f
                    scheduleFade(view)
                }
            }
            override fun onChildViewDetachedFromWindow(view: android.view.View) {}
        })

        // Scroll reveals all bubbles, then hides after 4s of no scroll
        chatRecyclerViewL2d.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
                if (newState == RecyclerView.SCROLL_STATE_DRAGGING) {
                    l2dScrollRevealed = true
                    l2dScrollHideRunnable?.let { fadeHandler.removeCallbacks(it) }
                    for (i in 0 until rv.childCount) {
                        rv.getChildAt(i).animate().alpha(1f).setDuration(200).start()
                    }
                } else if (newState == RecyclerView.SCROLL_STATE_IDLE && l2dScrollRevealed) {
                    val hideRunnable = Runnable {
                        l2dScrollRevealed = false
                        for (i in 0 until rv.childCount) {
                            rv.getChildAt(i).animate().alpha(0f).setDuration(600).start()
                        }
                    }
                    l2dScrollHideRunnable = hideRunnable
                    fadeHandler.postDelayed(hideRunnable, 4000)
                }
            }
        })
        // No showL2dChat on new messages — only scroll reveals
        this.showL2dChat = null

        // Attach button
        btnAttach = findViewById(R.id.btnAttach)
        btnAttach.setOnClickListener { showAttachmentOptions() }

        // Keyboard buttons → enter text mode
        btnKeyboard.setOnClickListener { enterTextMode() }
        btnKeyboardL2d.setOnClickListener { enterTextMode() }

        // Voice button in text bar → exit text mode
        btnTextToVoice.setOnClickListener { exitTextMode() }

        // Send button
        btnSendText.setOnClickListener { sendTextMessage() }

        // Enter key sends
        edtMessage.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendTextMessage()
                true
            } else false
        }

        // Settings buttons
        btnSettings.setOnClickListener { settingsPanel.visibility = View.VISIBLE }
        btnSettingsL2d.setOnClickListener { settingsPanel.visibility = View.VISIBLE }

        btnCancelSettings.setOnClickListener { settingsPanel.visibility = View.GONE }

        btnSave.setOnClickListener {
            val botName = edtBotName.text.toString().trim().ifEmpty { "Assistant" }
            val selectedSkin = skinOptions[spinnerSkin.selectedItemPosition]
            prefs.edit()
                .putString("server_url", edtServer.text.toString().trim())
                .putString("auth_token", edtToken.text.toString().trim())
                .putString("bot_name", botName)
                .putBoolean("auto_play", swAutoPlay.isChecked)
                .putBoolean("vibrate", swVibrate.isChecked)
                .putString("skin", selectedSkin)
                .putString("listen_mode", if (spinnerListenMode.selectedItemPosition == 1) "smart_listen" else "push_to_talk")
                .putString("tts_engine", ttsEngineIds[spinnerTtsEngine.selectedItemPosition])
                .apply()
            // Send TTS engine change to server
            val selectedEngine = ttsEngineIds[spinnerTtsEngine.selectedItemPosition]
            webSocket?.send("""{"type":"set_tts_engine","engine":"$selectedEngine"}""")
            val newMode = if (spinnerListenMode.selectedItemPosition == 1) "smart_listen" else "push_to_talk"
            val modeChanged = listenMode != newMode
            listenMode = newMode
            settingsPanel.visibility = View.GONE
            Toast.makeText(this, getString(R.string.toast_saved), Toast.LENGTH_SHORT).show()
            startVoiceService()
            webSocket?.close(1000, "Settings changed")
            connectWebSocket()
            if (modeChanged) applyListenMode()
        }

        setActiveState(OrbView.State.DISCONNECTED)
        setConnectionStatus("disconnected")
        startVoiceService()
        acquireWakeLock()
        requestBatteryOptimizationExemption()
        toneGenerator = try { ToneGenerator(AudioManager.STREAM_SYSTEM, 40) } catch (e: Exception) { null }
        connectWebSocket()

        handleMediaIntent(intent)

        mediaButtonReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == "com.openclaw.companion.MEDIA_BUTTON_TOGGLE") {
                    if (!isRecording) {
                        headsetRecording = true
                        startRecording()
                    } else if (headsetRecording) {
                        headsetRecording = false
                        stopRecordingAndSend()
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction("com.openclaw.companion.MEDIA_BUTTON_TOGGLE")
        }
        LocalBroadcastManager.getInstance(this).registerReceiver(mediaButtonReceiver!!, filter)
    }

    private fun setupMicButton(btn: ImageButton) {
        btn.setOnTouchListener { v, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    touchStartX = event.rawX
                    swipeCancelled = false
                    startRecording()
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (isRecording && !swipeCancelled) {
                        val dx = touchStartX - event.rawX
                        val thresholdPx = dpToPx(swipeThresholdDp)
                        if (dx > thresholdPx) {
                            swipeCancelled = true
                            cancelRecording()
                        } else if (dx > dpToPx(20f)) {
                            val progress = (dx / thresholdPx).coerceIn(0f, 1f)
                            val red = (0xAA + (0xFF - 0xAA) * progress).toInt()
                            getActiveSwipeCancel().setTextColor(android.graphics.Color.rgb(red, (0xAA * (1 - progress)).toInt(), (0xAA * (1 - progress)).toInt()))
                        }
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!swipeCancelled) {
                        stopRecordingAndSend()
                    }
                    true
                }
                MotionEvent.ACTION_CANCEL -> { true }
                else -> false
            }
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent?.let { handleMediaIntent(it) }
    }

    private fun handleMediaIntent(intent: Intent) {
        if (intent.getBooleanExtra("media_button_toggle", false)) {
            intent.removeExtra("media_button_toggle")
            if (!isRecording) {
                headsetRecording = true
                startRecording()
            } else if (headsetRecording) {
                headsetRecording = false
                stopRecordingAndSend()
            }
        }
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "openclaw:companion").apply {
            acquire()
        }
    }

    private fun requestBatteryOptimizationExemption() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            try {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            } catch (e: Exception) {
                Log.w("OpenClaw", "Could not request battery optimization exemption", e)
            }
        }
    }

    private fun playFeedbackSound(start: Boolean) {
        try {
            val tone = if (start) ToneGenerator.TONE_PROP_BEEP else ToneGenerator.TONE_PROP_BEEP2
            toneGenerator?.startTone(tone, if (start) 100 else 150)
        } catch (e: Exception) {
            Log.w("OpenClaw", "Tone error", e)
        }
    }

    private fun vibrate(ms: Long = 50) {
        if (prefs.getBoolean("vibrate", true)) {
            val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
        }
    }

    private fun startVoiceService() {
        val intent = Intent(this, VoiceService::class.java)
        intent.putExtra("bot_name", getBotName())
        ContextCompat.startForegroundService(this, intent)
    }

    private fun updateCancelButtonVisibility() {
        handler.post {
            val vis = when (currentUiState) {
                "transcribing", "thinking", "speaking" -> View.VISIBLE
                else -> View.GONE
            }
            btnCancelProcess.visibility = vis
            btnCancelProcessL2d.visibility = vis
        }
    }

    // --- Conversation history ---

    private var conversationHistoryCount = 0

    private fun updateHistoryCount(count: Int) {
        conversationHistoryCount = count
        handler.post {
            if (count > 0) {
                txtHistoryCount.text = "💬 $count"
                txtHistoryCount.visibility = View.VISIBLE
            } else {
                txtHistoryCount.visibility = View.GONE
            }
        }
    }

    private fun clearConversationHistory() {
        if (!isConnected) return
        sendWs(JSONObject().put("type", "clear_history"))
        updateHistoryCount(0)
        Toast.makeText(this, "Conversation cleared", Toast.LENGTH_SHORT).show()
    }

    /**
     * Barge-in: user starts speaking while AI is playing audio.
     * Stops playback, clears queue, and notifies the server.
     */
    private fun bargeIn() {
        if (currentUiState != "speaking" && !isPlayingChunks && mediaPlayer == null) return
        Log.d("OpenClaw", "Barge-in triggered")

        // Stop all audio playback
        stopAllPlayback()

        // Notify server
        sendWs(JSONObject().put("type", "barge_in"))
    }

    /**
     * Stop all audio playback and clear queues (used by barge-in and stop_playback).
     */
    private fun stopAllPlayback() {
        releaseVisualizer()
        cancelEmotionCues()
        audioChunkQueue.clear()
        isPlayingChunks = false
        streamComplete = false

        mediaPlayer?.let {
            try { it.stop() } catch (_: Exception) {}
            it.release()
        }
        mediaPlayer = null

        smartPaused = false
        currentUiState = "idle"

        handler.post {
            setActiveState(OrbView.State.IDLE)
            if (listenMode == "smart_listen" && isConnected) {
                setStatusText(getString(R.string.status_smart_listening))
            } else {
                setStatusText(getString(R.string.status_connected))
            }
            updateCancelButtonVisibility()
        }
    }

    private fun cancelProcessing() {
        releaseVisualizer()
        cancelEmotionCues()
        audioChunkQueue.clear()
        isPlayingChunks = false
        streamComplete = false
        mediaPlayer?.let {
            try { it.stop() } catch (_: Exception) {}
            it.release()
        }
        mediaPlayer = null

        try {
            sendWs(JSONObject().put("type", "cancel"))
        } catch (_: Exception) {}

        waitingForResponse = false
        currentUiState = "idle"
        smartPaused = false

        handler.post {
            setStatusText(getString(R.string.status_connected))
            setActiveState(OrbView.State.IDLE)
            updateCancelButtonVisibility()
        }
    }

    private fun cancelRecording() {
        if (!isRecording) return
        isRecording = false

        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        noiseSuppressor?.release(); noiseSuppressor = null
        echoCanceler?.release(); echoCanceler = null
        gainControl?.release(); gainControl = null

        currentUiState = "idle"

        handler.post {
            txtSwipeCancel.visibility = View.GONE
            txtSwipeCancelL2d.visibility = View.GONE
            setStatusText(getString(R.string.status_connected))
            setActiveState(OrbView.State.IDLE)
            updateCancelButtonVisibility()
            vibrate(30)
            Toast.makeText(this, getString(R.string.toast_cancelled), Toast.LENGTH_SHORT).show()
        }
    }

    // --- Video background ---

    private fun setupVideoBackground() {
        try {
            // Copy bundled video from assets to cache (VideoView can't play from assets directly)
            val videoFile = File(cacheDir, "bg_loop.mp4")
            
            // Check for user-provided video first
            val userVideo = File(getExternalFilesDir(null), "bg_loop.mp4")
            val sourceFile = if (userVideo.exists()) userVideo else {
                // Copy from assets
                if (!videoFile.exists()) {
                    try {
                        val input = assets.open("backgrounds/fantasy_loop.mp4")
                        FileOutputStream(videoFile).use { out -> input.copyTo(out) }
                        input.close()
                    } catch (e: Exception) {
                        Log.d("OpenClaw", "No background video available")
                        return
                    }
                }
                videoFile
            }
            
            // Enable transparent GL on Live2D view
            live2dView.enableTransparentBackground()
            
            videoBackground.setVideoPath(sourceFile.absolutePath)
            videoBackground.setOnPreparedListener { mp ->
                mp.isLooping = true
                mp.setVolume(0f, 0f)
            }
            videoBackground.setOnCompletionListener {
                // Fallback loop for devices that don't support isLooping
                videoBackground.start()
            }
            videoBackground.setOnErrorListener { _, _, _ ->
                Log.w("OpenClaw", "Video background error")
                false
            }
            videoBackground.start()
        } catch (e: Exception) {
            Log.w("OpenClaw", "Video background setup failed", e)
        }
    }

    // --- Text mode ---

    private fun enterTextMode() {
        isTextMode = true
        textInputBar.visibility = View.VISIBLE
        edtMessage.requestFocus()
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(edtMessage, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun exitTextMode() {
        isTextMode = false
        textInputBar.visibility = View.GONE
        edtMessage.clearFocus()
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(edtMessage.windowToken, 0)
    }

    private fun sendTextMessage() {
        val text = edtMessage.text.toString().trim()
        if (text.isEmpty() || !isConnected) return
        edtMessage.setText("")

        // Slash commands
        if (text.startsWith("/")) {
            handleSlashCommand(text)
            return
        }

        val botName = getBotName()
        setTranscriptText(getString(R.string.transcript_you, text))
        addChatMessage(ChatMessage(role = "user", text = text))
        sendWs(JSONObject().put("type", "text").put("text", text).put("prefix", "[$botName]"))
        waitingForResponse = true
    }

    private fun handleSlashCommand(cmd: String) {
        val parts = cmd.split(" ", limit = 2)
        when (parts[0].lowercase()) {
            "/enroll" -> {
                val name = if (parts.size > 1) parts[1].trim() else ""
                if (name.isEmpty()) {
                    addChatMessage(ChatMessage(role = "system", text = "Usage: /enroll <name>\nExample: /enroll Pablo", emotion = "neutral"))
                    return
                }
                if (listenMode != "smart_listen") {
                    addChatMessage(ChatMessage(role = "system", text = "⚠️ Switch to Smart Listen mode first to enroll voices.", emotion = "confused"))
                    return
                }
                startEnrollment(name)
            }
            "/voices" -> {
                sendWs(JSONObject().put("type", "get_profiles"))
            }
            "/clear" -> {
                clearConversationHistory()
                addChatMessage(ChatMessage(role = "system", text = "🗑️ Conversation history cleared", emotion = "neutral"))
            }
            "/help" -> {
                addChatMessage(ChatMessage(role = "system", text = """
                    📋 Commands:
                    /enroll <name> — Register a voice profile
                    /voices — List registered voices
                    /clear — Clear conversation history
                    /help — Show this help
                """.trimIndent(), emotion = "neutral"))
            }
            else -> {
                addChatMessage(ChatMessage(role = "system", text = "❓ Unknown command. Type /help", emotion = "neutral"))
            }
        }
    }

    // --- Chat helpers ---

    private fun addChatMessage(message: ChatMessage) {
        chatMessages.add(message)
        chatAdapter.notifyItemInserted(chatMessages.size - 1)
        chatAdapterL2d.notifyItemInserted(chatMessages.size - 1)
        chatRecyclerView.scrollToPosition(chatMessages.size - 1)
        chatRecyclerViewL2d.scrollToPosition(chatMessages.size - 1)
    }

    private fun updateLastAssistantMessage(text: String, emotion: String = "neutral", isStreaming: Boolean = true) {
        val last = chatMessages.lastOrNull()
        if (last != null && last.role == "assistant" && last.isStreaming) {
            val index = chatMessages.size - 1
            chatMessages[index] = last.copy(text = text, emotion = emotion, isStreaming = isStreaming)
            chatAdapter.notifyItemChanged(index)
            chatAdapterL2d.notifyItemChanged(index)
            chatRecyclerView.scrollToPosition(index)
            chatRecyclerViewL2d.scrollToPosition(index)
        } else {
            addChatMessage(ChatMessage(role = "assistant", text = text, emotion = emotion, isStreaming = isStreaming))
        }
    }

    private fun updateLastAssistantButtons(buttons: List<ChatButton>) {
        val last = chatMessages.lastOrNull()
        if (last != null && last.role == "assistant") {
            val index = chatMessages.size - 1
            chatMessages[index] = last.copy(buttons = buttons)
            chatAdapter.notifyItemChanged(index)
            chatAdapterL2d.notifyItemChanged(index)
        }
    }

    private fun updateLastAssistantArtifact(artifact: ChatArtifact) {
        val last = chatMessages.lastOrNull()
        if (last != null && last.role == "assistant") {
            val index = chatMessages.size - 1
            chatMessages[index] = last.copy(artifact = artifact)
            chatAdapter.notifyItemChanged(index)
            chatAdapterL2d.notifyItemChanged(index)
        }
    }

    // --- Attachments ---

    private fun showAttachmentOptions() {
        val options = arrayOf(
            getString(R.string.attach_photo),
            getString(R.string.attach_camera),
            getString(R.string.attach_file)
        )
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.attach))
            .setItems(options) { _, which ->
                when (which) {
                    0 -> pickImage()
                    1 -> takePhoto()
                    2 -> pickFile()
                }
            }
            .show()
    }

    private fun pickImage() {
        val intent = Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI)
        @Suppress("DEPRECATION")
        startActivityForResult(intent, PICK_IMAGE_REQUEST)
    }

    private fun takePhoto() {
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        @Suppress("DEPRECATION")
        startActivityForResult(intent, PICK_IMAGE_REQUEST)
    }

    private fun pickFile() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }
        @Suppress("DEPRECATION")
        startActivityForResult(intent, PICK_FILE_REQUEST)
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || data == null) return

        when (requestCode) {
            PICK_IMAGE_REQUEST -> {
                val uri = data.data ?: return
                sendImage(uri)
            }
            PICK_FILE_REQUEST -> {
                val uri = data.data ?: return
                sendFile(uri)
            }
        }
    }

    private fun sendImage(uri: android.net.Uri) {
        Thread {
            try {
                val inputStream = contentResolver.openInputStream(uri) ?: return@Thread
                val bytes = inputStream.readBytes()
                inputStream.close()

                if (bytes.size > 5 * 1024 * 1024) {
                    handler.post { Toast.makeText(this, getString(R.string.file_too_large), Toast.LENGTH_SHORT).show() }
                    return@Thread
                }

                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val mimeType = contentResolver.getType(uri) ?: "image/jpeg"

                handler.post {
                    addChatMessage(ChatMessage(role = "user", text = "📷 Image", imageUri = uri.toString()))
                }

                val caption = edtMessage.text.toString().trim()
                handler.post { if (caption.isNotEmpty()) edtMessage.setText("") }
                sendWs(JSONObject()
                    .put("type", "image")
                    .put("data", b64)
                    .put("mimeType", mimeType)
                    .put("text", if (caption.isNotEmpty()) caption else "Describe this image"))
                waitingForResponse = true
            } catch (e: Exception) {
                handler.post { Toast.makeText(this, "Error: ${e.message}", Toast.LENGTH_SHORT).show() }
            }
        }.start()
    }

    private fun sendFile(uri: android.net.Uri) {
        Thread {
            try {
                val inputStream = contentResolver.openInputStream(uri) ?: return@Thread
                val bytes = inputStream.readBytes()
                inputStream.close()

                if (bytes.size > 5 * 1024 * 1024) {
                    handler.post { Toast.makeText(this, getString(R.string.file_too_large), Toast.LENGTH_SHORT).show() }
                    return@Thread
                }

                val fileName = uri.lastPathSegment ?: "file"
                val mimeType = contentResolver.getType(uri) ?: "application/octet-stream"
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)

                handler.post {
                    addChatMessage(ChatMessage(role = "user", text = "📄 $fileName", fileName = fileName))
                }

                sendWs(JSONObject()
                    .put("type", "file")
                    .put("data", b64)
                    .put("name", fileName)
                    .put("mimeType", mimeType))
                waitingForResponse = true
            } catch (e: Exception) {
                handler.post { Toast.makeText(this, "Error: ${e.message}", Toast.LENGTH_SHORT).show() }
            }
        }.start()
    }

    // --- Smart Listen Mode ---

    private fun applyListenMode() {
        if (listenMode == "smart_listen") {
            startSmartListening()
        } else {
            stopSmartListening()
        }
    }

    private fun startSmartListening() {
        if (isSmartListening || !isConnected) return
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) return

        isSmartListening = true

        // Enable full communication audio mode for hardware echo cancellation
        val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION

        handler.post {
            setStatusText(getString(R.string.status_smart_listening))
            setActiveState(OrbView.State.IDLE)
            // Hide mic button in smart mode, show indicator
            getActiveTalkBtn().alpha = 0.3f
        }

        // Send bot name to server
        val botName = getBotName()
        sendWs(JSONObject().put("type", "set_bot_name").put("name", botName))

        smartRecordThread = Thread {
            val bufSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
            try {
                smartAudioRecord = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_COMMUNICATION, sampleRate, channelConfig, audioFormat, bufSize * 2
                )
            } catch (e: SecurityException) {
                handler.post { Toast.makeText(this, "Mic permission needed", Toast.LENGTH_SHORT).show() }
                isSmartListening = false
                return@Thread
            }

            // Enable AEC on smart listen mic to filter out speaker output
            try {
                val sessionId = smartAudioRecord!!.audioSessionId
                if (AcousticEchoCanceler.isAvailable()) {
                    AcousticEchoCanceler.create(sessionId)?.apply { enabled = true }
                    Log.d("OpenClaw", "AEC enabled for smart listen")
                }
                if (NoiseSuppressor.isAvailable()) {
                    NoiseSuppressor.create(sessionId)?.apply { enabled = true }
                }
            } catch (e: Exception) {
                Log.w("OpenClaw", "Smart listen audio effects error", e)
            }

            smartAudioRecord?.startRecording()
            val buffer = ByteArray(bufSize)
            var speechBuffer = ByteArrayOutputStream()
            var isSpeech = false
            var silenceStart = 0L
            var speechStart = 0L

            while (isSmartListening) {
                val read = smartAudioRecord?.read(buffer, 0, buffer.size) ?: 0
                if (read <= 0) continue

                // Calculate RMS
                var sum = 0L
                for (i in 0 until read step 2) {
                    if (i + 1 < read) {
                        val sample = (buffer[i].toInt() and 0xFF) or (buffer[i + 1].toInt() shl 8)
                        val signed = if (sample > 32767) sample - 65536 else sample
                        sum += signed.toLong() * signed.toLong()
                    }
                }
                val rms = Math.sqrt(sum.toDouble() / (read / 2)).toFloat()

                // Barge-in: if AI is playing and user speaks LOUDLY, interrupt
                // Uses higher threshold to avoid picking up speaker echo
                if (smartPaused && rms > BARGEIN_THRESHOLD_RMS) {
                    Log.d("SmartListen", "Barge-in triggered: rms=$rms")
                    handler.post { bargeIn() }
                    // smartPaused is now false (set by bargeIn/stopAllPlayback)
                    // Fall through to normal speech detection
                }

                // Skip processing while AI is responding
                if (smartPaused) {
                    isSpeech = false
                    speechBuffer = ByteArrayOutputStream()
                    continue
                }

                // Debug: show RMS in status every ~1s
                if (System.currentTimeMillis() % 1000 < 50) {
                    Log.d("SmartListen", "RMS: $rms paused=$smartPaused speech=$isSpeech connected=$isConnected")
                }

                if (rms > SILENCE_THRESHOLD_RMS) {
                    // Speech detected
                    if (!isSpeech) {
                        isSpeech = true
                        speechStart = System.currentTimeMillis()
                        speechBuffer = ByteArrayOutputStream()
                        Log.d("SmartListen", "Speech START rms=$rms")
                        handler.post {
                            setActiveState(OrbView.State.LISTENING)
                            setActiveAmplitude((rms / 8000f).coerceIn(0f, 1f))
                        }
                    }
                    silenceStart = 0L
                    speechBuffer.write(buffer, 0, read)

                    // Update amplitude
                    val normalized = (rms / 8000f).coerceIn(0f, 1f)
                    handler.post { setActiveAmplitude(normalized) }

                    // Max segment length
                    if (System.currentTimeMillis() - speechStart > MAX_SEGMENT_MS) {
                        if (isEnrolling) handleEnrollmentAudio(speechBuffer.toByteArray())
                        else sendSmartSegment(speechBuffer.toByteArray())
                        isSpeech = false
                        speechBuffer = ByteArrayOutputStream()
                        handler.post {
                            setActiveState(OrbView.State.IDLE)
                            setStatusText(getString(R.string.status_smart_listening))
                        }
                    }
                } else {
                    // Silence
                    if (isSpeech) {
                        speechBuffer.write(buffer, 0, read) // Include trailing silence
                        if (silenceStart == 0L) {
                            silenceStart = System.currentTimeMillis()
                        } else if (System.currentTimeMillis() - silenceStart > SILENCE_DURATION_MS) {
                            // End of speech segment
                            val duration = System.currentTimeMillis() - speechStart
                            if (duration >= MIN_SPEECH_DURATION_MS) {
                                if (isEnrolling) {
                                    handleEnrollmentAudio(speechBuffer.toByteArray())
                                } else {
                                    sendSmartSegment(speechBuffer.toByteArray())
                                }
                            }
                            isSpeech = false
                            speechBuffer = ByteArrayOutputStream()
                            handler.post {
                                setActiveState(OrbView.State.IDLE)
                                setActiveAmplitude(0f)
                                if (currentUiState != "thinking" && currentUiState != "speaking") {
                                    setStatusText(getString(R.string.status_smart_listening))
                                }
                            }
                        }
                    }
                }
            }

            smartAudioRecord?.stop()
            smartAudioRecord?.release()
            smartAudioRecord = null
        }
        smartRecordThread?.start()
    }

    private fun stopSmartListening() {
        isSmartListening = false
        smartRecordThread?.interrupt()
        smartRecordThread = null
        // Restore normal audio mode
        val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_NORMAL
        handler.post {
            getActiveTalkBtn().alpha = 1.0f
            if (isConnected) {
                setStatusText(getString(R.string.status_connected))
            }
        }
    }

    private fun sendSmartSegment(pcmData: ByteArray) {
        if (!isConnected || pcmData.size < 1000) {
            Log.w("SmartListen", "Segment dropped: connected=$isConnected size=${pcmData.size}")
            return
        }
        val wavData = pcmToWav(pcmData, sampleRate, 1, 16)
        val b64 = Base64.encodeToString(wavData, Base64.NO_WRAP)
        Log.d("SmartListen", "Sending segment: ${wavData.size} bytes WAV")
        sendWs(JSONObject().put("type", "ambient_audio").put("data", b64))
        handler.post {
            setActiveState(OrbView.State.THINKING)
            setStatusText(getString(R.string.status_transcribing))
        }
    }

    // --- Speaker Enrollment ---

    private var isEnrolling = false
    private var enrollName = ""
    private var enrollSamples = 0
    private val ENROLL_SAMPLES_NEEDED = 3

    private fun startEnrollment(name: String) {
        enrollName = name
        enrollSamples = 0
        isEnrolling = true
        handler.post {
            setStatusText("🎤 Enrollment: Say something (1/$ENROLL_SAMPLES_NEEDED)")
            addChatMessage(ChatMessage(role = "system", text = "🔊 Voice enrollment for \"$name\". Please say 3 different phrases clearly.", emotion = "neutral"))
        }
    }

    private fun handleEnrollmentAudio(pcmData: ByteArray) {
        if (!isConnected || pcmData.size < 4000) return
        enrollSamples++
        val wavData = pcmToWav(pcmData, sampleRate, 1, 16)
        val b64 = Base64.encodeToString(wavData, Base64.NO_WRAP)
        val append = enrollSamples > 1
        sendWs(JSONObject()
            .put("type", "enroll_audio")
            .put("data", b64)
            .put("name", enrollName)
            .put("append", append))

        if (enrollSamples >= ENROLL_SAMPLES_NEEDED) {
            isEnrolling = false
            handler.post {
                setStatusText("✅ Voice enrolled for \"$enrollName\"!")
                addChatMessage(ChatMessage(role = "system", text = "✅ \"$enrollName\" voice profile saved!", emotion = "happy"))
            }
        } else {
            handler.post {
                setStatusText("🎤 Enrollment: Say something (${enrollSamples + 1}/$ENROLL_SAMPLES_NEEDED)")
            }
        }
    }

    // --- WebSocket ---

    private var isReconnecting = false
    private var connectionId = 0L  // Track which connection events belong to
    private var wsSessionId: String? = null  // Server session ID for reconnect sync
    private var lastServerSeq = 0  // Last server seq received (for replay on reconnect)

    private fun connectWebSocket() {
        // Close existing connection without triggering onDisconnect loop
        val thisConnectionId = ++connectionId
        try {
            val old = webSocket
            webSocket = null
            old?.close(1000, "Reconnecting")
        } catch (_: Exception) {}

        val serverUrl = prefs.getString("server_url", "ws://100.121.248.113:3200") ?: ""
        val authToken = prefs.getString("auth_token", "jarvis-voice-2026") ?: ""

        if (serverUrl.isEmpty()) {
            handler.post {
                setStatusText(getString(R.string.status_configure))
                setConnectionStatus("disconnected")
                setActiveState(OrbView.State.DISCONNECTED)
            }
            return
        }

        handler.post {
            setStatusText(getString(R.string.status_connecting))
            setConnectionStatus("connecting")
        }

        val request = Request.Builder().url(serverUrl).build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                Log.d("OpenClaw", "WS opened")
                val authMsg = JSONObject().put("type", "auth").put("token", authToken)
                wsSessionId?.let { authMsg.put("sessionId", it) }
                if (lastServerSeq > 0) authMsg.put("lastServerSeq", lastServerSeq)
                ws.send(authMsg.toString())
                isConnected = true
                isReconnecting = false
                reconnectDelay = 1000L
                currentUiState = "idle"
                handler.post {
                    setStatusText(getString(R.string.status_connected))
                    setConnectionStatus("connected")
                    setActiveState(OrbView.State.IDLE)
                    updateCancelButtonVisibility()
                }
                startPing()

                // Start smart listening if in smart mode
                if (listenMode == "smart_listen") {
                    handler.post { applyListenMode() }
                }

                // Reset waiting state on reconnect — streaming responses can't be replayed
                waitingForResponse = false
            }

            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    val msg = JSONObject(text)
                    
                    // Track server seq for reconnect sync
                    if (msg.has("sseq")) {
                        lastServerSeq = msg.optInt("sseq", lastServerSeq)
                    }
                    
                    // Skip replayed messages we already have in chat
                    if (msg.optBoolean("_replayed", false)) {
                        Log.d("OpenClaw", "Replayed msg sseq=${msg.optInt("sseq")}, type=${msg.optString("type")}")
                        // Still process to update UI state, but don't duplicate chat messages
                        // For now, just skip — the chat history is already showing them
                        return
                    }
                    
                    when (msg.optString("type")) {
                        "auth" -> {
                            // Save session ID for reconnect
                            if (msg.has("sessionId")) {
                                wsSessionId = msg.optString("sessionId")
                                Log.d("OpenClaw", "Session: ${wsSessionId?.take(8)}, serverSeq: ${msg.optInt("serverSeq", 0)}")
                            }
                            if (msg.has("historyCount")) {
                                updateHistoryCount(msg.optInt("historyCount", 0))
                            }
                        }
                        "history_count" -> {
                            updateHistoryCount(msg.optInt("count", 0))
                        }
                        "transcript" -> {
                            val t = msg.optString("text", "")
                            handler.post {
                                setTranscriptText(getString(R.string.transcript_you, t))
                                addChatMessage(ChatMessage(role = "user", text = t))
                            }
                        }
                        "reply" -> {
                            val t = msg.optString("text", "")
                            val botName = getBotName()
                            handler.post {
                                setReplyText(getString(R.string.transcript_bot, botName, t))
                                addChatMessage(ChatMessage(role = "assistant", text = t, isStreaming = false))
                            }
                        }
                        "buttons" -> {
                            val optionsArr = msg.optJSONArray("options")
                            if (optionsArr != null) {
                                val buttons = mutableListOf<ChatButton>()
                                for (i in 0 until optionsArr.length()) {
                                    val opt = optionsArr.getJSONObject(i)
                                    buttons.add(ChatButton(
                                        text = opt.optString("text", ""),
                                        value = opt.optString("value", opt.optString("text", ""))
                                    ))
                                }
                                handler.post { updateLastAssistantButtons(buttons) }
                            }
                        }
                        "artifact" -> {
                            val artifactObj = msg.optJSONObject("artifact") ?: msg
                            val artifact = ChatArtifact(
                                type = artifactObj.optString("artifactType", artifactObj.optString("type", "text")),
                                content = artifactObj.optString("content", ""),
                                title = artifactObj.optString("title", null),
                                language = artifactObj.optString("language", null)
                            )
                            handler.post { updateLastAssistantArtifact(artifact) }
                        }
                        "audio" -> {
                            val data = msg.optString("data", "")
                            if (data.isNotEmpty()) {
                                hasReceivedAudio = true
                                waitingForResponse = false
                                if (prefs.getBoolean("auto_play", true)) {
                                    val audioBytes = Base64.decode(data, Base64.DEFAULT)
                                    playAudio(audioBytes)
                                } else {
                                    currentUiState = "idle"
                                    handler.post {
                                        setStatusText(getString(R.string.status_connected))
                                        setActiveState(OrbView.State.IDLE)
                                        updateCancelButtonVisibility()
                                    }
                                }
                            }
                        }
                        "status" -> {
                            val s = msg.optString("status", "")
                            handler.post {
                                val statusText = when (s) {
                                    "transcribing" -> {
                                        currentUiState = "transcribing"
                                        setActiveState(OrbView.State.THINKING)
                                        updateCancelButtonVisibility()
                                        getString(R.string.status_transcribing)
                                    }
                                    "thinking" -> {
                                        audioChunkQueue.clear()
                                        isPlayingChunks = false
                                        streamComplete = false
                                        currentUiState = "thinking"
                                        smartPaused = true  // Pause smart listen during response
                                        setActiveState(OrbView.State.THINKING)
                                        updateCancelButtonVisibility()
                                        getString(R.string.status_thinking)
                                    }
                                    "speaking" -> {
                                        currentUiState = "speaking"
                                        smartPaused = true
                                        setActiveState(OrbView.State.SPEAKING)
                                        updateCancelButtonVisibility()
                                        getString(R.string.status_speaking)
                                    }
                                    else -> s
                                }
                                setStatusText(statusText)
                            }
                        }
                        "error" -> {
                            val m = msg.optString("message", "Unknown error")
                            waitingForResponse = false
                            currentUiState = "idle"
                            smartPaused = false
                            handler.post {
                                setStatusText(getString(R.string.status_error, m))
                                setActiveState(OrbView.State.IDLE)
                                updateCancelButtonVisibility()
                                addChatMessage(ChatMessage(role = "assistant", text = "⚠️ $m", isStreaming = false))
                            }
                        }
                        "emotion_cues" -> {
                            val cuesArray = msg.optJSONArray("cues")
                            if (cuesArray != null) {
                                pendingEmotionCues.clear()
                                for (i in 0 until cuesArray.length()) {
                                    val cue = cuesArray.getJSONObject(i)
                                    pendingEmotionCues.add(EmotionCue(
                                        startMs = cue.optLong("startMs", 0),
                                        endMs = cue.optLong("endMs", 0),
                                        text = cue.optString("text", ""),
                                        emotion = cue.optString("emotion", "neutral")
                                    ))
                                }
                            }
                        }
                        "reply_chunk" -> {
                            val chunkText = msg.optString("text", "")
                            val emotion = msg.optString("emotion", "neutral")
                            val index = msg.optInt("index", 0)
                            if (index == 0) {
                                accumulatedReplyText.clear()
                                handler.post {
                                    setActiveState(OrbView.State.SPEAKING)
                                }
                            }
                            accumulatedReplyText.append(chunkText)
                            handler.post {
                                updateLastAssistantMessage(accumulatedReplyText.toString(), emotion, isStreaming = true)
                            }
                        }
                        "audio_chunk" -> {
                            val audioB64 = msg.optString("data", "")
                            val emotion = msg.optString("emotion", "neutral")
                            val chunkText = msg.optString("text", "")
                            val index = msg.optInt("index", 0)
                            if (audioB64.isNotEmpty() && prefs.getBoolean("auto_play", true)) {
                                audioChunkQueue.add(AudioChunk(audioB64, emotion, chunkText, index))
                                if (!isPlayingChunks) {
                                    playNextChunk()
                                }
                            }
                        }
                        "stream_done" -> {
                            streamComplete = true
                            waitingForResponse = false
                            // Update history count if provided, otherwise increment locally
                            if (msg.has("historyCount")) {
                                updateHistoryCount(msg.optInt("historyCount", 0))
                            } else {
                                updateHistoryCount(conversationHistoryCount + 2) // user + assistant
                            }
                            handler.post {
                                // Finalize streaming message
                                val last = chatMessages.lastOrNull()
                                if (last != null && last.role == "assistant" && last.isStreaming) {
                                    val index = chatMessages.size - 1
                                    chatMessages[index] = last.copy(isStreaming = false)
                                    chatAdapter.notifyItemChanged(index)
                                }
                            }
                            if (!isPlayingChunks && audioChunkQueue.isEmpty()) {
                                handler.post {
                                    currentUiState = "idle"
                                    setActiveState(OrbView.State.IDLE)
                                    setStatusText(getString(R.string.status_connected))
                                    updateCancelButtonVisibility()
                                }
                            }
                        }
                        "emotion" -> {
                            val emotion = msg.optString("emotion", "neutral")
                            handler.post { setActiveEmotion(emotion) }
                        }
                        "stop_playback" -> {
                            Log.d("OpenClaw", "Server requested stop_playback")
                            handler.post { stopAllPlayback() }
                        }
                        "pong" -> { /* keepalive OK */ }
                        "enroll_result" -> {
                            val status = msg.optString("status", "")
                            val speaker = msg.optString("speaker", "")
                            handler.post {
                                if (status == "ok") {
                                    addChatMessage(ChatMessage(role = "system", text = "✅ Voice sample saved for $speaker (${enrollSamples}/$ENROLL_SAMPLES_NEEDED)", emotion = "happy"))
                                } else {
                                    addChatMessage(ChatMessage(role = "system", text = "❌ Enrollment error: ${msg.optString("message", "unknown")}", emotion = "sad"))
                                }
                            }
                        }
                        "profiles" -> {
                            val profiles = msg.optJSONArray("profiles")
                            val list = mutableListOf<String>()
                            if (profiles != null) {
                                for (i in 0 until profiles.length()) list.add(profiles.getString(i))
                            }
                            handler.post {
                                addChatMessage(ChatMessage(role = "system", text = "🔊 Registered voices: ${if (list.isEmpty()) "none" else list.joinToString(", ")}", emotion = "neutral"))
                            }
                        }
                        "ambient_transcript" -> {
                            val t = msg.optString("text", "")
                            val speaker = msg.optString("speaker", "?")
                            val isOwner = msg.optBoolean("isOwner", false)
                            val icon = if (isOwner) "👑" else "🎧"
                            handler.post {
                                setStatusText(getString(R.string.status_smart_heard, "[$speaker] ${t.take(30)}"))
                                addChatMessage(ChatMessage(role = "system", text = "$icon [$speaker]: $t", emotion = "neutral"))
                            }
                        }
                        "smart_status" -> {
                            val s = msg.optString("status", "")
                            handler.post {
                                when (s) {
                                    "listening" -> {
                                        if (currentUiState != "speaking" && currentUiState != "thinking") {
                                            setStatusText(getString(R.string.status_smart_listening))
                                            setActiveState(OrbView.State.IDLE)
                                        }
                                    }
                                    "transcribing" -> {
                                        setActiveState(OrbView.State.THINKING)
                                    }
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.e("OpenClaw", "Parse error", e)
                }
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                Log.d("OpenClaw", "WS closed: $code $reason (conn=$thisConnectionId, current=$connectionId)")
                if (thisConnectionId != connectionId) return  // Stale connection
                onDisconnect()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                Log.e("OpenClaw", "WS failure: ${t.message} (conn=$thisConnectionId, current=$connectionId)")
                if (thisConnectionId != connectionId) return  // Stale connection
                onDisconnect()
            }
        })
    }

    private fun onDisconnect() {
        if (isReconnecting) return
        isReconnecting = true
        isConnected = false
        currentUiState = "idle"
        stopPing()
        stopSmartListening()
        handler.post {
            setStatusText(getString(R.string.status_disconnected))
            setConnectionStatus("disconnected")
            setActiveState(OrbView.State.DISCONNECTED)
            updateCancelButtonVisibility()
        }
        handler.postDelayed({
            isReconnecting = false
            setConnectionStatus("connecting")
            connectWebSocket()
        }, reconnectDelay)
        reconnectDelay = (reconnectDelay * 2).coerceAtMost(30000L)
    }

    private fun sendWs(json: JSONObject) {
        try {
            webSocket?.send(json.toString())
        } catch (e: Exception) {
            Log.e("OpenClaw", "Send error", e)
        }
    }

    private fun startPing() {
        stopPing()
        pingRunnable = object : Runnable {
            override fun run() {
                if (isConnected) {
                    sendWs(JSONObject().put("type", "ping"))
                    handler.postDelayed(this, 30000)
                }
            }
        }
        handler.postDelayed(pingRunnable!!, 30000)
    }

    private fun stopPing() {
        pingRunnable?.let { handler.removeCallbacks(it) }
        pingRunnable = null
    }

    private fun setConnectionStatus(status: String) {
        val color = when (status) {
            "connected" -> 0xFF4CAF50.toInt()
            "connecting" -> 0xFFFFEB3B.toInt()
            else -> 0xFFF44336.toInt()
        }
        val bg = connectionDot.background
        if (bg is GradientDrawable) {
            bg.setColor(color)
        } else {
            val shape = GradientDrawable()
            shape.shape = GradientDrawable.OVAL
            shape.setColor(color)
            connectionDot.background = shape
        }
    }

    // --- Recording ---

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_HEADSETHOOK || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
            if (!isRecording) {
                headsetRecording = true
                startRecording()
            } else if (headsetRecording) {
                headsetRecording = false
                stopRecordingAndSend()
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_HEADSETHOOK || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    private fun startRecording() {
        if (isRecording || !isConnected) return

        // Barge-in: if AI is playing audio, interrupt it
        if (currentUiState == "speaking" || isPlayingChunks || mediaPlayer != null) {
            bargeIn()
        }

        val bufSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) return

        audioRecord = AudioRecord(
            MediaRecorder.AudioSource.MIC, sampleRate, channelConfig, audioFormat, bufSize
        )

        try {
            val sessionId = audioRecord!!.audioSessionId
            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(sessionId)?.apply { enabled = true }
            }
            if (AcousticEchoCanceler.isAvailable()) {
                echoCanceler = AcousticEchoCanceler.create(sessionId)?.apply { enabled = true }
            }
            if (AutomaticGainControl.isAvailable()) {
                gainControl = AutomaticGainControl.create(sessionId)?.apply { enabled = true }
            }
        } catch (e: Exception) {
            Log.w("OpenClaw", "Audio effects init error", e)
        }

        audioData = ByteArrayOutputStream()
        isRecording = true
        currentUiState = "recording"

        handler.post {
            setStatusText(getString(R.string.status_listening))
            setActiveState(OrbView.State.LISTENING)
            txtSwipeCancel.visibility = View.VISIBLE
            txtSwipeCancelL2d.visibility = View.VISIBLE
            txtSwipeCancel.setTextColor(0x66AAAAAA.toInt())
            txtSwipeCancelL2d.setTextColor(0x66AAAAAA.toInt())
            updateCancelButtonVisibility()
            vibrate(50)
            playFeedbackSound(true)
        }

        audioRecord?.startRecording()
        recordingThread = Thread {
            val buffer = ByteArray(bufSize)
            while (isRecording) {
                val read = audioRecord?.read(buffer, 0, buffer.size) ?: 0
                if (read > 0) {
                    audioData.write(buffer, 0, read)
                    var sum = 0L
                    for (i in 0 until read step 2) {
                        if (i + 1 < read) {
                            val sample = (buffer[i].toInt() and 0xFF) or (buffer[i + 1].toInt() shl 8)
                            sum += sample.toLong() * sample.toLong()
                        }
                    }
                    val rms = Math.sqrt(sum.toDouble() / (read / 2)).toFloat()
                    val normalized = (rms / 8000f).coerceIn(0f, 1f)
                    handler.post { setActiveAmplitude(normalized) }
                }
            }
        }.also { it.start() }
    }

    private fun stopRecordingAndSend() {
        if (!isRecording) return
        isRecording = false

        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        noiseSuppressor?.release(); noiseSuppressor = null
        echoCanceler?.release(); echoCanceler = null
        gainControl?.release(); gainControl = null

        currentUiState = "transcribing"

        handler.post {
            txtSwipeCancel.visibility = View.GONE
            txtSwipeCancelL2d.visibility = View.GONE
            setStatusText(getString(R.string.status_transcribing))
            setActiveState(OrbView.State.THINKING)
            updateCancelButtonVisibility()
            vibrate(30)
            playFeedbackSound(false)
        }

        val pcmData = audioData.toByteArray()
        val wavData = pcmToWav(pcmData, sampleRate, 1, 16)
        val b64 = Base64.encodeToString(wavData, Base64.NO_WRAP)

        waitingForResponse = true
        val botName = getBotName()
        sendWs(JSONObject().put("type", "audio").put("data", b64).put("prefix", "[$botName]"))
    }

    // --- Audio playback ---

    private fun playAudio(audioBytes: ByteArray) {
        try {
            currentUiState = "speaking"
            handler.post {
                setStatusText(getString(R.string.status_speaking))
                setActiveState(OrbView.State.SPEAKING)
                updateCancelButtonVisibility()
            }

            val tmpFile = File(cacheDir, "response.mp3")
            FileOutputStream(tmpFile).use { it.write(audioBytes) }

            mediaPlayer?.release()
            mediaPlayer = MediaPlayer().apply {
                setDataSource(tmpFile.absolutePath)
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .build()
                )
                setOnCompletionListener {
                    releaseVisualizer()
                    cancelEmotionCues()
                    it.release()
                    mediaPlayer = null
                    tmpFile.delete()
                    currentUiState = "idle"
                    // Delay resume to avoid picking up TTS echo tail
                    handler.postDelayed({
                        smartPaused = false
                    }, 1000)
                    handler.post {
                        setActiveAmplitude(0f)
                        if (listenMode == "smart_listen" && isConnected) {
                            setStatusText(getString(R.string.status_smart_listening))
                        } else {
                            setStatusText(getString(R.string.status_connected))
                        }
                        setActiveState(OrbView.State.IDLE)
                        updateCancelButtonVisibility()
                    }
                }
                prepare()
                setupVisualizer(this.audioSessionId)
                start()
                scheduleEmotionCues()
            }
        } catch (e: Exception) {
            Log.e("OpenClaw", "Audio playback error", e)
            currentUiState = "idle"
            handler.post {
                setStatusText(getString(R.string.status_error, e.message))
                setActiveState(OrbView.State.IDLE)
                updateCancelButtonVisibility()
            }
        }
    }

    private fun scheduleEmotionCues() {
        cancelEmotionCues()
        if (pendingEmotionCues.isEmpty()) return
        var currentCueIndex = 0
        val checker = object : Runnable {
            override fun run() {
                val mp = mediaPlayer ?: return
                try {
                    val pos = mp.currentPosition.toLong()
                    while (currentCueIndex < pendingEmotionCues.size &&
                           pendingEmotionCues[currentCueIndex].startMs <= pos) {
                        val cue = pendingEmotionCues[currentCueIndex]
                        setActiveEmotion(cue.emotion)
                        setReplyText(cue.text)
                        currentCueIndex++
                    }
                    if (currentCueIndex < pendingEmotionCues.size) {
                        handler.postDelayed(this, 100)
                    }
                } catch (e: Exception) { /* player released */ }
            }
        }
        emotionCueRunnable = checker
        handler.post(checker)
    }

    private fun cancelEmotionCues() {
        emotionCueRunnable?.let { handler.removeCallbacks(it) }
        emotionCueRunnable = null
    }

    private fun releaseMediaPlayer() {
        releaseVisualizer()
        mediaPlayer?.let {
            try { it.stop() } catch (_: Exception) {}
            it.release()
        }
        mediaPlayer = null
    }

    private fun playNextChunk() {
        val chunk = audioChunkQueue.poll()
        if (chunk == null) {
            isPlayingChunks = false
            if (streamComplete) {
                smartPaused = false  // Resume smart listening
                handler.post {
                    currentUiState = "idle"
                    setActiveState(OrbView.State.IDLE)
                    if (listenMode == "smart_listen" && isConnected) {
                        setStatusText(getString(R.string.status_smart_listening))
                    } else {
                        setStatusText(getString(R.string.status_connected))
                    }
                    updateCancelButtonVisibility()
                }
            }
            return
        }

        isPlayingChunks = true
        handler.post {
            setActiveEmotion(chunk.emotion)
            if (chunk.index == 0) {
                val botName = getBotName()
                setReplyText(getString(R.string.transcript_bot, botName, chunk.text))
            } else {
                setReplyText(chunk.text)
            }
        }

        Thread {
            try {
                val audioBytes = android.util.Base64.decode(chunk.audioB64, android.util.Base64.DEFAULT)
                val tempFile = File.createTempFile("chunk_${chunk.index}_", ".mp3", cacheDir)
                tempFile.writeBytes(audioBytes)

                releaseMediaPlayer()
                mediaPlayer = MediaPlayer().apply {
                    setDataSource(tempFile.absolutePath)
                    setOnCompletionListener {
                        tempFile.delete()
                        playNextChunk()
                    }
                    setOnErrorListener { _, _, _ ->
                        tempFile.delete()
                        playNextChunk()
                        false
                    }
                    prepare()
                    setupVisualizer(this.audioSessionId)
                    start()
                }
            } catch (e: Exception) {
                Log.e("OpenClaw", "Chunk playback error", e)
                playNextChunk()
            }
        }.start()
    }

    private fun setupVisualizer(audioSessionId: Int) {
        releaseVisualizer()
        try {
            Log.d("OpenClaw", "Setting up Visualizer for session $audioSessionId")
            visualizer = Visualizer(audioSessionId).apply {
                captureSize = Visualizer.getCaptureSizeRange()[0]
                setDataCaptureListener(object : Visualizer.OnDataCaptureListener {
                    override fun onWaveFormDataCapture(vis: Visualizer?, waveform: ByteArray?, samplingRate: Int) {
                        waveform ?: return
                        var sum = 0L
                        for (b in waveform) {
                            val sample = (b.toInt() and 0xFF) - 128
                            sum += sample.toLong() * sample.toLong()
                        }
                        val rms = Math.sqrt(sum.toDouble() / waveform.size).toFloat()
                        val normalized = (rms / 50f).coerceIn(0f, 1f)
                        handler.post { setActiveAmplitude(normalized) }
                    }
                    override fun onFftDataCapture(vis: Visualizer?, fft: ByteArray?, samplingRate: Int) {}
                }, Visualizer.getMaxCaptureRate(), true, false)
                enabled = true
                Log.d("OpenClaw", "Visualizer enabled successfully, captureSize=$captureSize")
            }
        } catch (e: Exception) {
            Log.e("OpenClaw", "Visualizer setup failed for session $audioSessionId", e)
        }
    }

    private fun releaseVisualizer() {
        visualizer?.let {
            try { it.enabled = false; it.release() } catch (_: Exception) {}
        }
        visualizer = null
    }

    // --- WAV encoding ---

    private fun pcmToWav(pcm: ByteArray, sampleRate: Int, channels: Int, bitsPerSample: Int): ByteArray {
        val byteRate = sampleRate * channels * bitsPerSample / 8
        val blockAlign = channels * bitsPerSample / 8
        val dataSize = pcm.size
        val totalSize = 36 + dataSize

        val wav = ByteArrayOutputStream()
        wav.write("RIFF".toByteArray())
        wav.write(intToBytes(totalSize, 4))
        wav.write("WAVE".toByteArray())
        wav.write("fmt ".toByteArray())
        wav.write(intToBytes(16, 4))
        wav.write(intToBytes(1, 2))
        wav.write(intToBytes(channels, 2))
        wav.write(intToBytes(sampleRate, 4))
        wav.write(intToBytes(byteRate, 4))
        wav.write(intToBytes(blockAlign, 2))
        wav.write(intToBytes(bitsPerSample, 2))
        wav.write("data".toByteArray())
        wav.write(intToBytes(dataSize, 4))
        wav.write(pcm)
        return wav.toByteArray()
    }

    private fun intToBytes(value: Int, size: Int): ByteArray {
        val bytes = ByteArray(size)
        for (i in 0 until size) {
            bytes[i] = (value shr (8 * i) and 0xFF).toByte()
        }
        return bytes
    }

    override fun onPause() {
        super.onPause()
        if (isLive2DActive) {
            live2dView.onActivityPause()
            try { videoBackground.pause() } catch (_: Exception) {}
        }
    }

    override fun onResume() {
        super.onResume()
        if (isLive2DActive) {
            live2dView.onActivityResume()
            try { videoBackground.start() } catch (_: Exception) {}
        }
    }

    override fun onDestroy() {
        stopSmartListening()
        stopPing()
        releaseVisualizer()
        webSocket?.close(1000, "App closing")
        mediaPlayer?.release()
        wakeLock?.let { if (it.isHeld) it.release() }
        toneGenerator?.release()
        live2dView.cleanup()
        mediaButtonReceiver?.let {
            LocalBroadcastManager.getInstance(this).unregisterReceiver(it)
        }
        super.onDestroy()
    }
}
