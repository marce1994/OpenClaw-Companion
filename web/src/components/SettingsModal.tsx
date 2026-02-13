import { useState } from 'react';
import './SettingsModal.css';

interface Props {
  serverUrl: string;
  authToken: string;
  onSave: (url: string, token: string) => void;
  onClose: () => void;
}

export function SettingsModal({ serverUrl, authToken, onSave, onClose }: Props) {
  const [url, setUrl] = useState(serverUrl);
  const [token, setToken] = useState(authToken);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>⚙️ Settings</h2>

        <label>
          Server URL
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="ws://localhost:3200"
          />
        </label>

        <label>
          Auth Token
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="your-auth-token"
          />
        </label>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              onSave(url, token);
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
