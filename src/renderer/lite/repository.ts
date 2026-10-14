import { SessionSchema, type Session, type SessionMetaRecord } from '@shared/types/session'
import { getSQLiteStorage, type SQLiteStorage } from '../platform/sqlite-storage'
import { SQLiteSessionMetaStorage } from '../storage/SQLiteSessionMetaStorage'
import type { ConversationSkill } from './skills'

export class LiteRepository {
  private values: SQLiteStorage | undefined
  private meta = new SQLiteSessionMetaStorage()
  private writes: Promise<void> = Promise.resolve()
  private sessionWrites: Promise<void> = Promise.resolve()
  private get db() { return this.values ??= getSQLiteStorage() }
  async get<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.db.getItem(key)
    return raw === null ? fallback : JSON.parse(raw) as T
  }
  set<T>(key: string, value: T): Promise<void> {
    const snapshot = JSON.stringify(value)
    const next = this.writes.catch(() => {}).then(() => this.db.setItem(key, snapshot))
    this.writes = next
    return next
  }
  async list(accountId: string): Promise<SessionMetaRecord[]> {
    const owners = await this.get<Record<string,string>>('lite:session-owners', {})
    const rows = await Promise.all(Object.keys(owners).filter(id=>owners[id]===accountId).map(id=>this.meta.getById(id)))
    return rows.filter((row): row is SessionMetaRecord => row !== null).sort((a,b) => b.sortOrder-a.sortOrder)
  }
  async load(id: string, accountId: string): Promise<Session> {
    const session = SessionSchema.parse(await this.get<unknown>(`session:${id}`, null))
    if (session.antigravity?.accountId !== accountId) throw new Error('此会话属于另一个账号，请先切换账号。')
    let changed = false
    for (const message of session.messages) {
      if (message.generating) {
        message.generating = false
        if (message.antigravity) { message.antigravity.complete=false; message.antigravity.status='cancelled' }
        message.error='上次生成已中断，部分回复不会用于后续上下文。'
        changed = true
      }
    }
    if (changed) await this.save(session)
    return session
  }
  save(session: Session): Promise<void> {
    const snapshot = structuredClone(session)
    const next = this.sessionWrites.catch(() => {}).then(() => this.persistSession(snapshot))
    this.sessionWrites = next
    return next
  }
  private async persistSession(snapshot: Session): Promise<void> {
    if (!snapshot.antigravity?.accountId) throw new Error('会话缺少账号归属')
    const owners = await this.get<Record<string,string>>('lite:session-owners', {})
    if (owners[snapshot.id] && owners[snapshot.id] !== snapshot.antigravity.accountId) throw new Error('不能修改会话的账号归属。')
    await this.set(`session:${snapshot.id}`, snapshot)
    owners[snapshot.id]=snapshot.antigravity.accountId
    await this.set('lite:session-owners',owners)
    const existing = await this.meta.getById(snapshot.id)
    await this.meta.createMany([{id:snapshot.id,name:snapshot.name,type:'chat',sortOrder:Date.now(),createdAt:existing?.createdAt??Date.now()}])
  }
  skills(): Promise<ConversationSkill[]> { return this.get('lite:skills',[]) }
  saveSkills(skills: ConversationSkill[]): Promise<void> { return this.set('lite:skills',skills) }
}
export const liteRepository = new LiteRepository()
