import { Tag } from 'lucide-react';
import { useTagFlow, useTagParam } from './useTagFlow';

/** Docs left pane, Tags tab: the project's propagating tags (PROPAGATE_TAGS). */
export function TagBrowseList({ projectId }: { projectId: number }) {
  const [param, setTag] = useTagParam();
  const { flow, locked } = useTagFlow(projectId, param);
  const tags = flow?.tags ?? [];
  const active = param ?? flow?.tag ?? null;

  return (
    <div className="flex flex-col gap-0.5 px-2 py-1">
      {tags.map((tag) => (
        <button
          key={tag}
          onClick={() => setTag(tag)}
          className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded text-left font-mono ${
            tag === active ? 'bg-brand-900/50 text-brand-300' : 'text-gray-400 hover:bg-surface-elevated/60 hover:text-gray-200'
          }`}
        >
          <Tag className="w-3 h-3 shrink-0" /> {tag}
        </button>
      ))}
      <p className="px-2 pt-2 text-[11px] text-gray-600 leading-snug">
        {locked
          ? 'Trace where tagged columns end up through column lineage (wickd Pro).'
          : <>Which tags are traced is a project setting: <span className="font-mono">PROPAGATE_TAGS</span> on the Environment page.</>}
      </p>
    </div>
  );
}
