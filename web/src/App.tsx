import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAudioRecorder, useAudioPlayer } from './hooks/useAudio';
import { ChatBubble } from './components/ChatBubble';
import { SettingsModal, loadSettings, type AppSettings } from './components/SettingsModal';
import { AvatarOrb } from './components/AvatarOrb';
import { Live2DAvatar } from './components/Live2DAvatar';
import { AVAILABLE_MODELS, type ModelInfo } from './components/ModelSelector';
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
  const [selectedModel, setSelectedModel] = useState<ModelInfo>(() => {
    const saved = localStorage.getItem('oc-model');
    return AVAILABLE_MODELS.find(m => m.id === saved) || AVAILABLE_MODELS[0];
  });
  const [textInput, setTextInput] = useState('');
  const [lastTranscript, setLastTranscript] = useState('');
  const [lastReply, setLastReply] = useState('');
  const [smartListenActive, setSmartListenActive] = useState(false);
  const [serverTtsEngine, setServerTtsEngine] = useState<string>('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamingIdRef = useRef<string>('');
  const streamingChunksRef = useRef<Map<number, string>>(new Map());

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Persist model selection
  useEffect(() => { localStorage.setItem('oc-model', selectedModel.id); }, [selectedModel]);

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

      case 'emotion': setCurrentEmotion(msg.emotion); break;

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

      case 'smart_status':
        if (msg.status === 'listening') setSmartListenActive(true);
        else if (msg.status === 'stopped') setSmartListenActive(false);
        break;

      case 'settings':
        if ((msg as any).ttsEngine) setServerTtsEngine((msg as any).ttsEngine);
        break;

      case 'tts_engine':
        if ((msg as any).engine) setServerTtsEngine((msg as any).engine);
        break;

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

  // Request server settings on connect
  useEffect(() => {
    if (isConnected) send({ type: 'get_settings' } as any);
  }, [isConnected, send]);

  // Smart Listen toggle
  const toggleSmartListen = useCallback(() => {
    if (smartListenActive) {
      send({ type: 'smart_listen_stop' } as any);
      stopRec();
      setSmartListenActive(false);
    } else {
      send({ type: 'smart_listen_start' } as any);
      startRec();
      setSmartListenActive(true);
    }
  }, [smartListenActive, send, startRec, stopRec]);

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
    // Apply model from settings
    const m = AVAILABLE_MODELS.find(x => x.id === s.selectedModel);
    if (m) setSelectedModel(m);
    // Apply TTS engine change
    if (s.ttsEngine !== settings.ttsEngine && isConnected) {
      send({ type: 'set_tts_engine', engine: s.ttsEngine } as any);
    }
  };

  // File/image attachment
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !isConnected) return;

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      if (file.type.startsWith('image/')) {
        send({ type: 'image', data: base64, mimeType: file.type } as any);
        setMessages(prev => [...prev, { id: nextId(), role: 'user', text: `📷 ${file.name}`, timestamp: Date.now() }]);
      } else {
        // Text file
        const textReader = new FileReader();
        textReader.onload = () => {
          send({ type: 'file', data: btoa(textReader.result as string), name: file.name, mimeType: file.type } as any);
          setMessages(prev => [...prev, { id: nextId(), role: 'user', text: `📎 ${file.name}`, timestamp: Date.now() }]);
        };
        textReader.readAsText(file);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const enterTextMode = () => { setInputMode('text'); setTimeout(() => textInputRef.current?.focus(), 100); };

  const statusText = appStatus === 'thinking' ? '🤔 Thinking...' : appStatus === 'speaking' ? '🔊 Speaking...'
    : appStatus === 'transcribing' ? '👂 Listening...' : appStatus === 'recording' ? '🔴 Recording...' : '';

  const dotColor = connState === 'connected' ? '#22c55e' : connState === 'connecting' ? '#f59e0b' : '#ef4444';

  // Shared bottom controls
  const renderControls = () => (
    inputMode === 'voice' ? (
      <div className="bottom-controls">
        <button className="side-btn" onClick={enterTextMode} title="Text mode">⌨️</button>
        <button className={`mic-main ${isRecording ? 'recording' : ''} ${isPlaying ? 'playing' : ''}`}
          onClick={handleMicToggle} disabled={!isConnected}>
          {isPlaying ? '⏹' : isRecording ? '⏸' : '🎙️'}
        </button>
        <button className={`side-btn ${smartListenActive ? 'active' : ''}`}
          onClick={toggleSmartListen} disabled={!isConnected} title="Smart Listen">
          {smartListenActive ? '👂' : '🔇'}
        </button>
      </div>
    ) : (
      <div className="text-input-bar">
        <button className="side-btn" onClick={() => setInputMode('voice')} title="Voice mode">🎙️</button>
        <button className="side-btn" onClick={() => fileInputRef.current?.click()} title="Attach file">📎</button>
        <input ref={textInputRef} type="text" className="text-input" placeholder="Type a message..."
          value={textInput} onChange={e => setTextInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSendText(); }}
          disabled={!isConnected} />
        <button className="send-btn" onClick={handleSendText} disabled={!isConnected || !textInput.trim()}>➤</button>
      </div>
    )
  );

  return (
    <div className="app">
      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" accept="image/*,.txt,.md,.json,.csv,.js,.ts,.py,.html,.css"
        style={{ display: 'none' }} onChange={handleFileSelect} />

      {/* Top bar */}
      <div className="top-bar">
        <div className="conn-dot" style={{ background: dotColor }} title={connState} onClick={isConnected ? disconnect : connect} />
        {messages.length > 0 && <span className="history-count" onClick={handleClearChat} title="Clear chat">{messages.length} 🗑️</span>}
        <div style={{ flex: 1 }} />
        <button className="top-btn" onClick={() => setViewMode(viewMode === 'live2d' ? 'orb' : 'live2d')}>
          {viewMode === 'live2d' ? '🔮' : '🎭'}
        </button>
        <button className="top-btn" onClick={() => setShowSettings(true)}>⚙️</button>
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
          {renderControls()}
        </div>
      )}

      {/* ===== LIVE2D IMMERSIVE MODE ===== */}
      {viewMode === 'live2d' && (
        <div className="live2d-mode">
          <div className="live2d-fullscreen">
            <Live2DAvatar modelPath={selectedModel.path} emotion={currentEmotion}
              audioRef={audioRef} status={appStatus} isPlaying={isPlaying} />
          </div>
          <div className="l2d-chat-overlay">
            {/* Model selector as horizontal scroll */}
            <div className="l2d-models">
              {AVAILABLE_MODELS.map(m => (
                <button key={m.id} className={`model-pill ${m.id === selectedModel.id ? 'active' : ''}`}
                  onClick={() => setSelectedModel(m)}>{m.name}</button>
              ))}
            </div>
            <div className="l2d-chat-scroll">
              {messages.map(msg => <ChatBubble key={msg.id} message={msg} onButtonClick={handleButtonClick} />)}
              <div ref={chatEndRef} />
            </div>
            {statusText && <div className="l2d-status">{statusText}</div>}
            {renderControls()}
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsModal settings={settings} models={AVAILABLE_MODELS} serverTtsEngine={serverTtsEngine} onSave={handleSaveSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
