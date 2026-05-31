export function makeSessionId() {
  return `krs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeQueryVersionId() {
  return `krqv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeRunId() {
  return `krun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso() {
  return new Date().toISOString();
}