export const BACKEND_RESTART_RECOVERY_REASON = "backend-restarted" as const;

export type RendererRecoveryReason =
  | typeof BACKEND_RESTART_RECOVERY_REASON
  | null;

const RESTART_RECOVERY_STORAGE_KEY = "codex-web:backend-restart-recovery:v1";

type SessionStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function storeBackendRestartRecoveryMarker(
  storage: SessionStorage | null,
): boolean {
  if (storage === null) {
    return false;
  }
  try {
    storage.setItem(
      RESTART_RECOVERY_STORAGE_KEY,
      BACKEND_RESTART_RECOVERY_REASON,
    );
    return true;
  } catch {
    return false;
  }
}

export function consumeBackendRestartRecoveryMarker(
  storage: SessionStorage | null,
): RendererRecoveryReason {
  if (storage === null) {
    return null;
  }

  let value: string | null = null;
  try {
    value = storage.getItem(RESTART_RECOVERY_STORAGE_KEY);
    storage.removeItem(RESTART_RECOVERY_STORAGE_KEY);
  } catch {
    return null;
  }

  return value === BACKEND_RESTART_RECOVERY_REASON
    ? BACKEND_RESTART_RECOVERY_REASON
    : null;
}
