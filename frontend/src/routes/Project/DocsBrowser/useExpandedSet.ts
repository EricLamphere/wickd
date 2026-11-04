import { useCallback, useState } from 'react';

export function useExpandedSet(storageKey: string): [Set<string>, (key: string, open: boolean) => void, () => void, (keys: string[]) => void] {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  const toggle = useCallback((key: string, open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) {
        next.add(key);
      } else {
        // Also remove all descendants
        for (const k of next) {
          if (k === key || k.startsWith(key + '/')) next.delete(k);
        }
      }
      sessionStorage.setItem(storageKey, JSON.stringify([...next]));
      return next;
    });
  }, [storageKey]);

  const expandMany = useCallback((keys: string[]) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      sessionStorage.setItem(storageKey, JSON.stringify([...next]));
      return next;
    });
  }, [storageKey]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
    sessionStorage.removeItem(storageKey);
  }, [storageKey]);

  return [expanded, toggle, collapseAll, expandMany];
}
