# Live2D Web Integration - Research & Implementation Notes

## Stack Choice

- **pixi-live2d-display@0.5.0-beta** - PixiJS plugin for rendering Live2D models (MIT license)
- **pixi.js@7.4.3** - Rendering engine (v7 required by the beta; v8 not yet supported)
- **Cubism Core SDK** - `live2dcubismcore.min.js` loaded via `<script>` tag from `public/live2d/`
  - Downloaded from: `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`
  - Required at runtime before any Live2D model loading

### Why pixi-live2d-display?
- Most popular wrapper (1.5k+ stars), MIT licensed
- Handles model loading, motion management, expressions, physics
- Clean API: `Live2DModel.from(url)`, `model.expression()`, `model.motion()`
- Alternative was official Cubism SDK directly — much more boilerplate

## Models

Two sample models from Live2D's official CubismWebSamples repo (develop branch):
- **Haru** - Has 8 expressions (F01-F08), Idle + TapBody motions, physics, pose
- **Hiyori** - No expressions, Idle + TapBody motions, physics, pose

Models located in `public/live2d/{ModelName}/`

### License
Live2D sample models are under the [Live2D Open Software License](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html) — free for development/non-commercial use. For commercial use, a Live2D license is needed.

The Cubism Core runtime is proprietary but free to use under the Live2D Proprietary Software License.

## Emotion Mapping

Haru's expressions mapped to app emotions:
| App Emotion | Expression | Effect |
|---|---|---|
| happy | F01 | Smile (mouth form) |
| sad | F03 | Sad brows, cry mouth |
| surprised | F06 | Wide eyes, open mouth |
| thinking | F04 | Serious/focused |
| confused | F08 | Worried |
| laughing | F05 | Closed-eye smile |
| neutral | (reset) | Default |
| angry | F07 | Angry brows, blush |
| love | F02 | Excited, open mouth |

Models without expressions (Hiyori) will only show motions.

## Lip Sync

Uses Web Audio API `AnalyserNode` connected to the `HTMLAudioElement`:
1. `createMediaElementSource()` from the playing audio element
2. `AnalyserNode` with FFT analysis of lower frequency bins (voice range)
3. Average volume mapped to `ParamMouthOpenY` parameter (0-1)
4. Updated every animation frame via `requestAnimationFrame`

**Caveat**: `createMediaElementSource()` can only be called once per audio element. We use a `WeakMap` to track already-connected elements.

## Architecture

- `Live2DAvatar.tsx` - Main component, manages PIXI app, model loading, expressions, lip sync
- `ModelSelector.tsx` - Simple button bar to switch between models
- `AvatarOrb.tsx` - Original emoji orb (kept as fallback, toggle with 🎭 button)
- Toggle between Live2D and orb mode via header button

## Build Notes

- Cubism Core loaded as external script in `index.html` (not bundled by Vite)
- pixi.js v7 adds ~580KB gzipped to the bundle — could be code-split if needed
- `public/live2d/` directory copied as-is to `dist/live2d/` by Vite

## Future Improvements

- Add more models (Mao from CubismWebSamples, community models)
- Custom expressions for models without them (set parameters directly)
- Better lip sync with phoneme detection
- Mouse/touch following (pixi-live2d-display supports it natively)
- Code-split pixi.js for smaller initial load
