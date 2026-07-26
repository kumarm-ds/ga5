/**
 * Storage layer. Kept deliberately simple (in-memory Maps) and isolated
 * behind this module so it could be swapped for SQLite/Postgres later
 * without touching route or AI logic.
 *
 * NOTE: Node.js runs your JS on a single thread, so synchronous
 * read-modify-write sequences inside one function (no `await` in between)
 * are naturally atomic with respect to other requests. That's what we rely
 * on for the cancel-vs-result race and for idempotent dedup.
 */

const tasks = new Map(); // taskId -> Task record
const messageDedup = new Map(); // `${principal}::${messageId}` -> { hash, taskId }
const packageDecisionCache = new Map(); // packageContentHash -> decision (without actionId binding to a task)

export function newTaskId() {
  return "task_" + cryptoRandomId();
}
export function newContextId() {
  return "ctx_" + cryptoRandomId();
}
export function newActionId() {
  return "act_" + cryptoRandomId();
}

function cryptoRandomId() {
  // 16 bytes hex = 32 chars, comfortably over the 12-char actionId minimum.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function saveTask(task) {
  task.updatedAt = new Date().toISOString();
  tasks.set(task.taskId, task);
  return task;
}

export function getTaskById(taskId) {
  return tasks.get(taskId) || null;
}

/** Only returns the task if it belongs to the given principal; otherwise null (so callers 403/404 uniformly). */
export function getOwnedTask(principal, taskId) {
  const t = tasks.get(taskId);
  if (!t || t.principal !== principal) return null;
  return t;
}

export function listTasksForPrincipal(principal) {
  return Array.from(tasks.values()).filter((t) => t.principal === principal);
}

/**
 * Idempotency dedup lookup for message:send calls.
 * Returns:
 *  - { status: "new" }                          -> caller should process and then call recordMessage()
 *  - { status: "duplicate", taskId }             -> caller should just return the stored task
 *  - { status: "conflict" }                      -> same messageId, different content -> 409
 */
export function checkMessageDedup(principal, messageId, contentHash) {
  const key = `${principal}::${messageId}`;
  const existing = messageDedup.get(key);
  if (!existing) return { status: "new", key };
  if (existing.hash === contentHash) return { status: "duplicate", taskId: existing.taskId };
  return { status: "conflict" };
}

export function recordMessage(key, contentHash, taskId) {
  messageDedup.set(key, { hash: contentHash, taskId });
}

/**
 * Atomically move a task from one of `fromStates` to `toState`, running
 * `mutateFn(task)` to apply the rest of the change, IF the current state
 * still matches. Returns true if the transition happened, false if the
 * task was already out of the allowed states (e.g. lost a cancel/result race).
 */
export function atomicTransition(taskId, fromStates, toState, mutateFn) {
  const task = tasks.get(taskId);
  if (!task) return false;
  if (!fromStates.includes(task.state)) return false;
  task.state = toState;
  if (mutateFn) mutateFn(task);
  saveTask(task);
  return true;
}

export function getCachedPackageDecision(hash) {
  return packageDecisionCache.get(hash) || null;
}

export function setCachedPackageDecision(hash, decision) {
  packageDecisionCache.set(hash, decision);
}
