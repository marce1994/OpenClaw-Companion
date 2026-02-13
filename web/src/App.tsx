import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAudioRecorder, useAudioPlayer } from './hooks/useAudio';
import { ChatBubble } from './components/ChatBubble';
import { ChatInput } from './components/ChatInput';
import { ConnectionBar } from './components/ConnectionBar';
import { SettingsModal } from './components/SettingsModal';
import type { ChatMessage, ServerMessage } from './protocol/types';
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
  const chatEndRef = useRef<HTMLDivElement>(null);
  const streamingRef = useRef<string>('');
  const streamingIdRef = useRef<string>('');

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Audio player
  const { isPlaying, enqueue, stopPlayback } = useAudioPlayer();

  // Handle server messages
  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case 'transcription':
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'user',
              text: msg.text,
              timestamp: Date.now(),
            },
          ]);
          break;

        case 'response': {
          // Streaming text — accumulate
          streamingRef.current += msg.text;
          const text = streamingRef.current;

          setMessages((prev) => {
            const existing = prev.findIndex((m) => m.id === streamingIdRef.current);
            const updated: ChatMessage = {
              id: streamingIdRef.current || nextId(),
              role: 'assistant',
              text,
              timestamp: Date.now(),
            };

            if (!streamingIdRef.current) {
              streamingIdRef.current = updated.id;
            }

            if (existing >= 0) {
              const copy = [...prev];
              copy[existing] = updated;
              return copy;
            }
            return [...prev, updated];
          });
          break;
        }

        case 'response_end':
          streamingRef.current = '';
          streamingIdRef.current = '';
          break;

        case 'audio':
          enqueue(msg.data, msg.format);
          break;

        case 'emotion':
          setCurrentEmotion(msg.emotion);
          break;

        case 'artifact':
          setMessages((prev) => {
            // Attach artifact to last assistant message
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === 'assistant') {
                copy[i] = {
                  ...copy[i],
                  artifact: {
                    title: msg.title,
                    language: msg.language,
                    content: msg.content,
                  },
                };
                break;
              }
            }
            return copy;
          });
          break;

        case 'button':
          setMessages((prev) => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === 'assistant') {
                copy[i] = { ...copy[i], buttons: msg.buttons };
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
            {
              id: nextId(),
              role: 'system',
              text: `⚠️ ${msg.message}`,
              timestamp: Date.now(),
            },
          ]);
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
    } else {
      startRec();
    }
  };

  const handleBargeIn = () => {
    send({ type: 'barge_in' });
    stopPlayback();
  };

  const handleSendText = (text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', text, timestamp: Date.now() },
    ]);
    send({ type: 'text', text });
  };

  const handleButtonClick = (callbackData: string) => {
    send({ type: 'text', text: callbackData });
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
        <button className="settings-btn" onClick={() => setShowSettings(true)}>
          ⚙️
        </button>
      </div>

      <div className="emotion-indicator" title={`Emotion: ${currentEmotion}`}>
        {currentEmotion !== 'neutral' && (
          <span className="emotion-badge">{currentEmotion}</span>
        )}
      </div>

      <div className="chat-area">
        {messages.length === 0 && (
          <div className="empty-state">
            <p>🤖 OpenClaw Companion</p>
            <p className="empty-hint">Connect to your server and start chatting</p>
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
