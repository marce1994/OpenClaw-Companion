// Shared message types — must match server protocol (see docs/ARCHITECTURE.md)
// Updated to match actual server implementation in server/index.js

// === Client → Server ===

export interface AuthMessage {
  type: 'auth';
  token: string;
  sessionId?: string;
  lastServerSeq?: number;
}

export interface AudioMessage {
  type: 'audio';
  data: string; // base64 PCM 16-bit 16kHz mono
}

export interface TextMessage {
  type: 'text';
  text: string;
}

export interface ImageMessage {
  type: 'image';
  data: string;
  mimeType: string;
  caption?: string;
}

export interface CancelMessage {
  type: 'cancel';
}

export interface BargeInMessage {
  type: 'barge_in';
}

export interface ClearHistoryMessage {
  type: 'clear_history';
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage =
  | AuthMessage
  | AudioMessage
  | TextMessage
  | ImageMessage
  | CancelMessage
  | BargeInMessage
  | ClearHistoryMessage
  | PingMessage;

// === Server → Client (actual protocol) ===

export interface ServerAuthMessage {
  type: 'auth';
  status: 'ok';
  sessionId: string;
  serverSeq: number;
  sseq?: number;
}

export interface ReplyChunkMessage {
  type: 'reply_chunk';
  text: string;
  index: number;
  emotion?: string;
  sseq?: number;
}

export interface AudioChunkMessage {
  type: 'audio_chunk';
  data: string; // base64 MP3/WAV
  index: number;
  emotion?: string;
  text?: string;
  sseq?: number;
}

export interface StreamDoneMessage {
  type: 'stream_done';
  sseq?: number;
}

export interface StatusMessage {
  type: 'status';
  status: 'idle' | 'thinking' | 'speaking' | 'transcribing';
  sseq?: number;
}

export interface EmotionMessage {
  type: 'emotion';
  emotion: string;
  sseq?: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  sseq?: number;
}

export interface ArtifactMessage {
  type: 'artifact';
  title: string;
  language: string;
  content: string;
  sseq?: number;
}

export interface ButtonsMessage {
  type: 'buttons';
  options: Array<{ text: string; callback_data?: string; value?: string }>;
  sseq?: number;
}

export interface StopPlaybackMessage {
  type: 'stop_playback';
  sseq?: number;
}

export interface TranscriptionMessage {
  type: 'transcription';
  text: string;
  sseq?: number;
}

export interface PongMessage {
  type: 'pong';
  sseq?: number;
}

export interface SmartStatusMessage {
  type: 'smart_status';
  status: string;
  sseq?: number;
}

export type ServerMessage =
  | ServerAuthMessage
  | ReplyChunkMessage
  | AudioChunkMessage
  | StreamDoneMessage
  | StatusMessage
  | EmotionMessage
  | ErrorMessage
  | ArtifactMessage
  | ButtonsMessage
  | StopPlaybackMessage
  | TranscriptionMessage
  | PongMessage
  | SmartStatusMessage;

// === Chat UI Types ===

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  timestamp: number;
  emotion?: string;
  artifact?: { title: string; language: string; content: string };
  buttons?: Array<{ text: string; callback_data?: string; value?: string }>;
}

// === Connection State ===

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// === App Status ===

export type AppStatus = 'idle' | 'thinking' | 'speaking' | 'transcribing' | 'recording';
