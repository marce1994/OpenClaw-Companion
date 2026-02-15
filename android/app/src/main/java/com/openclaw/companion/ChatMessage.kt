package com.openclaw.companion

data class ChatMessage(
    val id: String = java.util.UUID.randomUUID().toString(),
    val role: String,
    val text: String,
    val timestamp: Long = System.currentTimeMillis(),
    val imageUri: String? = null,
    val imageData: String? = null,
    val fileName: String? = null,
    val emotion: String = "neutral",
    val buttons: List<ChatButton>? = null,
    val artifact: ChatArtifact? = null,
    var isStreaming: Boolean = false,
    var isSmartListen: Boolean = false,
    var isFaded: Boolean = false
)

data class ChatButton(val text: String, val value: String)

data class ChatArtifact(
    val type: String,
    val content: String,
    val title: String? = null,
    val language: String? = null
)
