import { useState, useRef, type KeyboardEvent } from 'react';
import './ChatInput.css';

interface Props {
  onSendText: (text: string) => void;
  onMicToggle: () => void;
  isRecording: boolean;
  isConnected: boolean;
  isPlaying: boolean;
  onBargeIn: () => void;
}

export function ChatInput({
  onSendText,
  onMicToggle,
  isRecording,
  isConnected,
  isPlaying,
  onBargeIn,
}: Props) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSendText(trimmed);
    setText('');
    inputRef.current?.focus();
  };

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-input-bar">
      <button
        className={`mic-btn ${isRecording ? 'recording' : ''}`}
        onClick={isPlaying ? onBargeIn : onMicToggle}
        disabled={!isConnected}
        title={isPlaying ? 'Stop AI speech' : isRecording ? 'Stop recording' : 'Start recording'}
      >
        {isPlaying ? '⏹' : isRecording ? '⏸' : '🎙️'}
      </button>

      <input
        ref={inputRef}
        type="text"
        className="chat-text-input"
        placeholder={isConnected ? 'Type a message...' : 'Connect first...'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKey}
        disabled={!isConnected}
      />

      <button
        className="send-btn"
        onClick={handleSend}
        disabled={!isConnected || !text.trim()}
      >
        ➤
      </button>
    </div>
  );
}
