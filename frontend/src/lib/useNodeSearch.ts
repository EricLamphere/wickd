import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';
import { isNodeQuery } from './nodeSearch';

const DEBOUNCE_MS = 150;

/** Node + column search across all projects (GET /projects/search), debounced; idle below two characters. */
export function useNodeSearch(query: string) {
  const [debounced, setDebounced] = useState(query.trim());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const enabled = isNodeQuery(debounced) && isNodeQuery(query);
  const result = useQuery({
    queryKey: ['node-search', debounced],
    queryFn: () => api.projects.searchNodes(debounced),
    enabled,
    placeholderData: keepPreviousData,
  });
  return { ...result, data: enabled ? result.data : undefined, pending: enabled && result.isFetching };
}
