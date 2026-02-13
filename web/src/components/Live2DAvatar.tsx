import { useEffect, useRef, useCallback } from 'react';
import * as PIXI from 'pixi.js';
import { Live2DModel, MotionPreloadStrategy } from 'pixi-live2d-display';
import type { AppStatus } from '../protocol/types';
import './Live2DAvatar.css';

// Register PIXI to window for pixi-live2d-display
(window as any).PIXI = PIXI;

interface Props {
  emotion: string;
  status: AppStatus;
  isPlaying: boolean;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  modelPath: string;  // e.g. "/OpenClaw-Companion/live2d/Haru/Haru.model3.json"
}

// Map our emotion names to Haru's expression files
const EMOTION_TO_EXPRESSION: Record<string, string> = {
  happy: 'F01',      // smile
  sad: 'F03',        // sad/cry
  surprised: 'F06',  // wide eyes
  thinking: 'F04',   // serious
  confused: 'F08',   // worried
  laughing: 'F05',   // closed-eye smile
  neutral: '',       // default
  angry: 'F07',      // angry/blush
  love: 'F02',       // excited
};

const STATUS_LABELS: Record<string, string> = {
  idle: '',
  thinking: 'Thinking...',
  speaking: 'Speaking...',
  transcribing: 'Listening...',
  recording: '🔴 Recording',
};

export function Live2DAvatar({ emotion, status, isPlaying, audioRef, modelPath }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  const modelRef = useRef<any>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceMapRef = useRef<WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>>(new WeakMap());
  const animFrameRef = useRef<number>(0);
  const currentEmotionRef = useRef<string>('neutral');

  // Initialize PIXI app and load model
  useEffect(() => {
    if (!canvasRef.current) return;

    const app = new PIXI.Application({
      view: canvasRef.current,
      autoStart: true,
      backgroundAlpha: 0,
      resizeTo: canvasRef.current.parentElement || undefined,
      antialias: true,
    });
    appRef.current = app;

    let cancelled = false;

    (async () => {
      try {
        const model = await Live2DModel.from(modelPath, {
          motionPreload: MotionPreloadStrategy.IDLE,
        });

        if (cancelled) {
          model.destroy();
          return;
        }

        modelRef.current = model;

        // Scale model to fit canvas
        const scale = Math.min(
          app.screen.width / model.width,
          app.screen.height / model.height
        ) * 0.8;
        model.scale.set(scale);
        model.anchor.set(0.5, 0.5);
        model.x = app.screen.width / 2;
        model.y = app.screen.height / 2;

        app.stage.addChild(model as any);

        // Start idle motion
        model.motion('Idle', 0, { priority: 1 });
      } catch (e) {
        console.error('Failed to load Live2D model:', e);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(animFrameRef.current);
      if (modelRef.current) {
        modelRef.current.destroy();
        modelRef.current = null;
      }
      app.destroy(false);
      appRef.current = null;
    };
  }, [modelPath]);

  // Handle emotion changes
  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    if (emotion === currentEmotionRef.current) return;
    currentEmotionRef.current = emotion;

    const expressionName = EMOTION_TO_EXPRESSION[emotion];
    if (expressionName && model.internalModel?.motionManager?.expressionManager) {
      const idx = model.internalModel.motionManager.expressionManager.definitions.findIndex(
        (def: any) => def.Name === expressionName
      );
      if (idx >= 0) {
        model.expression(idx);
      }
    } else if (!expressionName) {
      // Reset to default expression
      model.expression();
    }

    // Play a tap body motion for emphasis on strong emotions
    if (['surprised', 'angry', 'laughing', 'love'].includes(emotion)) {
      model.motion('TapBody', undefined, { priority: 2 });
    }
  }, [emotion]);

  // Lip sync from audio
  const setupAudioAnalyser = useCallback((audio: HTMLAudioElement) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    const ctx = audioContextRef.current;

    // Reuse existing source for same audio element
    let source = sourceMapRef.current.get(audio);
    if (!source) {
      try {
        source = ctx.createMediaElementSource(audio);
        sourceMapRef.current.set(audio, source);
      } catch {
        return; // Already connected
      }
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    analyserRef.current = analyser;
  }, []);

  // Monitor audioRef for lip sync
  useEffect(() => {
    if (!isPlaying) {
      analyserRef.current = null;
      return;
    }

    const checkAudio = () => {
      const audio = audioRef.current;
      if (audio && !analyserRef.current) {
        setupAudioAnalyser(audio);
      }
    };

    // Check immediately and poll briefly
    checkAudio();
    const interval = setInterval(checkAudio, 100);
    return () => clearInterval(interval);
  }, [isPlaying, audioRef, setupAudioAnalyser]);

  // Animation loop for lip sync
  useEffect(() => {
    const animate = () => {
      const model = modelRef.current;
      if (model && analyserRef.current) {
        const data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);

        // Get average volume from lower frequencies (voice range)
        let sum = 0;
        const voiceBins = Math.min(32, data.length);
        for (let i = 0; i < voiceBins; i++) sum += data[i];
        const avg = sum / voiceBins / 255;

        // Map to mouth opening (0-1)
        const mouthValue = Math.min(1, avg * 2.5);

        // Set mouth parameters directly
        const coreModel = model.internalModel?.coreModel;
        if (coreModel) {
          const paramIdx = coreModel.getParameterIndex?.('ParamMouthOpenY');
          if (paramIdx !== undefined && paramIdx >= 0) {
            coreModel.setParameterValueByIndex?.(paramIdx, mouthValue);
          }
        }
      }
      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  const statusLabel = STATUS_LABELS[status] || '';

  return (
    <div className={`live2d-container ${isPlaying ? 'speaking' : ''} ${status === 'recording' ? 'recording' : ''}`}>
      <canvas ref={canvasRef} className="live2d-canvas" />
      {statusLabel && <div className="live2d-status">{statusLabel}</div>}
    </div>
  );
}
