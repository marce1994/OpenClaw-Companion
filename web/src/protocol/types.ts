// Shared message types — must match server protocol (see docs/ARCHITECTURE.md)

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

// === Server → Client ===

export interface AuthSuccessMessage {
  type: 'auth_success';
  sessionId: string;
  serverSeq: number;
  sseq: number;
}

export interface TranscriptionMessage {
  type: 'transcription';
  text: string;
  sseq: number;
}

export interface ResponseMessage {
  type: 'response';
  text: string;
  sseq: number;
}

export interface ResponseEndMessage {
  type: 'response_end';
  sseq: number;
}

export interface AudioResponseMessage {
  type: 'audio';
  data: string;
  format: string;
  sseq: number;
}

export interface EmotionMessage {
  type: 'emotion';
  emotion: string;
  sseq: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  sseq: number;
}

export interface ArtifactMessage {
  type: 'artifact';
  title: string;
  language: string;
  content: string;
  sseq: number;
}

export interface ButtonMessage {
  type: 'button';
  buttons: Array<{ text: string; callback_data: string }>;
  sseq: number;
}

export interface StopPlaybackMessage {
  type: 'stop_playback';
  sseq: number;
}

export interface PongMessage {
  type: 'pong';
  sseq: number;
}

export type ServerMessage =
  | AuthSuccessMessage
  | TranscriptionMessage
  | ResponseMessage
  | ResponseEndMessage
  | AudioResponseMessage
  | EmotionMessage
  | ErrorMessage
  | ArtifactMessage
  | ButtonMessage
  | StopPlaybackMessage
  | PongMessage;

// === Chat UI Types ===

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  timestamp: number;
  emotion?: string;
  artifact?: { title: string; language: string; content: string };
  buttons?: Array<{ text: string; callback_data: string }>;
  audio?: string; // base64
  audioFormat?: string;
}

// === Connection State ===

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
