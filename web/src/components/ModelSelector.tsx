import './ModelSelector.css';

export interface ModelInfo {
  id: string;
  name: string;
  path: string;
}

const BASE = import.meta.env.BASE_URL;

export const AVAILABLE_MODELS: ModelInfo[] = [
  { id: 'haru', name: 'Haru', path: `${BASE}live2d/Haru/Haru.model3.json` },
  { id: 'hiyori', name: 'Hiyori', path: `${BASE}live2d/Hiyori/Hiyori.model3.json` },
];

interface Props {
  currentModelId: string;
  onSelectModel: (model: ModelInfo) => void;
}

export function ModelSelector({ currentModelId, onSelectModel }: Props) {
  return (
    <div className="model-selector">
      {AVAILABLE_MODELS.map((m) => (
        <button
          key={m.id}
          className={`model-btn ${m.id === currentModelId ? 'active' : ''}`}
          onClick={() => onSelectModel(m)}
          title={m.name}
        >
          {m.name}
        </button>
      ))}
    </div>
  );
}
