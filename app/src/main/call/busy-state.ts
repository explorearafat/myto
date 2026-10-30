/**
 * Global "is the desktop busy" flag shared by presence, the call session, and
 * the task manager — a separate module so those never import each other.
 *
 * Two independent counters (a live call, autonomous tasks still running after
 * a hangup) — the phone sees "busy" when either is active. Counters (not
 * booleans) so overlapping tasks/calls can't clear each other's flag.
 */
let activeCalls = 0
let activeTasks = 0

export function setCallActive(active: boolean): void {
  activeCalls = Math.max(0, activeCalls + (active ? 1 : -1))
}

export function setTaskActive(active: boolean): void {
  activeTasks = Math.max(0, activeTasks + (active ? 1 : -1))
}

export function isBusyForCalls(): boolean {
  return activeCalls > 0 || activeTasks > 0
}

/** Test-only reset. */
export function __resetBusyStateForTest(): void {
  activeCalls = 0
  activeTasks = 0
}
