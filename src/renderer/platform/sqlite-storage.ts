import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite'

export class SQLiteStorage {
  private sqlite: SQLiteConnection
  private database!: SQLiteDBConnection
  private initializePromise: Promise<void>

  constructor() {
    this.sqlite = new SQLiteConnection(CapacitorSQLite)
    this.initializePromise = this.initialize() // 初始化 Promise
  }

  // 创建并打开数据库
  private async initialize(): Promise<void> {
    try {
      // reload的时候会报connection already open错误，所以先关闭
      this.sqlite.closeConnection('chatbox.db', false)
      this.database = await this.sqlite.createConnection('chatbox.db', false, 'no-encryption', 1, false)

      // 创建表
      const createTable = `
                CREATE TABLE IF NOT EXISTS key_value (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT
                );
            `
      await this.database.open()
      await this.database.execute(createTable)
    } catch (error) {
      console.error('Failed to initialize database', error)
      throw error
    }
  }

  // 确保数据库初始化完成
  private async ensureInitialized(): Promise<void> {
    await this.initializePromise
  }

  // 插入或更新数据
  async setItem(key: string, value: string): Promise<void> {
    await this.ensureInitialized()

    try {
      const query = `
          INSERT OR REPLACE INTO key_value (key, value)
          VALUES (?, ?);
        `
      await this.database.run(query, [key, value])
    } catch (error) {
      console.error('Failed to set value', error)
      throw error
    }
  }

  // 获取值
  async getItem(key: string): Promise<string | null> {
    await this.ensureInitialized()

    try {
      const query = `
          SELECT value FROM key_value
          WHERE key = ?;
        `
      const result = await this.database.query(query, [key])
      return result.values?.[0]?.value || null
    } catch (error) {
      console.error('Failed to get value', error)
      throw error
    }
  }

  // 删除值
  async removeItem(key: string): Promise<void> {
    await this.ensureInitialized()

    try {
      const query = `
          DELETE FROM key_value
          WHERE key = ?;
        `
      await this.database.run(query, [key])
    } catch (error) {
      console.error('Failed to delete value', error)
      throw error
    }
  }

  // 获取所有键值对
  async getAllItems(): Promise<{ [key: string]: any }> {
    await this.ensureInitialized()

    try {
      const query = `
            SELECT * FROM key_value;
          `
      const result = await this.database.query(query)
      // 将结果转换为 { [key: string]: value } 格式
      const keyValueObject: { [key: string]: any } = {}
      if (result.values && result.values.length > 0) {
        result.values.forEach((row) => {
          keyValueObject[row.key] = row.value
        })
      }
      return keyValueObject
    } catch (error) {
      console.error('Failed to get all values', error)
      throw error
    }
  }

  // 获取所有键
  async getAllKeys(): Promise<string[]> {
    await this.ensureInitialized()

    try {
      const query = `
            SELECT key FROM key_value;
          `
      const result = await this.database.query(query)
      // 提取所有key
      const keys: string[] = []
      if (result.values && result.values.length > 0) {
        result.values.forEach((row) => {
          keys.push(row.key)
        })
      }
      return keys
    } catch (error) {
      console.error('Failed to get all keys', error)
      throw error
    }
  }

  // 关闭数据库
  async closeDatabase(): Promise<void> {
    await this.ensureInitialized()

    if (this.database) {
      await this.database.close()
    }
  }
}
