import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAudioRecorder, useAudioPlayer } from './hooks/useAudio';
import { ChatBubble } from './components/ChatBubble';
import { ChatInput } from './components/ChatInput';
import { ConnectionBar } from './components/ConnectionBar';
import { SettingsModal } from './components/SettingsModal';
import { AvatarOrb } from './components/AvatarOrb';
import { Live2DAvatar } from './components/Live2DAvatar';
import { ModelSelector, AVAILABLE_MODELS } from './components/ModelSelector';
import type { ModelInfo } from './components/ModelSelector';
import type { ChatMessage, ServerMessage, AppStatus } from './protocol/types';
import './App.css';

const STORAGE_KEY_URL = 'oc-server-url';
const STORAGE_KEY_TOKEN = 'oc-auth-token';

function getStored(key: string, fallback: string) {
  return localStorage.getItem(key) || fallback;
}

let msgCounter = 0;
function nextId() {
  return `msg-${Date.now()}-${++msgCounter}`;
}

// Extract emotion tags from text
function extractEmotion(text: string): { clean: string; emotion: string | null } {
  const match = text.match(/\[\[emotion:(\w+)\]\]/);
  const clean = text.replace(/\[\[emotion:\w+\]\]\s*/g, '');
  return { clean, emotion: match ? match[1] : null };
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [serverUrl, setServerUrl] = useState(() =>
    getStored(STORAGE_KEY_URL, 'ws://localhost:3200')
  );
  const [authToken, setAuthToken] = useState(() =>
    getStored(STORAGE_KEY_TOKEN, '')
  );
  const [showSettings, setShowSettings] = useState(false);
  const [currentEmotion, setCurrentEmotion] = useState('neutral');
  const [appStatus, setAppStatus] = useState<AppStatus>('idle');
  const [useLive2D, setUseLive2D] = useState(true);
  const [currentModel, setCurrentModel] = useState<ModelInfo>(AVAILABLE_MODELS[0]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  
  // Streaming state refs (not reactive to avoid re-renders)
  const streamingTextRef = useRef<string>('');
  const streamingIdRef = useRef<string>('');
  const streamingChunksRef = useRef<Map<number, string>>(new Map());

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Audio player
  const { isPlaying, enqueue, stopPlayback, audioRef } = useAudioPlayer();

  // Update status based on audio playback
  useEffect(() => {
    if (isPlaying) setAppStatus('speaking');
  }, [isPlaying]);

  // Handle server messages
  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      console.log('[MSG]', msg.type, msg);
      
      switch (msg.type) {
        case 'auth':
          // Handled in useWebSocket
          break;

        case 'status':
          if (msg.status === 'idle') setAppStatus('idle');
          else if (msg.status === 'thinking') setAppStatus('thinking');
          else if (msg.status === 'speaking') setAppStatus('speaking');
          else if (msg.status === 'transcribing') setAppStatus('transcribing');
          break;

        case 'transcription':
          // User's speech transcribed
          setMessages((prev) => [
            ...prev,
            { id: nextId(), role: 'user', text: msg.text, timestamp: Date.now() },
          ]);
          break;

        case 'reply_chunk': {
          // Streaming text response — ordered by index
          const { clean, emotion } = extractEmotion(msg.text);
          if (emotion) setCurrentEmotion(emotion);
          if (msg.emotion) setCurrentEmotion(msg.emotion);

          streamingChunksRef.current.set(msg.index, clean);
          
          // Rebuild full text from ordered chunks
          const chunks = streamingChunksRef.current;
          let fullText = '';
          for (let i = 0; i <= Math.max(...chunks.keys()); i++) {
            if (chunks.has(i)) fullText += chunks.get(i)! + ' ';
          }
          fullText = fullText.trim();

          setMessages((prev) => {
            const id = streamingIdRef.current || nextId();
            if (!streamingIdRef.current) streamingIdRef.current = id;

            const updated: ChatMessage = {
              id,
              role: 'assistant',
              text: fullText,
              timestamp: Date.now(),
              emotion: emotion || msg.emotion,
            };

            const idx = prev.findIndex((m) => m.id === id);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = updated;
              return copy;
            }
            return [...prev, updated];
          });
          break;
        }

        case 'audio_chunk':
          // TTS audio for a sentence
          enqueue(msg.data, 'mp3');
          if (msg.emotion) setCurrentEmotion(msg.emotion);
          break;

        case 'stream_done':
          // Response complete — reset streaming state
          streamingTextRef.current = '';
          streamingIdRef.current = '';
          streamingChunksRef.current.clear();
          setAppStatus('idle');
          break;

        case 'emotion':
          setCurrentEmotion(msg.emotion);
          break;

        case 'artifact':
          setMessages((prev) => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === 'assistant') {
                copy[i] = {
                  ...copy[i],
                  artifact: { title: msg.title, language: msg.language, content: msg.content },
                };
                break;
              }
            }
            return copy;
          });
          break;

        case 'buttons':
          setMessages((prev) => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === 'assistant') {
                copy[i] = { ...copy[i], buttons: msg.options };
                break;
              }
            }
            return copy;
          });
          break;

        case 'stop_playback':
          stopPlayback();
          break;

        case 'error':
          setMessages((prev) => [
            ...prev,
            { id: nextId(), role: 'system', text: `⚠️ ${msg.message}`, timestamp: Date.now() },
          ]);
          setAppStatus('idle');
          break;

        // Ignore pong, smart_status
        default:
          break;
      }
    },
    [enqueue, stopPlayback]
  );

  // WebSocket
  const { state: connState, send, connect, disconnect } = useWebSocket({
    url: serverUrl,
    token: authToken,
    onMessage: handleMessage,
  });

  // Audio recorder
  const { isRecording, start: startRec, stop: stopRec } = useAudioRecorder({
    onAudioChunk: (data) => send({ type: 'audio', data }),
  });

  const handleMicToggle = () => {
    if (isRecording) {
      stopRec();
      setAppStatus('idle');
    } else {
      startRec();
      setAppStatus('recording');
    }
  };

  const handleBargeIn = () => {
    send({ type: 'barge_in' });
    stopPlayback();
    setAppStatus('idle');
  };

  const handleSendText = (text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', text, timestamp: Date.now() },
    ]);
    send({ type: 'text', text });
  };

  const handleButtonClick = (callbackData: string) => {
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', text: callbackData, timestamp: Date.now() },
    ]);
    send({ type: 'text', text: callbackData });
  };

  const handleClearChat = () => {
    setMessages([]);
    send({ type: 'clear_history' });
    setCurrentEmotion('neutral');
  };

  const handleSaveSettings = (url: string, token: string) => {
    localStorage.setItem(STORAGE_KEY_URL, url);
    localStorage.setItem(STORAGE_KEY_TOKEN, token);
    setServerUrl(url);
    setAuthToken(token);
    disconnect();
  };

  return (
    <div className="app">
      <div className="header">
        <ConnectionBar
          state={connState}
          onConnect={connect}
          onDisconnect={() => {
            stopRec();
            disconnect();
          }}
        />
        <button className="header-btn" onClick={handleClearChat} title="Clear chat">
          🗑️
        </button>
        <button className="header-btn" onClick={() => setUseLive2D(!useLive2D)} title="Toggle avatar mode">
          {useLive2D ? '🎭' : '🔮'}
        </button>
        <button className="header-btn" onClick={() => setShowSettings(true)} title="Settings">
          ⚙️
        </button>
      </div>

      <div className="main-content">
        {useLive2D ? (
          <>
            <Live2DAvatar
              emotion={currentEmotion}
              status={appStatus}
              isPlaying={isPlaying}
              audioRef={audioRef}
              modelPath={currentModel.path}
            />
            <ModelSelector
              currentModelId={currentModel.id}
              onSelectModel={setCurrentModel}
            />
          </>
        ) : (
          <AvatarOrb emotion={currentEmotion} status={appStatus} isPlaying={isPlaying} />
        )}

        <div className="chat-area">
          {messages.length === 0 && (
            <div className="empty-state">
              <p className="empty-hint">Connect and start chatting</p>
            </div>
          )}
          {messages.map((msg) => (
            <ChatBubble
              key={msg.id}
              message={msg}
              onButtonClick={handleButtonClick}
            />
          ))}
          <div ref={chatEndRef} />
        </div>
      </div>

      <ChatInput
        onSendText={handleSendText}
        onMicToggle={handleMicToggle}
        isRecording={isRecording}
        isConnected={connState === 'connected'}
        isPlaying={isPlaying}
        onBargeIn={handleBargeIn}
      />

      {showSettings && (
        <SettingsModal
          serverUrl={serverUrl}
          authToken={authToken}
          onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
