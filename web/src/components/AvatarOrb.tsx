import type { AppStatus } from '../protocol/types';
import './AvatarOrb.css';

interface Props {
  emotion: string;
  status: AppStatus;
  isPlaying: boolean;
}

const EMOTION_EMOJIS: Record<string, string> = {
  happy: '😊',
  sad: '😢',
  surprised: '😮',
  thinking: '🤔',
  confused: '😕',
  laughing: '😂',
  neutral: '🤖',
  angry: '😠',
  love: '😍',
};

const EMOTION_COLORS: Record<string, string> = {
  happy: '#fbbf24',
  sad: '#60a5fa',
  surprised: '#f472b6',
  thinking: '#a78bfa',
  confused: '#fb923c',
  laughing: '#34d399',
  neutral: '#818cf8',
  angry: '#ef4444',
  love: '#f43f5e',
};

const STATUS_LABELS: Record<string, string> = {
  idle: '',
  thinking: 'Thinking...',
  speaking: 'Speaking...',
  transcribing: 'Listening...',
  recording: '🔴 Recording',
};

export function AvatarOrb({ emotion, status, isPlaying }: Props) {
  const emoji = EMOTION_EMOJIS[emotion] || '🤖';
  const color = EMOTION_COLORS[emotion] || '#818cf8';
  const statusLabel = STATUS_LABELS[status] || '';

  const isActive = status === 'speaking' || status === 'thinking' || isPlaying;
  const isRecording = status === 'recording';

  return (
    <div className="avatar-container">
      <div
        className={`avatar-orb ${isActive ? 'active' : ''} ${isRecording ? 'recording' : ''}`}
        style={{
          '--orb-color': color,
          '--orb-glow': `${color}66`,
        } as React.CSSProperties}
      >
        <div className="avatar-rings">
          <div className="ring ring-1" />
          <div className="ring ring-2" />
          <div className="ring ring-3" />
        </div>
        <span className="avatar-emoji">{emoji}</span>
      </div>
      {statusLabel && <div className="avatar-status">{statusLabel}</div>}
    </div>
  );
}
