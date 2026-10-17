import { create } from 'zustand'

export type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'

interface UpdateState {
  status: UpdateStatus
  progress: number
  version: string | null
  error: string | null
  dismissedVersion: string | null
}

interface UpdateActions {
  dismiss(): void
}

const inactiveUpdateState: UpdateState = {
  status: 'idle',
  progress: 0,
  version: null,
  error: null,
  dismissedVersion: null,
}

export const useUpdateStore = create<UpdateState & UpdateActions>((set, get) => ({
  ...inactiveUpdateState,
  dismiss() {
    set({ dismissedVersion: get().version })
  },
}))

export function installUpdate(): void {
  useUpdateStore.setState(inactiveUpdateState)
}

// Preserve the bootstrap API without subscribing to stale official updater events.
export function initUpdateListeners(): void {
  useUpdateStore.setState(inactiveUpdateState)
}
