import {beforeEach,describe,expect,it,vi} from 'vitest'
const native=vi.hoisted(()=>({
 close:vi.fn<()=>Promise<void>>(),create:vi.fn(),
 database:{open:vi.fn(async()=>{}),execute:vi.fn(async()=>{}),query:vi.fn(async()=>({values:[{name:'archived_at'},{name:'recovery_archived'}]}))}
}))
vi.mock('@capacitor-community/sqlite',()=>({CapacitorSQLite:{},SQLiteConnection:class{
 closeConnection(){return native.close()}
 createConnection(){native.create();return Promise.resolve(native.database)}
}}))
import {SQLiteStorage} from '../platform/sqlite-storage'
import {SQLiteSessionMetaStorage} from '../storage/SQLiteSessionMetaStorage'
describe('SQLite connection lifecycle',()=>{
 beforeEach(()=>{vi.clearAllMocks();native.close.mockResolvedValue()})
 it('waits for old key-value connection closure before recreating it',async()=>{
  let release!:()=>void;native.close.mockReturnValue(new Promise<void>(resolve=>{release=resolve}))
  const storage=new SQLiteStorage(),read=storage.getItem('missing')
  expect(native.create).not.toHaveBeenCalled();release();await expect(read).resolves.toBeNull()
  expect(native.create).toHaveBeenCalledOnce()
 })
 it('waits for metadata connection closure before reopening',async()=>{
  let release!:()=>void;native.close.mockReturnValue(new Promise<void>(resolve=>{release=resolve}))
  const initialization=new SQLiteSessionMetaStorage().initialize()
  expect(native.create).not.toHaveBeenCalled();release();await initialization
  expect(native.create).toHaveBeenCalledOnce()
 })
 it('handles a missing previous connection on a cold launch',async()=>{
  native.close.mockRejectedValue(new Error('connection does not exist'))
  await expect(new SQLiteStorage().getItem('missing')).resolves.toBeNull()
  await expect(new SQLiteSessionMetaStorage().initialize()).resolves.toBeUndefined()
  expect(native.create).toHaveBeenCalledTimes(2)
 })
})
