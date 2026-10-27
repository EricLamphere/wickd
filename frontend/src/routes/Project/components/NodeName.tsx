import type { MouseEvent } from 'react';
import { OPEN_IN_FILES_TITLE } from '../lib/openInFiles';
import { typeIconFor } from '../lib/nodeTypeIcon';

/** What useOpenInFiles() returns; pass it down once per table rather than calling the hook per row. */
export interface NodeFileNav {
  canOpen: (uniqueId: string) => boolean;
  handleClick: (e: MouseEvent, uniqueId: string) => boolean;
}

interface NodeNameProps {
  uniqueId: string;
  name: string;
  resourceType?: string;
  fileNav: NodeFileNav;
  /** Smaller second line, e.g. a column or the resource type. */
  sub?: string;
}

/** A node's name with its type glyph; Cmd+click opens it in Files (underlined while Cmd is held). */
export function NodeName({ uniqueId, name, resourceType, fileNav, sub }: NodeNameProps) {
  const openable = fileNav.canOpen(uniqueId);
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <span className="shrink-0 w-3.5 text-center text-[11px] text-gray-500" aria-hidden>
        {typeIconFor(resourceType ?? uniqueId.split('.')[0])}
      </span>
      <span className="min-w-0">
        <span
          onClick={(e) => fileNav.handleClick(e, uniqueId)}
          title={openable ? OPEN_IN_FILES_TITLE : undefined}
          className={`block truncate font-mono text-[12px] text-gray-100 ${
            openable ? 'mod:cursor-pointer mod:underline mod:decoration-brand-400 mod:hover:text-brand-300 underline-offset-2' : ''
          }`}
        >
          {name}
        </span>
        {sub && <span className="block truncate text-[10px] text-gray-500">{sub}</span>}
      </span>
    </span>
  );
}
