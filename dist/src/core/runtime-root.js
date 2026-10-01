/**
 * Background-task runtime root.
 *
 * Upstream hardcodes every runtime path under the project working copy:
 *
 *   <cwd>/.pi/tasks/<runId>/      background shell tasks
 *   <cwd>/.pi/delegate/<run>/<id>/ delegate artifacts + child session
 *   <cwd>/.pi/fusion/<run>/       fusion run artifacts
 *
 * That keeps runtime state inside the repository (and inside iCloud-synced
 * vaults), which makes it invisible to any collector that only walks the Pi
 * session tree, and forces every project to carry a `.pi/` ignore entry.
 *
 * This fork resolves one root outside the project instead, so runtime state is
 * centralised under the Pi home and never touches a working copy:
 *
 *   <root>/tasks/<runId>/
 *   <root>/delegate/<run>/<taskId>/
 *   <root>/fusion/<sessionDir>/<runId>/
 *
 * `PI_BG_RUNTIME_DIR` overrides the root; it exists so a test or a sandboxed
 * host can relocate state without patching code. The child process inherits the
 * resolved root through `PI_BG_DELEGATE_ARTIFACT_DIR`, so parent and child
 * always agree even when the override is set.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
/** Directory name created under the Pi home when no override is set. */
export const DEFAULT_RUNTIME_DIR_NAME = 'bg-tasks';
/** Environment variable that relocates the whole runtime tree. */
export const RUNTIME_DIR_ENV = 'PI_BG_RUNTIME_DIR';
/**
 * Resolve the runtime root as an absolute path.
 *
 * A relative `PI_BG_RUNTIME_DIR` is rejected rather than silently resolved
 * against `process.cwd()`: the parent process and its delegate children are not
 * guaranteed to share a working directory, so a relative root would let the two
 * halves of one run disagree about where artifacts live.
 */
export function resolveRuntimeRoot(options = {}) {
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    const override = env[RUNTIME_DIR_ENV]?.trim();
    if (override) {
        if (!isAbsolute(override)) {
            throw new Error(`${RUNTIME_DIR_ENV} must be an absolute path; received ${JSON.stringify(override)}`);
        }
        return resolve(override);
    }
    return join(home, '.pi', DEFAULT_RUNTIME_DIR_NAME);
}
/**
 * Render a runtime path for tool output.
 *
 * Runtime paths are absolute and long; `bg_logs` / `bg_result` echo them back to
 * the model, so the home prefix is collapsed to `~` to keep those strings short
 * without changing which directory they name.
 */
export function displayRuntimePath(absPath, home = homedir()) {
    if (!home)
        return absPath;
    const prefix = home.endsWith(sep) ? home : home + sep;
    return absPath === home ? '~' : absPath.startsWith(prefix) ? `~${sep}${absPath.slice(prefix.length)}` : absPath;
}
//# sourceMappingURL=runtime-root.js.map