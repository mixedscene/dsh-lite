import { type BrowserWindow, ipcMain } from 'electron'

/** Retains updater IPC compatibility without contacting or installing official updates. */
export class AppUpdater {
  constructor(getWindow: () => BrowserWindow | null) {
    ipcMain.removeHandler('updater:check')
    ipcMain.handle('updater:check', () => {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('updater:not-available')
      }
      return { started: false }
    })

    ipcMain.removeHandler('install-update')
    ipcMain.handle('install-update', () => undefined)
  }

  async tryUpdate(): Promise<null> {
    return null
  }
}
