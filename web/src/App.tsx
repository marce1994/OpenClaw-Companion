import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAudioRecorder, useAudioPlayer } from './hooks/useAudio';
import { ChatBubble } from './components/ChatBubble';
import { SettingsModal, loadSettings, type AppSettings } from './components/SettingsModal';
import { AvatarOrb } from './components/AvatarOrb';
import { Live2DAvatar } from './components/Live2DAvatar';
import { ModelSelector, AVAILABLE_MODELS, type ModelInfo } from './components/ModelSelector';
import type { ChatMessage, ServerMessage, AppStatus } from './protocol/types';
import './App.css';

let msgCounter = 0;
function nextId() { return `msg-${Date.now()}-${++msgCounter}`; }

function extractEmotion(text: string) {
  const match = text.match(/\[\[emotion:(\w+)\]\]/);
  return { clean: text.replace(/\[\[emotion:\w+\]\]\s*/g, ''), emotion: match ? match[1] : null };
}

type ViewMode = 'orb' | 'live2d';
type InputMode = 'voice' | 'text';

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [currentEmotion, setCurrentEmotion] = useState('neutral');
  const [appStatus, setAppStatus] = useState<AppStatus>('idle');
  const [viewMode, setViewMode] = useState<ViewMode>('live2d');
  const [inputMode, setInputMode] = useState<InputMode>('voice');
  const [selectedModel, setSelectedModel] = useState<ModelInfo>(AVAILABLE_MODELS[0]);
  const [textInput, setTextInput] = useState('');
  const [lastTranscript, setLastTranscript] = useState('');
  const [lastReply, setLastReply] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const streamingIdRef = useRef<string>('');
  const streamingChunksRef = useRef<Map<number, string>>(new Map());

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const { isPlaying, enqueue, stopPlayback, audioRef } = useAudioPlayer();
  useEffect(() => { if (isPlaying) setAppStatus('speaking'); }, [isPlaying]);

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'auth': break;

      case 'status':
        if (msg.status === 'idle') setAppStatus('idle');
        else if (msg.status === 'thinking') setAppStatus('thinking');
        else if (msg.status === 'speaking') setAppStatus('speaking');
        else if (msg.status === 'transcribing') setAppStatus('transcribing');
        break;

      case 'transcription':
        setLastTranscript(msg.text);
        setMessages(prev => [...prev, { id: nextId(), role: 'user', text: msg.text, timestamp: Date.now() }]);
        break;

      case 'reply_chunk': {
        const { clean, emotion } = extractEmotion(msg.text);
        if (emotion) setCurrentEmotion(emotion);
        if (msg.emotion) setCurrentEmotion(msg.emotion);

        streamingChunksRef.current.set(msg.index, clean);
        let fullText = '';
        for (let i = 0; i <= Math.max(...streamingChunksRef.current.keys()); i++) {
          if (streamingChunksRef.current.has(i)) fullText += streamingChunksRef.current.get(i)! + ' ';
        }
        fullText = fullText.trim();
        setLastReply(fullText);

        setMessages(prev => {
          const id = streamingIdRef.current || nextId();
          if (!streamingIdRef.current) streamingIdRef.current = id;
          const updated: ChatMessage = { id, role: 'assistant', text: fullText, timestamp: Date.now(), emotion: emotion || msg.emotion };
          const idx = prev.findIndex(m => m.id === id);
          if (idx >= 0) { const copy = [...prev]; copy[idx] = updated; return copy; }
          return [...prev, updated];
        });
        break;
      }

      case 'audio_chunk':
        if (settings.autoPlay) enqueue(msg.data, 'mp3');
        if (msg.emotion) setCurrentEmotion(msg.emotion);
        break;

      case 'stream_done':
        streamingIdRef.current = '';
        streamingChunksRef.current.clear();
        setAppStatus('idle');
        break;

      case 'emotion':
        setCurrentEmotion(msg.emotion);
        break;

      case 'artifact':
        setMessages(prev => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === 'assistant') {
              copy[i] = { ...copy[i], artifact: { title: msg.title, language: msg.language, content: msg.content } };
              break;
            }
          }
          return copy;
        });
        break;

      case 'buttons':
        setMessages(prev => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === 'assistant') { copy[i] = { ...copy[i], buttons: msg.options }; break; }
          }
          return copy;
        });
        break;

      case 'stop_playback': stopPlayback(); break;

      case 'error':
        setMessages(prev => [...prev, { id: nextId(), role: 'system', text: `⚠️ ${msg.message}`, timestamp: Date.now() }]);
        setAppStatus('idle');
        break;
    }
  }, [enqueue, stopPlayback, settings.autoPlay]);

  const { state: connState, send, connect, disconnect } = useWebSocket({
    url: settings.serverUrl, token: settings.authToken, onMessage: handleMessage,
  });

  const { isRecording, start: startRec, stop: stopRec } = useAudioRecorder({
    onAudioChunk: (data) => send({ type: 'audio', data }),
  });

  const isConnected = connState === 'connected';

  const handleMicToggle = () => {
    if (isPlaying) { send({ type: 'barge_in' }); stopPlayback(); setAppStatus('idle'); return; }
    if (isRecording) { stopRec(); setAppStatus('idle'); }
    else { startRec(); setAppStatus('recording'); }
  };

  const handleSendText = () => {
    const t = textInput.trim();
    if (!t || !isConnected) return;
    setMessages(prev => [...prev, { id: nextId(), role: 'user', text: t, timestamp: Date.now() }]);
    send({ type: 'text', text: t });
    setTextInput('');
    setLastTranscript(t);
  };

  const handleButtonClick = (cb: string) => {
    setMessages(prev => [...prev, { id: nextId(), role: 'user', text: cb, timestamp: Date.now() }]);
    send({ type: 'text', text: cb });
  };

  const handleClearChat = () => {
    setMessages([]); send({ type: 'clear_history' }); setCurrentEmotion('neutral');
    setAppStatus('idle'); setLastTranscript(''); setLastReply('');
  };

  const handleSaveSettings = (s: AppSettings) => {
    const urlChanged = s.serverUrl !== settings.serverUrl || s.authToken !== settings.authToken;
    setSettings(s);
    if (urlChanged) disconnect();
  };

  const enterTextMode = () => { setInputMode('text'); setTimeout(() => textInputRef.current?.focus(), 100); };

  const statusText = appStatus === 'thinking' ? '🤔 Thinking...' : appStatus === 'speaking' ? '🔊 Speaking...'
    : appStatus === 'transcribing' ? '👂 Listening...' : appStatus === 'recording' ? '🔴 Recording...' : '';

  /* ===== CONNECTION DOT ===== */
  const dotColor = connState === 'connected' ? '#22c55e' : connState === 'connecting' ? '#f59e0b' : '#ef4444';

  return (
    <div className="app">
      {/* Top bar — minimal, like Android */}
      <div className="top-bar">
        <div className="conn-dot" style={{ background: dotColor }} title={connState} onClick={isConnected ? disconnect : connect} />
        {messages.length > 0 && <span className="history-count" onClick={handleClearChat} title="Clear chat">{messages.length} 🗑️</span>}
        <div style={{ flex: 1 }} />
        <button className="top-btn" onClick={() => setViewMode(viewMode === 'live2d' ? 'orb' : 'live2d')} title="Toggle avatar">
          {viewMode === 'live2d' ? '🔮' : '🎭'}
        </button>
        <button className="top-btn" onClick={() => setShowSettings(true)} title="Settings">⚙️</button>
      </div>

      {/* ===== ORB MODE ===== */}
      {viewMode === 'orb' && (
        <div className="orb-mode">
          <div className="orb-center">
            <AvatarOrb emotion={currentEmotion} status={appStatus} isPlaying={isPlaying} />
            {statusText && <div className="status-label">{statusText}</div>}
          </div>

          <div className="chat-scroll">
            {messages.map(msg => <ChatBubble key={msg.id} message={msg} onButtonClick={handleButtonClick} />)}
            <div ref={chatEndRef} />
          </div>

          {/* Bottom controls */}
          {inputMode === 'voice' ? (
            <div className="bottom-controls">
              <button className="side-btn" onClick={enterTextMode} title="Text mode">⌨️</button>
              <button className={`mic-main ${isRecording ? 'recording' : ''} ${isPlaying ? 'playing' : ''}`}
                onClick={handleMicToggle} disabled={!isConnected}>
                {isPlaying ? '⏹' : isRecording ? '⏸' : '🎙️'}
              </button>
              <button className="side-btn" onClick={() => setShowSettings(true)} title="Settings">⚙️</button>
            </div>
          ) : (
            <div className="text-input-bar">
              <button className="side-btn" onClick={() => setInputMode('voice')} title="Voice mode">🎙️</button>
              <input ref={textInputRef} type="text" className="text-input" placeholder="Type a message..."
                value={textInput} onChange={e => setTextInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSendText(); }}
                disabled={!isConnected} />
              <button className="send-btn" onClick={handleSendText} disabled={!isConnected || !textInput.trim()}>➤</button>
            </div>
          )}
        </div>
      )}

      {/* ===== LIVE2D IMMERSIVE MODE ===== */}
      {viewMode === 'live2d' && (
        <div className="live2d-mode">
          <div className="live2d-fullscreen">
            <Live2DAvatar modelPath={selectedModel.path} emotion={currentEmotion}
              audioRef={audioRef} status={appStatus} isPlaying={isPlaying} />
          </div>

          {/* Bottom overlay */}
          <div className="l2d-bottom-overlay">
            <ModelSelector currentModelId={selectedModel.id} onSelectModel={setSelectedModel} />

            {statusText && <div className="l2d-status">{statusText}</div>}

            {lastTranscript && (
              <div className="l2d-transcript">{lastTranscript}</div>
            )}
            {lastReply && (
              <div className="l2d-reply">{lastReply.length > 200 ? lastReply.slice(-200) + '...' : lastReply}</div>
            )}

            {inputMode === 'voice' ? (
              <div className="bottom-controls">
                <button className="side-btn" onClick={enterTextMode}>⌨️</button>
                <button className={`mic-main ${isRecording ? 'recording' : ''} ${isPlaying ? 'playing' : ''}`}
                  onClick={handleMicToggle} disabled={!isConnected}>
                  {isPlaying ? '⏹' : isRecording ? '⏸' : '🎙️'}
                </button>
                <button className="side-btn" onClick={() => setShowSettings(true)}>⚙️</button>
              </div>
            ) : (
              <div className="text-input-bar">
                <button className="side-btn" onClick={() => setInputMode('voice')}>🎙️</button>
                <input ref={textInputRef} type="text" className="text-input" placeholder="Type a message..."
                  value={textInput} onChange={e => setTextInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSendText(); }}
                  disabled={!isConnected} />
                <button className="send-btn" onClick={handleSendText} disabled={!isConnected || !textInput.trim()}>➤</button>
              </div>
            )}
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsModal settings={settings} onSave={handleSaveSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
