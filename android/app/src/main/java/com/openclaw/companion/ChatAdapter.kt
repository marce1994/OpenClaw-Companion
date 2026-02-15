package com.openclaw.companion

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.text.format.DateFormat
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.recyclerview.widget.RecyclerView
import io.noties.markwon.Markwon
import java.util.Date

class ChatAdapter(
    private val messages: List<ChatMessage>,
    private val markwon: Markwon,
    val transparent: Boolean = false,
    private val onButtonClick: (String) -> Unit = {}
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    companion object {
        const val TYPE_USER = 0
        const val TYPE_ASSISTANT = 1
    }

    override fun getItemViewType(position: Int): Int {
        val role = messages[position].role
        return if (role == "user") TYPE_USER else TYPE_ASSISTANT
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return if (viewType == TYPE_USER) {
            UserViewHolder(inflater.inflate(R.layout.item_message_user, parent, false))
        } else {
            AssistantViewHolder(inflater.inflate(R.layout.item_message_assistant, parent, false))
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val msg = messages[position]
        if (holder is UserViewHolder) {
            holder.bind(msg)
            if (transparent) {
                val bubble = (holder.itemView as ViewGroup).getChildAt(0)
                bubble?.setBackgroundResource(R.drawable.bubble_user_transparent)
            }
        } else if (holder is AssistantViewHolder) {
            holder.bind(msg)
            if (transparent) {
                val bubble = (holder.itemView as ViewGroup).getChildAt(0)
                bubble?.setBackgroundResource(R.drawable.bubble_assistant_transparent)
            }
        }
        // Fade out smart listen messages that got no response
        holder.itemView.alpha = if (msg.isFaded) 0.3f else 1f
    }

    override fun getItemCount() = messages.size

    inner class UserViewHolder(v: View) : RecyclerView.ViewHolder(v) {
        private val txtMessage: TextView = v.findViewById(R.id.txtUserMessage)
        private val txtTime: TextView = v.findViewById(R.id.txtUserTime)
        private val imgPreview: ImageView = v.findViewById(R.id.imgUserPreview)
        private val txtFileName: TextView = v.findViewById(R.id.txtUserFileName)

        fun bind(msg: ChatMessage) {
            txtMessage.text = msg.text
            txtTime.text = DateFormat.format("HH:mm", Date(msg.timestamp))

            if (msg.imageUri != null) {
                imgPreview.visibility = View.VISIBLE
                try {
                    val inputStream = itemView.context.contentResolver.openInputStream(Uri.parse(msg.imageUri))
                    val bitmap = BitmapFactory.decodeStream(inputStream)
                    inputStream?.close()
                    imgPreview.setImageBitmap(bitmap)
                } catch (e: Exception) {
                    imgPreview.visibility = View.GONE
                }
            } else {
                imgPreview.visibility = View.GONE
            }

            if (msg.fileName != null) {
                txtFileName.visibility = View.VISIBLE
                txtFileName.text = "\uD83D\uDCC4 ${msg.fileName}"
            } else {
                txtFileName.visibility = View.GONE
            }
        }
    }

    inner class AssistantViewHolder(v: View) : RecyclerView.ViewHolder(v) {
        private val txtMessage: TextView = v.findViewById(R.id.txtAssistantMessage)
        private val txtTime: TextView = v.findViewById(R.id.txtAssistantTime)
        private val buttonsContainer: LinearLayout = v.findViewById(R.id.buttonsContainer)
        private val btnArtifact: TextView = v.findViewById(R.id.btnViewArtifact)

        fun bind(msg: ChatMessage) {
            markwon.setMarkdown(txtMessage, msg.text)
            txtTime.text = DateFormat.format("HH:mm", Date(msg.timestamp))

            // Inline buttons
            if (msg.buttons != null && msg.buttons!!.isNotEmpty()) {
                buttonsContainer.visibility = View.VISIBLE
                buttonsContainer.removeAllViews()
                for (btn in msg.buttons!!) {
                    val chip = TextView(itemView.context).apply {
                        text = btn.text
                        setTextColor(0xFFFFFFFF.toInt())
                        textSize = 13f
                        setPadding(32, 16, 32, 16)
                        background = itemView.context.getDrawable(R.drawable.chip_button_bg)
                        val params = LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.WRAP_CONTENT,
                            LinearLayout.LayoutParams.WRAP_CONTENT
                        ).apply { marginEnd = 12 }
                        layoutParams = params
                        setOnClickListener { onButtonClick(btn.value) }
                    }
                    buttonsContainer.addView(chip)
                }
            } else {
                buttonsContainer.visibility = View.GONE
            }

            // Artifact button
            if (msg.artifact != null) {
                btnArtifact.visibility = View.VISIBLE
                btnArtifact.text = if (msg.artifact!!.type == "code") "\uD83D\uDCCB View Code" else "\uD83D\uDCC4 View Details"
                btnArtifact.setOnClickListener {
                    val intent = Intent(itemView.context, ArtifactViewerActivity::class.java).apply {
                        putExtra("content", msg.artifact!!.content)
                        putExtra("title", msg.artifact!!.title ?: "Details")
                        putExtra("type", msg.artifact!!.type)
                        putExtra("language", msg.artifact!!.language ?: "")
                    }
                    itemView.context.startActivity(intent)
                }
            } else {
                btnArtifact.visibility = View.GONE
            }
        }
    }
}
