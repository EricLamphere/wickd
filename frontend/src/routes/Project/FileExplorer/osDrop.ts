import type { UploadEntry } from '../../../lib/api';

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries returns batches (100 in Chrome) until it returns an empty one
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () => reader.readEntries((batch) => {
      if (batch.length === 0) resolve(all);
      else { all.push(...batch); next(); }
    }, reject);
    next();
  });
}

async function collect(entry: FileSystemEntry, prefix: string): Promise<UploadEntry[]> {
  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    return [{ file, relativePath }];
  }
  const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
  return (await Promise.all(children.map((c) => collect(c, relativePath)))).flat();
}

/** True for a drag carrying files from the OS (Finder, Explorer, the desktop). */
export function isOsFileDrag(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes('Files');
}

/**
 * Files dropped from the OS, folders walked recursively so their structure is
 * kept. Entries must be taken synchronously in the drop handler — the
 * DataTransfer is emptied once the handler yields — so call this before any await.
 */
export function collectDroppedFiles(dt: DataTransfer): Promise<UploadEntry[]> {
  const entries = Array.from(dt.items)
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) {
    return Promise.resolve(Array.from(dt.files).map((file) => ({ file, relativePath: file.name })));
  }
  return Promise.all(entries.map((e) => collect(e, ''))).then((lists) => lists.flat());
}
