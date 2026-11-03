import {
  Bookmark, Boxes, Database, FileCode2, FlaskConical, Layers, Sigma, Sprout, Wrench,
} from 'lucide-react';

/** Icon per dbt resource type — shared by the Docs browser groups and the project home tiles. */
export function resourceIcon(type: string, cls = 'w-3.5 h-3.5 shrink-0') {
  switch (type) {
    case 'model':    return <FileCode2 className={cls} />;
    case 'seed':     return <Sprout className={cls} />;
    case 'source':   return <Database className={cls} />;
    case 'snapshot': return <Layers className={cls} />;
    case 'test':     return <FlaskConical className={cls} />;
    case 'macro':    return <Wrench className={cls} />;
    case 'semantic_model': return <Boxes className={cls} />;
    case 'metric':   return <Sigma className={cls} />;
    case 'saved_query': return <Bookmark className={cls} />;
    default:         return <FileCode2 className={cls} />;
  }
}

/** Text color per dbt resource type, matching resourceIcon(). */
export function resourceColor(type: string) {
  switch (type) {
    case 'model':    return 'text-brand-400';
    case 'seed':     return 'text-emerald-400';
    case 'source':   return 'text-blue-400';
    case 'snapshot': return 'text-amber-400';
    case 'test':     return 'text-red-400';
    case 'macro':    return 'text-purple-400';
    case 'semantic_model': return 'text-teal-400';
    case 'metric':   return 'text-sky-400';
    case 'saved_query': return 'text-indigo-400';
    default:         return 'text-gray-400';
  }
}
