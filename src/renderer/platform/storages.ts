import { SQLiteStorage } from './sqlite-storage'
import localforage from 'localforage'
import { StorageKey } from '@/storage'
import platform from '.'
import type { Storage } from './interfaces'

export class DesktopFileStorage implements Storage {
  public ipc = window.electronAPI

  public getStorageType(): string {
    return 'DESKTOP_FILE'
  }

  public async setStoreValue(key: string, value: any) {
    // 为什么要序列化？
    // 为了实现进程通信，electron invoke 会自动对传输数据进行序列化，
    // 但如果数据包含无法被序列化的类型（比如函数）将直接报错：
    // Uncaught (in promise) Error: An object could not be cloned.
    // 因此对于数据类型不容易控制的场景，应该提前 JSON.stringify，这种序列化方式会自动处理异常类型。
    const valueJson = JSON.stringify(value)
    return this.ipc.invoke('setStoreValue', key, valueJson)
  }
  public async getStoreValue(key: string) {
    return this.ipc.invoke('getStoreValue', key)
  }
  public delStoreValue(key: string) {
    return this.ipc.invoke('delStoreValue', key)
  }
  public async getAllStoreValues(): Promise<{ [key: string]: any }> {
    const json = await this.ipc.invoke('getAllStoreValues')
    return JSON.parse(json)
  }
  public async getAllStoreKeys(): Promise<string[]> {
    return this.ipc.invoke('getAllStoreKeys')
  }
  public async setAllStoreValues(data: { [key: string]: any }) {
    await this.ipc.invoke('setAllStoreValues', JSON.stringify(data))
  }
}

export class LocalStorage implements Storage {
  // 使用LocalStorage存储的最后一个版本是ConfigVersion=6，当时只有这些key
  validStorageKeys: string[] = [
    StorageKey.ConfigVersion,
    StorageKey.Configs,
    StorageKey.Settings,
    StorageKey.MyCopilots,
    StorageKey.ChatSessions,
  ]

  public getStorageType(): string {
    return 'LOCAL_STORAGE'
  }

  public async setStoreValue(key: string, value: any) {
    // 为什么序列化成 JSON？
    // 因为 IndexedDB 作为底层驱动时，可以直接存储对象，但是如果对象中包含函数或引用，将会直接报错
    localStorage.setItem(key, JSON.stringify(value))
  }
  public async getStoreValue(key: string) {
    const json = localStorage.getItem(key)
    return json ? JSON.parse(json) : null
  }
  public async delStoreValue(key: string) {
    return localStorage.removeItem(key)
  }
  public async getAllStoreValues(): Promise<{ [key: string]: any }> {
    const ret: { [key: string]: any } = {}

    // 仅返回有效的key
    for (const key of this.validStorageKeys) {
      const val = localStorage.getItem(key)
      if (val) {
        try {
          ret[key] = JSON.parse(val)
        } catch (error) {
          console.error(`Failed to parse stored value for key "${key}":`, error)
        }
      }
    }

    return ret
  }
  public async getAllStoreKeys(): Promise<string[]> {
    // 仅返回有效的key
    return Object.keys(localStorage).filter((k) => this.validStorageKeys.includes(k))
  }
  public async setAllStoreValues(data: { [key: string]: any }): Promise<void> {
    for (const [key, value] of Object.entries(data)) {
      await this.setStoreValue(key, value)
    }
  }
}


export class MobileSQLiteStorage implements Storage {
  public getStorageType(): string {
    return 'MOBILE_SQLITE'
  }
  private sqliteStorage = new SQLiteStorage()

  public async setStoreValue(key: string, value: any) {
    await this.sqliteStorage.setItem(key, JSON.stringify(value))
  }
  public async getStoreValue(key: string) {
    const json = await this.sqliteStorage.getItem(key)
    return json ? JSON.parse(json) : null
  }
  public async delStoreValue(key: string) {
    await this.sqliteStorage.removeItem(key)
  }
  public async getAllStoreValues(): Promise<{ [key: string]: any }> {
    const items = await this.sqliteStorage.getAllItems()
    for (const key in items) {
      if (items[key] && typeof items[key] === 'string') {
        try {
          items[key] = JSON.parse(items[key])
        } catch (error) {
          console.error(`Failed to parse stored value for key "${key}":`, error)
        }
      }
    }
    return items
  }
  public async getAllStoreKeys(): Promise<string[]> {
    return this.sqliteStorage.getAllKeys()
  }
  public async setAllStoreValues(data: { [key: string]: any }): Promise<void> {
    for (const [key, value] of Object.entries(data)) {
      await this.setStoreValue(key, value)
    }
  }
}

export class IndexedDBStorage implements Storage {
  private store = localforage.createInstance({ name: 'chatboxstore' })

  public getStorageType(): string {
    return 'INDEXEDDB'
  }

  public async setStoreValue(key: string, value: any) {
    // 为什么序列化成 JSON？
    // 因为 IndexedDB 作为底层驱动时，可以直接存储对象，但是如果对象中包含函数或引用，将会直接报错
    try {
      await this.store.setItem(key, JSON.stringify(value))
    } catch (error) {
      throw new Error(`Failed to store value for key "${key}": ${(error as Error).message}`)
    }
  }
  public async getStoreValue(key: string) {
    const json = await this.store.getItem<string>(key)
    if (!json) return null
    try {
      return JSON.parse(json)
    } catch (error) {
      console.error(`Failed to parse stored value for key "${key}":`, error)
      return null
    }
  }
  public async delStoreValue(key: string) {
    return await this.store.removeItem(key)
  }
  public async getAllStoreValues(): Promise<{ [key: string]: any }> {
    const ret: { [key: string]: any } = {}
    await this.store.iterate((json, key) => {
      if (typeof json === 'string') {
        try {
          ret[key] = JSON.parse(json)
        } catch (error) {
          console.error(`Failed to parse value for key "${key}":`, error)
          ret[key] = null
        }
      } else {
        ret[key] = null
      }
    })
    return ret
  }
  public async getAllStoreKeys(): Promise<string[]> {
    return this.store.keys()
  }
  public async setAllStoreValues(data: { [key: string]: any }): Promise<void> {
    for (const [key, value] of Object.entries(data)) {
      await this.setStoreValue(key, value)
    }
  }
}

export function getOldVersionStorages(): Storage[] {
  if (platform.type === 'desktop') {
    return [new DesktopFileStorage()]
  } else if (platform.type === 'mobile') {
    return [new IndexedDBStorage(), new MobileSQLiteStorage(), new LocalStorage()]
  }
  return [new LocalStorage()]
}
