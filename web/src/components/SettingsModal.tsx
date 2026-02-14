import { useState } from 'react';
import type { ModelInfo } from './ModelSelector';
import './SettingsModal.css';

export interface AppSettings {
  serverUrl: string;
  authToken: string;
  botName: string;
  autoPlay: boolean;
  listenMode: 'push_to_talk' | 'smart_listen';
  selectedModel: string;
  ttsEngine: 'kokoro' | 'edge' | 'xtts';
}

interface Props {
  settings: AppSettings;
  models: ModelInfo[];
  serverTtsEngine?: string;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
}

const STORAGE_PREFIX = 'oc-';

export function loadSettings(): AppSettings {
  return {
    serverUrl: localStorage.getItem(`${STORAGE_PREFIX}server-url`) || 'ws://localhost:3200',
    authToken: localStorage.getItem(`${STORAGE_PREFIX}auth-token`) || '',
    botName: localStorage.getItem(`${STORAGE_PREFIX}bot-name`) || 'Jarvis',
    autoPlay: localStorage.getItem(`${STORAGE_PREFIX}auto-play`) !== 'false',
    listenMode: (localStorage.getItem(`${STORAGE_PREFIX}listen-mode`) as any) || 'push_to_talk',
    selectedModel: localStorage.getItem(`${STORAGE_PREFIX}model`) || 'mao',
    ttsEngine: (localStorage.getItem(`${STORAGE_PREFIX}tts-engine`) as any) || 'kokoro',
  };
}

export function saveSettings(s: AppSettings) {
  localStorage.setItem(`${STORAGE_PREFIX}server-url`, s.serverUrl);
  localStorage.setItem(`${STORAGE_PREFIX}auth-token`, s.authToken);
  localStorage.setItem(`${STORAGE_PREFIX}bot-name`, s.botName);
  localStorage.setItem(`${STORAGE_PREFIX}auto-play`, String(s.autoPlay));
  localStorage.setItem(`${STORAGE_PREFIX}listen-mode`, s.listenMode);
  localStorage.setItem(`${STORAGE_PREFIX}model`, s.selectedModel);
  localStorage.setItem(`${STORAGE_PREFIX}tts-engine`, s.ttsEngine);
}

const TTS_ENGINES = [
  { id: 'kokoro', name: '🔊 Kokoro (Local GPU, ~460ms)' },
  { id: 'edge', name: '☁️ Edge TTS (Cloud, ~2.3s)' },
  { id: 'xtts', name: '🎙️ XTTS v2 (Voice Clone, ~1s)' },
];

export function SettingsModal({ settings, models, serverTtsEngine, onSave, onClose }: Props) {
  const [s, setS] = useState<AppSettings>({ ...settings });

  const update = (key: keyof AppSettings, value: any) =>
    setS(prev => ({ ...prev, [key]: value }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>⚙️ Settings</h2>

        <label>
          Server URL
          <input type="text" value={s.serverUrl} onChange={e => update('serverUrl', e.target.value)}
            placeholder="wss://your-server:3443" />
        </label>

        <label>
          Auth Token
          <input type="password" value={s.authToken} onChange={e => update('authToken', e.target.value)}
            placeholder="your-auth-token" />
        </label>

        <label>
          Bot Name
          <input type="text" value={s.botName} onChange={e => update('botName', e.target.value)}
            placeholder="Jarvis" />
        </label>

        <label>
          Character
          <select value={s.selectedModel} onChange={e => update('selectedModel', e.target.value)}>
            {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>

        <label className="toggle-label">
          <span>Auto-play audio</span>
          <input type="checkbox" checked={s.autoPlay} onChange={e => update('autoPlay', e.target.checked)} />
          <span className="toggle-switch" />
        </label>

        <label>
          Listen Mode
          <select value={s.listenMode} onChange={e => update('listenMode', e.target.value)}>
            <option value="push_to_talk">Push to Talk</option>
            <option value="smart_listen">Smart Listen</option>
          </select>
        </label>

        <label>
          TTS Engine {serverTtsEngine && serverTtsEngine !== s.ttsEngine && <span style={{fontSize:'0.75rem',opacity:0.7}}>(server: {serverTtsEngine})</span>}
          <select value={s.ttsEngine} onChange={e => update('ttsEngine', e.target.value)}>
            {TTS_ENGINES.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => { saveSettings(s); onSave(s); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}
