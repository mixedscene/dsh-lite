import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionMetaRecord } from '@shared/types/session'
const memory = vi.hoisted(() => ({values: new Map<string,string>(), meta: new Map<string,SessionMetaRecord>()}))
vi.mock('../platform/sqlite-storage', () => ({getSQLiteStorage: () => ({
  async getItem(key:string) { return memory.values.get(key)??null }
  async setItem(key:string,value:string) { memory.values.set(key,value) }
})}))
vi.mock('../storage/SQLiteSessionMetaStorage', () => ({SQLiteSessionMetaStorage: class {
  async getById(id:string) { return memory.meta.get(id)??null }
  async createMany(rows:SessionMetaRecord[]) { for(const row of rows) memory.meta.set(row.id,row) }
}}))
import { LiteRepository } from './repository'
const session = (id:string,accountId:string):Session => ({id,name:id,messages:[],antigravity:{accountId}})
describe('account-scoped Chatbox persistence', () => {
  beforeEach(() => { memory.values.clear();memory.meta.clear() })
  it('retains A and B concurrently and restores A after B', async () => {
    const db=new LiteRepository()
    await Promise.all([db.save(session('s-a','A')),db.save(session('s-b','B'))])
    expect((await db.list('A')).map(s=>s.id)).toEqual(['s-a'])
    expect((await db.list('B')).map(s=>s.id)).toEqual(['s-b'])
    expect((await new LiteRepository().load('s-a','A')).antigravity?.accountId).toBe('A')
    await expect(db.load('s-a','B')).rejects.toThrow('另一个账号')
  })
  it('does not allow an existing session to change ownership',async()=>{
    const db=new LiteRepository();await db.save(session('same','A'))
    await expect(db.save(session('same','B'))).rejects.toThrow('账号归属')
    expect((await db.load('same','A')).antigravity?.accountId).toBe('A')
  })
  it('snapshots pending writes instead of retaining mutable streaming objects',async()=>{
    const db=new LiteRepository(),value=session('s','A');const save=db.save(value)
    value.name='mutated';await save;expect((await db.load('s','A')).name).toBe('s')
  })
  it('preserves original signed parts on restart and invalidates unfinished replies',async()=>{
    const db=new LiteRepository(),value=session('s','A')
    value.messages=[{id:'m',role:'assistant',generating:true,contentParts:[{type:'text',text:'partial'}],antigravity:{version:1,accountId:'A',project:'p',modelId:'gemini',sessionId:'scope',parts:[{text:'',thoughtSignature:'signed'}],complete:false,status:'streaming'}}]
    await db.save(value);const reopened=await new LiteRepository().load('s','A')
    expect(reopened.messages[0].generating).toBe(false)
    expect(reopened.messages[0].antigravity?.complete).toBe(false)
    expect(reopened.messages[0].antigravity?.status).toBe('cancelled')
    expect(reopened.messages[0].antigravity?.parts).toEqual([{text:'',thoughtSignature:'signed'}])
  })
})
