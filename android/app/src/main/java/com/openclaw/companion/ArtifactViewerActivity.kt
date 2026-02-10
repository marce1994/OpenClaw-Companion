package com.openclaw.companion

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.os.Bundle
import android.widget.ImageButton
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import io.noties.markwon.Markwon

class ArtifactViewerActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_artifact_viewer)

        val content = intent.getStringExtra("content") ?: ""
        val title = intent.getStringExtra("title") ?: "Details"
        val type = intent.getStringExtra("type") ?: "text"
        val language = intent.getStringExtra("language") ?: ""

        val txtTitle = findViewById<TextView>(R.id.txtArtifactTitle)
        val txtContent = findViewById<TextView>(R.id.txtArtifactContent)
        val btnClose = findViewById<ImageButton>(R.id.btnArtifactClose)
        val btnCopy = findViewById<ImageButton>(R.id.btnArtifactCopy)

        txtTitle.text = title

        if (type == "code") {
            txtContent.typeface = Typeface.MONOSPACE
            txtContent.textSize = 13f
            txtContent.text = content
        } else {
            val markwon = Markwon.create(this)
            markwon.setMarkdown(txtContent, content)
        }

        btnClose.setOnClickListener { finish() }

        btnCopy.setOnClickListener {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("code", content))
            Toast.makeText(this, "Copied!", Toast.LENGTH_SHORT).show()
        }
    }
}
