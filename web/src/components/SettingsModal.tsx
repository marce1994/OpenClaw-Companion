import { useState } from 'react';
import './SettingsModal.css';

export interface AppSettings {
  serverUrl: string;
  authToken: string;
  botName: string;
  autoPlay: boolean;
  listenMode: 'push_to_talk' | 'smart_listen';
}

interface Props {
  settings: AppSettings;
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
  };
}

export function saveSettings(s: AppSettings) {
  localStorage.setItem(`${STORAGE_PREFIX}server-url`, s.serverUrl);
  localStorage.setItem(`${STORAGE_PREFIX}auth-token`, s.authToken);
  localStorage.setItem(`${STORAGE_PREFIX}bot-name`, s.botName);
  localStorage.setItem(`${STORAGE_PREFIX}auto-play`, String(s.autoPlay));
  localStorage.setItem(`${STORAGE_PREFIX}listen-mode`, s.listenMode);
}

export function SettingsModal({ settings, onSave, onClose }: Props) {
  const [s, setS] = useState<AppSettings>({ ...settings });

  const update = (key: keyof AppSettings, value: any) =>
    setS((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>⚙️ Settings</h2>

        <label>
          Server URL
          <input
            type="text"
            value={s.serverUrl}
            onChange={(e) => update('serverUrl', e.target.value)}
            placeholder="wss://your-server:3443"
          />
        </label>

        <label>
          Auth Token
          <input
            type="password"
            value={s.authToken}
            onChange={(e) => update('authToken', e.target.value)}
            placeholder="your-auth-token"
          />
        </label>

        <label>
          Bot Name
          <input
            type="text"
            value={s.botName}
            onChange={(e) => update('botName', e.target.value)}
            placeholder="Jarvis"
          />
        </label>

        <label className="toggle-label">
          <span>Auto-play audio</span>
          <input
            type="checkbox"
            checked={s.autoPlay}
            onChange={(e) => update('autoPlay', e.target.checked)}
          />
          <span className="toggle-switch" />
        </label>

        <label>
          Listen Mode
          <select
            value={s.listenMode}
            onChange={(e) => update('listenMode', e.target.value)}
          >
            <option value="push_to_talk">Push to Talk</option>
            <option value="smart_listen">Smart Listen</option>
          </select>
        </label>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              saveSettings(s);
              onSave(s);
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
