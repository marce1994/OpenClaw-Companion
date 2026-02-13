import type { ConnectionState } from '../protocol/types';
import './ConnectionBar.css';

interface Props {
  state: ConnectionState;
  onConnect: () => void;
  onDisconnect: () => void;
}

const STATUS_MAP: Record<ConnectionState, { label: string; color: string }> = {
  disconnected: { label: 'Disconnected', color: '#ef4444' },
  connecting: { label: 'Connecting...', color: '#f59e0b' },
  connected: { label: 'Connected', color: '#22c55e' },
  error: { label: 'Error', color: '#ef4444' },
};

export function ConnectionBar({ state, onConnect, onDisconnect }: Props) {
  const status = STATUS_MAP[state];

  return (
    <div className="connection-bar">
      <div className="status">
        <span className="status-dot" style={{ background: status.color }} />
        {status.label}
      </div>
      {state === 'connected' ? (
        <button className="conn-btn disconnect" onClick={onDisconnect}>
          Disconnect
        </button>
      ) : (
        <button
          className="conn-btn connect"
          onClick={onConnect}
          disabled={state === 'connecting'}
        >
          Connect
        </button>
      )}
    </div>
  );
}
