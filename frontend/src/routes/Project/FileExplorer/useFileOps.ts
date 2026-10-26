import { useCallback, useState } from 'react';
import { api, ApiError, type MovedPathDto, type UploadEntry } from '../../../lib/api';
import { parentDir, topLevelPaths } from './treeOps';
import { confirmDialog } from '../../../lib/dialogs';

export interface TreeClipboard {
  mode: 'copy' | 'cut';
  paths: string[];
}

export interface FileOpsCallbacks {
  /** Re-read the tree after a change. */
  reload: () => Promise<void>;
  /** Paths that moved (rename, drag, cut + paste) — the page follows the open file. */
  onMoved: (moves: MovedPathDto[]) => void;
  onDeleted: (paths: string[]) => void;
  onCreatedFile: (path: string) => void;
}

/** The server's `detail` when there is one, else the error text. */
export function fileOpErrorMessage(err: unknown): string {
  if (err instanceof ApiError && typeof err.body === 'string') return err.body;
  return err instanceof Error ? err.message : String(err);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Every tree mutation: one place for the API call, the reload and the error toast. */
export function useFileOps(projectId: number, cb: FileOpsCallbacks) {
  const [error, setError] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<TreeClipboard | null>(null);
  const { reload, onMoved, onDeleted, onCreatedFile } = cb;

  const run = useCallback(async <T,>(op: () => Promise<T>): Promise<T | null> => {
    setError(null);
    try {
      return await op();
    } catch (err) {
      setError(fileOpErrorMessage(err));
      return null;
    } finally {
      await reload();
    }
  }, [reload]);

  const move = useCallback(async (paths: string[], destDir: string) => {
    const moves = await run(() => api.files.move(projectId, topLevelPaths(paths), destDir));
    if (moves?.length) onMoved(moves);
    return moves;
  }, [projectId, run, onMoved]);

  const copy = useCallback(
    (paths: string[], destDir: string) => run(() => api.files.copy(projectId, topLevelPaths(paths), destDir)),
    [projectId, run],
  );

  const rename = useCallback(async (path: string, newName: string) => {
    const node = await run(() => api.files.rename(projectId, path, newName));
    if (node) onMoved([{ src: path, dst: node.path, is_dir: node.is_dir }]);
  }, [projectId, run, onMoved]);

  const remove = useCallback(async (paths: string[]) => {
    const targets = topLevelPaths(paths);
    if (targets.length === 0) return;
    const what = targets.length === 1 ? `'${targets[0]}'` : `these ${targets.length} items`;
    if (!await confirmDialog(`Delete ${what}? Folders are deleted with everything in them. This cannot be undone.`, { confirmLabel: 'Delete', danger: true })) return;
    const deleted: string[] = [];
    await run(async () => {
      for (const p of targets) {
        await api.files.delete(projectId, p);
        deleted.push(p);
      }
    });
    if (deleted.length) onDeleted(deleted);
  }, [projectId, run, onDeleted]);

  const create = useCallback(async (dir: string, name: string, isDir: boolean) => {
    if (name.includes('/') || name.includes('\\')) {
      setError('Names can’t contain / or \\ — create the folder first.');
      return;
    }
    const node = await run(() => api.files.newFile(projectId, name, dir, isDir));
    if (node && !isDir) onCreatedFile(joinPath(dir, name));
  }, [projectId, run, onCreatedFile]);

  const paste = useCallback(async (destDir: string) => {
    if (!clipboard) return;
    if (clipboard.mode === 'cut') {
      const moves = await move(clipboard.paths, destDir);
      if (moves) setClipboard(null);
    } else {
      await copy(clipboard.paths, destDir);
    }
  }, [clipboard, move, copy]);

  const duplicate = useCallback((path: string) => copy([path], parentDir(path)), [copy]);

  const upload = useCallback(async (entries: UploadEntry[], destDir: string) => {
    if (entries.length === 0) return;
    await run(async () => {
      try {
        await api.files.upload(projectId, entries, destDir);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        if (!await confirmDialog(`${fileOpErrorMessage(err)}\n\nReplace the existing file(s)?`)) return;
        await api.files.upload(projectId, entries, destDir, true);
      }
    });
  }, [projectId, run]);

  const reveal = useCallback((path: string) => run(() => api.files.reveal(projectId, path)), [projectId, run]);

  return {
    error, setError, clearError: () => setError(null), clipboard, setClipboard,
    move, copy, rename, remove, create, paste, duplicate, upload, reveal,
  };
}
