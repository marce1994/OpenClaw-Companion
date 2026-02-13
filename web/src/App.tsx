import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAudioRecorder, useAudioPlayer } from './hooks/useAudio';
import { ChatBubble } from './components/ChatBubble';
import { ChatInput } from './components/ChatInput';
import { ConnectionBar } from './components/ConnectionBar';
import { SettingsModal, loadSettings, saveSettings, type AppSettings } from './components/SettingsModal';
import { AvatarOrb } from './components/AvatarOrb';
import type { ChatMessage, ServerMessage, AppStatus } from './protocol/types';
import './App.css';

import { Live2DAvatar } from './components/Live2DAvatar';
import { ModelSelector, AVAILABLE_MODELS, type ModelInfo } from './components/ModelSelector';

let msgCounter = 0;
function nextId() {
  return `msg-${Date.now()}-${++msgCounter}`;
}

function extractEmotion(text: string): { clean: string; emotion: string | null } {
  const match = text.match(/\[\[emotion:(\w+)\]\]/);
  const clean = text.replace(/\[\[emotion:\w+\]\]\s*/g, '');
  return { clean, emotion: match ? match[1] : null };
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [currentEmotion, setCurrentEmotion] = useState('neutral');
  const [appStatus, setAppStatus] = useState<AppStatus>('idle');
  const [useLive2D, setUseLive2D] = useState(true);
  const [selectedModel, setSelectedModel] = useState<ModelInfo>(AVAILABLE_MODELS[0]); // Mao
  const chatEndRef = useRef<HTMLDivElement>(null);
  const streamingIdRef = useRef<string>('');
  const streamingChunksRef = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const { isPlaying, enqueue, stopPlayback, audioRef } = useAudioPlayer();

  useEffect(() => {
    if (isPlaying) setAppStatus('speaking');
  }, [isPlaying]);

  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case 'auth':
          break;

        case 'status':
          if (msg.status === 'idle') setAppStatus('idle');
          else if (msg.status === 'thinking') setAppStatus('thinking');
          else if (msg.status === 'speaking') setAppStatus('speaking');
          else if (msg.status === 'transcribing') setAppStatus('transcribing');
          break;

        case 'transcription':
          setMessages((prev) => [
            ...prev,
            { id: nextId(), role: 'user', text: msg.text, timestamp: Date.now() },
          ]);
          break;

        case 'reply_chunk': {
          const { clean, emotion } = extractEmotion(msg.text);
          if (emotion) setCurrentEmotion(emotion);
          if (msg.emotion) setCurrentEmotion(msg.emotion);

          streamingChunksRef.current.set(msg.index, clean);
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
              id, role: 'assistant', text: fullText, timestamp: Date.now(),
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
          setMessages((prev) => {
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

        default:
          break;
      }
    },
    [enqueue, stopPlayback, settings.autoPlay]
  );

  const { state: connState, send, connect, disconnect } = useWebSocket({
    url: settings.serverUrl,
    token: settings.authToken,
    onMessage: handleMessage,
  });

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
    setAppStatus('idle');
  };

  const handleSaveSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    // If server URL or token changed, reconnect
    if (newSettings.serverUrl !== settings.serverUrl || newSettings.authToken !== settings.authToken) {
      disconnect();
      // Will auto-connect with new settings on next render
    }
    // Update bot name on server
    if (newSettings.botName !== settings.botName) {
      send({ type: 'set_bot_name' as any, name: newSettings.botName } as any);
    }
  };

  const isConnected = connState === 'connected';

  return (
    <div className="app">
      <div className="header">
        <ConnectionBar
          state={connState}
          onConnect={connect}
          onDisconnect={() => { stopRec(); disconnect(); }}
        />
        {messages.length > 0 && (
          <button className="header-btn" onClick={handleClearChat} title="Clear chat">
            🗑️
          </button>
        )}
        <button
          className="header-btn"
          onClick={() => setUseLive2D(!useLive2D)}
          title={useLive2D ? 'Switch to Orb' : 'Switch to Live2D'}
        >
          {useLive2D ? '🔮' : '🎭'}
        </button>
        <button className="header-btn" onClick={() => setShowSettings(true)} title="Settings">
          ⚙️
        </button>
      </div>

      <div className="main-content">
        {/* Avatar area */}
        <div className="avatar-area">
          {useLive2D ? (
            <>
              <Live2DAvatar
                modelPath={selectedModel.path}
                emotion={currentEmotion}
                audioRef={audioRef}
                status={appStatus}
                isPlaying={isPlaying}
              />
              <ModelSelector currentModelId={selectedModel.id} onSelectModel={setSelectedModel} />
            </>
          ) : (
            <AvatarOrb emotion={currentEmotion} status={appStatus} isPlaying={isPlaying} />
          )}

          {/* Status text */}
          {appStatus !== 'idle' && (
            <div className="status-text">
              {appStatus === 'thinking' && '🤔 Thinking...'}
              {appStatus === 'speaking' && '🔊 Speaking...'}
              {appStatus === 'transcribing' && '👂 Listening...'}
              {appStatus === 'recording' && '🔴 Recording...'}
            </div>
          )}
        </div>

        {/* Chat messages */}
        <div className="chat-area">
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
        isConnected={isConnected}
        isPlaying={isPlaying}
        onBargeIn={handleBargeIn}
      />

      {showSettings && (
        <SettingsModal
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
