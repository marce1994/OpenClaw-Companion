import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ConnectionState, ServerMessage } from '../protocol/types';

interface UseWebSocketOptions {
  url: string;
  token: string;
  onMessage: (msg: ServerMessage) => void;
  reconnectInterval?: number;
  pingInterval?: number;
}

export function useWebSocket({
  url,
  token,
  onMessage,
  reconnectInterval = 3000,
  pingInterval = 25000,
}: UseWebSocketOptions) {
  const [state, setState] = useState<ConnectionState>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const lastSeqRef = useRef<number>(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pingTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const mountedRef = useRef(true);

  // Store onMessage in a ref so it doesn't cause reconnection loops
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // Store url/token in refs too
  const urlRef = useRef(url);
  urlRef.current = url;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setState('connecting');
    const ws = new WebSocket(urlRef.current);
    wsRef.current = ws;

    ws.onopen = () => {
      const auth: any = { type: 'auth', token: tokenRef.current };
      if (sessionIdRef.current) {
        auth.sessionId = sessionIdRef.current;
        auth.lastServerSeq = lastSeqRef.current;
      }
      ws.send(JSON.stringify(auth));

      pingTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, pingInterval);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage;

        if (msg.type === 'auth_success') {
          sessionIdRef.current = msg.sessionId;
          lastSeqRef.current = msg.serverSeq;
          setState('connected');
        }

        if ('sseq' in msg && typeof msg.sseq === 'number') {
          lastSeqRef.current = Math.max(lastSeqRef.current, msg.sseq);
        }

        onMessageRef.current(msg);
      } catch (e) {
        console.error('Failed to parse WS message:', e);
      }
    };

    ws.onclose = () => {
      if (pingTimer.current) clearInterval(pingTimer.current);
      if (!mountedRef.current) return;
      setState('disconnected');
      reconnectTimer.current = setTimeout(connect, reconnectInterval);
    };

    ws.onerror = () => {
      setState('error');
      ws.close();
    };
  }, [reconnectInterval, pingInterval]);

  const disconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (pingTimer.current) clearInterval(pingTimer.current);
    wsRef.current?.close();
    wsRef.current = null;
    setState('disconnected');
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      disconnect();
    };
  }, [disconnect]);

  return { state, send, connect, disconnect };
}
