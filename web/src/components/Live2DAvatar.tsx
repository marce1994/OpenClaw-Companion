import { useEffect, useRef, useCallback } from 'react';
import * as PIXI from 'pixi.js';
import { Live2DModel, MotionPreloadStrategy } from 'pixi-live2d-display/cubism4';
import type { AppStatus } from '../protocol/types';
import './Live2DAvatar.css';

(window as any).PIXI = PIXI;

interface Props {
  emotion: string;
  status: AppStatus;
  isPlaying: boolean;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  modelPath: string;
}

const EMOTION_TO_EXPRESSION: Record<string, string> = {
  happy: 'F01',
  sad: 'F03',
  surprised: 'F06',
  thinking: 'F04',
  confused: 'F08',
  laughing: 'F05',
  neutral: '',
  angry: 'F07',
  love: 'F02',
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

  // Create PIXI app once
  useEffect(() => {
    if (!canvasRef.current || appRef.current) return;

    const app = new PIXI.Application({
      view: canvasRef.current,
      autoStart: true,
      backgroundAlpha: 0,
      resizeTo: canvasRef.current.parentElement || undefined,
      antialias: true,
    });
    appRef.current = app;

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      app.destroy(true, { children: true });
      appRef.current = null;
      modelRef.current = null;
    };
  }, []);

  // Load/swap model when modelPath changes (reuse same PIXI app)
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;

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

        // Remove old model
        if (modelRef.current) {
          app.stage.removeChild(modelRef.current);
          modelRef.current.destroy();
        }

        modelRef.current = model;

        const scale = Math.min(
          app.screen.width / model.width,
          app.screen.height / model.height
        ) * 0.8;
        model.scale.set(scale);
        model.anchor.set(0.5, 0.5);
        model.x = app.screen.width / 2;
        model.y = app.screen.height / 2;

        app.stage.addChild(model as any);
        model.motion('Idle', 0, { priority: 1 });
      } catch (e) {
        console.error('Failed to load Live2D model:', e);
      }
    })();

    return () => { cancelled = true; };
  }, [modelPath]);

  // Emotion changes
  useEffect(() => {
    const model = modelRef.current;
    if (!model || emotion === currentEmotionRef.current) return;
    currentEmotionRef.current = emotion;

    const exprName = EMOTION_TO_EXPRESSION[emotion];
    if (exprName && model.internalModel?.motionManager?.expressionManager) {
      const idx = model.internalModel.motionManager.expressionManager.definitions.findIndex(
        (def: any) => def.Name === exprName
      );
      if (idx >= 0) model.expression(idx);
    } else if (!exprName) {
      model.expression();
    }

    if (['surprised', 'angry', 'laughing', 'love'].includes(emotion)) {
      model.motion('TapBody', undefined, { priority: 2 });
    }
  }, [emotion]);

  // Audio analyser setup
  const setupAudioAnalyser = useCallback((audio: HTMLAudioElement) => {
    if (!audioContextRef.current) audioContextRef.current = new AudioContext();
    const ctx = audioContextRef.current;

    let source = sourceMapRef.current.get(audio);
    if (!source) {
      try {
        source = ctx.createMediaElementSource(audio);
        sourceMapRef.current.set(audio, source);
      } catch { return; }
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    analyserRef.current = analyser;
  }, []);

  useEffect(() => {
    if (!isPlaying) { analyserRef.current = null; return; }
    const check = () => {
      const audio = audioRef.current;
      if (audio && !analyserRef.current) setupAudioAnalyser(audio);
    };
    check();
    const iv = setInterval(check, 100);
    return () => clearInterval(iv);
  }, [isPlaying, audioRef, setupAudioAnalyser]);

  // Lip sync animation loop
  useEffect(() => {
    const animate = () => {
      const model = modelRef.current;
      if (model && analyserRef.current) {
        const data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);
        let sum = 0;
        const bins = Math.min(32, data.length);
        for (let i = 0; i < bins; i++) sum += data[i];
        const mouthValue = Math.min(1, (sum / bins / 255) * 2.5);

        const core = model.internalModel?.coreModel;
        if (core) {
          const idx = core.getParameterIndex?.('ParamMouthOpenY');
          if (idx !== undefined && idx >= 0) core.setParameterValueByIndex?.(idx, mouthValue);
        }
      }
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  return (
    <div className={`live2d-container ${isPlaying ? 'speaking' : ''} ${status === 'recording' ? 'recording' : ''}`}>
      <canvas ref={canvasRef} className="live2d-canvas" />
    </div>
  );
}
