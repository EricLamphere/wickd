// Typed helpers for lineage propagation (wickd Pro): inherited descriptions and tag flow.
// Proposals it creates are regular AI proposals of kind "propagate" (see aiApi.ts).
import { ApiError, get, post } from './api';
import type { AiProposalDto, PropagationHop } from './aiApi';

export interface DescriptionPreviewDto {
  fillable: number;
  conflicts: number;
  /** unique_id → fillable columns */
  by_node: Record<string, number>;
}

export interface TagFlowColumnDto {
  unique_id: string;
  name: string;
  resource_type: string;
  column: string;
  declared: boolean;
  via_kind: string | null;
  /** from the declaring column to this one; each hop after the first carries the edge kind */
  path: PropagationHop[];
}

export interface TagFlowDto {
  tag: string;
  /** the project's propagating tags (PROPAGATE_TAGS) */
  tags: string[];
  columns: TagFlowColumnDto[];
  exposures: { unique_id: string; name: string; via: string[] }[];
}

/** Why propagation can't run yet: no lineage, still computing, failed, or too old to record transform kinds. */
export type LineageNotReadyReason = 'missing' | 'running' | 'outdated' | 'error';

export function lineageNotReadyReason(err: unknown): LineageNotReadyReason | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body as { error?: string; reason?: LineageNotReadyReason } | null;
  return body?.error === 'lineage_not_ready' ? body.reason ?? 'missing' : null;
}

export const propagationApi = {
  previewDescriptions: (projectId: number, uniqueId?: string) =>
    get<DescriptionPreviewDto>(
      `/projects/${projectId}/propagate/descriptions${uniqueId ? `?unique_id=${encodeURIComponent(uniqueId)}` : ''}`,
    ),
  /** uniqueIds: limit to these nodes (default: the whole project). */
  propagateDescriptions: (projectId: number, uniqueIds?: string[]) =>
    post<AiProposalDto>(`/projects/${projectId}/propagate/descriptions`, { unique_ids: uniqueIds ?? null }),
  tagFlow: (projectId: number, tag?: string) =>
    get<TagFlowDto>(`/projects/${projectId}/lineage/tag-flow${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`),
  /** tag: just this one (default: every propagating tag). */
  propagateTags: (projectId: number, tag?: string) =>
    post<AiProposalDto>(`/projects/${projectId}/propagate/tags`, { tag: tag ?? null }),
};
