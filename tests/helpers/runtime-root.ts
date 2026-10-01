/**
 * Runtime-root isolation for tests.
 *
 * This fork resolves background-task state under `~/.pi/bg-tasks` instead of
 * the project working copy. Tests must never write there, so every suite that
 * exercises a runtime path pins `PI_BG_RUNTIME_DIR` at a fresh temp directory
 * and restores the previous value afterwards.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_DIR_ENV } from '../../src/core/runtime-root.js';

export interface IsolatedRuntimeRoot {
  /** Absolute temp root that runtime paths resolve under. */
  abs: string;
  /** Restore the previous env value and delete the temp tree. */
  restore: () => Promise<void>;
}

/**
 * Point `PI_BG_RUNTIME_DIR` at a fresh temp directory.
 *
 * `resolveRuntimeRoot()` reads `process.env` on every call, so this takes effect
 * for stores created after the call without any module reloading.
 */
export async function isolateRuntimeRoot(label = 'pi-bg-runtime-'): Promise<IsolatedRuntimeRoot> {
  const abs = await mkdtemp(join(tmpdir(), label));
  const previous = process.env[RUNTIME_DIR_ENV];
  process.env[RUNTIME_DIR_ENV] = abs;
  let restored = false;
  return {
    abs,
    restore: async () => {
      if (restored) return;
      restored = true;
      if (previous === undefined) delete process.env[RUNTIME_DIR_ENV];
      else process.env[RUNTIME_DIR_ENV] = previous;
      await rm(abs, { recursive: true, force: true });
    },
  };
}
