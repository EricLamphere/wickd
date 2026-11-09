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
    case 'test':     return 'text-orange-400';
    case 'macro':    return 'text-purple-400';
    case 'semantic_model': return 'text-teal-400';
    case 'metric':   return 'text-sky-400';
    case 'saved_query': return 'text-indigo-400';
    case 'exposure': return 'text-purple-400';
    default:         return 'text-gray-400';
  }
}

/** Tinted pill classes per resource type (count badges, flags, consumer chips), in the same hues
 *  as resourceColor() and the Docs browser's group icons. Every resource-type chip uses this. */
export function resourcePill(type: string): string {
  switch (type) {
    case 'model':    return 'bg-brand-950/40 text-brand-300 border-brand-900/60';
    case 'seed':     return 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60';
    case 'source':   return 'bg-blue-950/40 text-blue-300 border-blue-900/60';
    case 'snapshot': return 'bg-amber-950/40 text-amber-300 border-amber-900/60';
    case 'test':     return 'bg-orange-950/40 text-orange-300 border-orange-900/60';
    case 'macro':    return 'bg-purple-950/40 text-purple-300 border-purple-900/60';
    case 'exposure': return 'bg-purple-950/40 text-purple-300 border-purple-900/60';
    case 'semantic_model': return 'bg-teal-950/40 text-teal-300 border-teal-900/60';
    case 'metric':   return 'bg-sky-950/40 text-sky-300 border-sky-900/60';
    case 'saved_query': return 'bg-indigo-950/40 text-indigo-300 border-indigo-900/60';
    default:         return 'bg-gray-800/60 text-gray-300 border-gray-700';
  }
}
