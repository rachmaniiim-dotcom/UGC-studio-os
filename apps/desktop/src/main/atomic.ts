import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';

/** Writes `data` to a temp file, fsyncs it, then renames it over `file`. */
export function writeAtomic(file: string, data: Buffer): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
