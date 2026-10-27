import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Loader2, X } from 'lucide-react';
import { api } from '../../../../lib/api';
import {
  aiApi, aiErrorMessage, formatBytes, type AiModelDownloadEvent, type AiModelDto, type AiStatusDto,
} from '../../../../lib/aiApi';

interface AiSetupProps {
  status: AiStatusDto;
  downloads: Record<string, AiModelDownloadEvent>;
}

/** First-run: pick a local model and download it (or point at an endpoint in Global Settings). */
export function AiSetup({ status, downloads }: AiSetupProps) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      qc.invalidateQueries({ queryKey: ['ai-status'] });
    }
  };

  const select = (model: AiModelDto) => run(async () => {
    await api.settings.update({ ai_model: model.id });
    qc.invalidateQueries({ queryKey: ['app-settings'] });
  });

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div>
        <h3 className="text-sm font-medium text-gray-200">Set up Wicky</h3>
        <p className="mt-1 text-gray-500">
          Wicky runs on this machine, so your SQL and docs never leave it. Pick a model to download once.
        </p>
      </div>

      {!status.runtime_installed && (
        <p className="px-2 py-1.5 rounded border border-amber-800/60 bg-amber-950/30 text-amber-300">
          The local AI runtime isn&rsquo;t included in this build. Run <code>task ai:runtime</code>, or set
          WICKD_AI_ENDPOINT_URL in Global Settings to use your own server.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {status.models.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            selected={model.id === status.model_id}
            live={downloads[model.id]}
            onSelect={() => select(model)}
            onDownload={() => run(() => aiApi.downloadModel(model.id))}
            onCancel={() => run(() => aiApi.cancelDownload(model.id))}
          />
        ))}
      </div>

      {error && <p className="text-red-400 break-words">{error}</p>}
      <p className="text-gray-600">
        Already run Ollama or LM Studio? Set WICKD_AI_ENDPOINT_URL in Global Settings to use it instead.
      </p>
      {status.entitled && (
        <p className="text-gray-600">
          No model yet? Health → Test Gaps still suggests tests from column lineage (join keys and grain).
        </p>
      )}
    </div>
  );
}

interface ModelRowProps {
  model: AiModelDto;
  selected: boolean;
  live: AiModelDownloadEvent | undefined;
  onSelect: () => void;
  onDownload: () => void;
  onCancel: () => void;
}

function ModelRow({ model, selected, live, onSelect, onDownload, onCancel }: ModelRowProps) {
  const downloading = model.downloading || live?.state === 'downloading' || live?.state === 'verifying';
  const done = live && downloading ? live.bytes_done : model.bytes_done;
  const percent = Math.min(100, Math.round((done / model.size_bytes) * 100));
  const error = live?.state === 'error' ? live.error : model.error;

  return (
    <div
      onClick={onSelect}
      className={`flex flex-col gap-1.5 px-2.5 py-2 rounded border cursor-pointer transition-colors ${
        selected ? 'border-brand-600 bg-brand-950/30' : 'border-gray-800 hover:border-gray-700'
      }`}
    >
      <div className="flex items-center gap-2">
        <input type="radio" readOnly checked={selected} className="accent-brand-500" />
        <span className="font-medium text-gray-200">{model.label}</span>
        <span className="text-gray-500">{formatBytes(model.size_bytes)}</span>
        <span className="ml-auto">
          {model.downloaded ? (
            <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 size={12} /> Ready</span>
          ) : downloading ? (
            <button
              onClick={(e) => { e.stopPropagation(); onCancel(); }}
              className="flex items-center gap-1 text-gray-400 hover:text-gray-200"
              title="Cancel download (progress is kept)"
            >
              <X size={12} /> Cancel
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); onSelect(); onDownload(); }}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-surface-elevated border border-gray-700 text-gray-300 hover:bg-gray-700"
            >
              <Download size={12} /> {model.bytes_done > 0 ? 'Resume' : 'Download'}
            </button>
          )}
        </span>
      </div>
      <p className="text-gray-500">{model.description} {model.license} license.</p>
      {downloading && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded bg-gray-800 overflow-hidden">
            <div className="h-full bg-brand-500 transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <span className="flex items-center gap-1 text-gray-400 tabular-nums">
            {live?.state === 'verifying'
              ? <><Loader2 size={11} className="animate-spin" /> Verifying…</>
              : `${formatBytes(done)} / ${formatBytes(model.size_bytes)}`}
          </span>
        </div>
      )}
      {error && !downloading && <p className="text-red-400 break-words">{error}</p>}
    </div>
  );
}
