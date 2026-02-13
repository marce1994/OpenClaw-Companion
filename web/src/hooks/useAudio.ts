import { useCallback, useRef, useState } from 'react';

interface UseAudioOptions {
  onAudioChunk: (base64Pcm: string) => void;
  sampleRate?: number;
  chunkIntervalMs?: number;
}

export function useAudioRecorder({
  onAudioChunk,
  sampleRate = 16000,
  chunkIntervalMs = 250,
}: UseAudioOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const bufferRef = useRef<Float32Array[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const context = new AudioContext({ sampleRate });
      const source = context.createMediaStreamSource(stream);

      // ScriptProcessor for raw PCM access (AudioWorklet is better but more complex)
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        bufferRef.current.push(new Float32Array(data));
      };

      source.connect(processor);
      processor.connect(context.destination);

      streamRef.current = stream;
      contextRef.current = context;
      processorRef.current = processor;

      // Send chunks at interval
      intervalRef.current = setInterval(() => {
        if (bufferRef.current.length === 0) return;

        const chunks = bufferRef.current;
        bufferRef.current = [];

        // Merge float32 chunks
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }

        // Convert float32 to int16 PCM
        const pcm = new Int16Array(merged.length);
        for (let i = 0; i < merged.length; i++) {
          const s = Math.max(-1, Math.min(1, merged[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Convert to base64
        const bytes = new Uint8Array(pcm.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        onAudioChunk(btoa(binary));
      }, chunkIntervalMs);

      setIsRecording(true);
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  }, [onAudioChunk, sampleRate, chunkIntervalMs]);

  const stop = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    processorRef.current?.disconnect();
    contextRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    bufferRef.current = [];
    setIsRecording(false);
  }, []);

  return { isRecording, start, stop };
}

export function useAudioPlayer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const playingRef = useRef<boolean>(false);

  const playNext = useCallback(() => {
    if (queueRef.current.length === 0) {
      playingRef.current = false;
      setIsPlaying(false);
      return;
    }

    playingRef.current = true;
    setIsPlaying(true);
    const dataUrl = queueRef.current.shift()!;

    const audio = new Audio(dataUrl);
    audioRef.current = audio;
    audio.onended = () => playNext();
    audio.onerror = () => playNext();
    audio.play().catch(() => playNext());
  }, []);

  const enqueue = useCallback(
    (base64: string, format: string) => {
      const mimeType = format === 'wav' ? 'audio/wav' : 'audio/mpeg';
      const dataUrl = `data:${mimeType};base64,${base64}`;
      queueRef.current.push(dataUrl);
      if (!playingRef.current) playNext();
    },
    [playNext]
  );

  const stopPlayback = useCallback(() => {
    queueRef.current = [];
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    playingRef.current = false;
    setIsPlaying(false);
  }, []);

  return { isPlaying, enqueue, stopPlayback };
}
