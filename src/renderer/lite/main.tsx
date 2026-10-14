import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Checkbox, Drawer, MantineProvider, Select, Textarea } from '@mantine/core'
import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Keyboard, KeyboardResize } from '@capacitor/keyboard'
import { createStore, Provider as AtomProvider } from 'jotai'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type { Message, Session, SessionMetaRecord } from '@shared/types/session'
import type { ProviderModelInfo } from '@shared/types'
import { AntigravityClient } from '@shared/providers/antigravity/client'
import { antigravityNative, createNativeAntigravityTransport, type AntigravityAccount } from '@shared/providers/antigravity/native'
import { MessageInputField, type MessageInputFieldRef } from '../components/InputBox/MessageInputField'
import { currentSessionIdAtom } from '../stores/atoms/sessionAtoms'
import { liteRepository as db } from './repository'
import { buildSkillInstruction, parseConversationSkill, type ConversationSkill } from './skills'
import '@mantine/core/styles.css'
import './style.css'

const store=createStore()
const client=new AntigravityClient(createNativeAntigravityTransport())
const textOf=(message:Message)=>message.contentParts.filter(p=>p.type==='text').map(p=>p.text).join('')
const errorText=(error:unknown)=>error instanceof Error?error.message:'操作失败，请重试。'
function cachedModels(account?:AntigravityAccount):ProviderModelInfo[] {
  const value=account?.modelCache
  if(!value || typeof value!=='object' || !('models' in value) || !Array.isArray(value.models)) return []
  return value.models.filter((m):m is ProviderModelInfo=>!!m&&typeof m==='object'&&typeof m.modelId==='string')
}
function LiteApp(){
  const [accounts,setAccounts]=useState<AntigravityAccount[]>([])
  const [accountId,setAccountId]=useState('')
  const activeId=useRef('')
  const [oauthConfigured,setOAuthConfigured]=useState(false)
  const [oauthPending,setOAuthPending]=useState(false)
  const accountSync=useRef<Promise<void>>(Promise.resolve())
  const [sessions,setSessions]=useState<SessionMetaRecord[]>([])
  const [session,setSession]=useState<Session|null>(null)
  const sessionRef=useRef<Session|null>(null)
  const [models,setModels]=useState<ProviderModelInfo[]>([])
  const [modelId,setModelId]=useState('')
  const [skills,setSkills]=useState<ConversationSkill[]>([])
  const [drawer,setDrawer]=useState<'chats'|'accounts'|'skills'|null>(null)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [busy,setBusy]=useState(false)
  const [loading,setLoading]=useState(true)
  const [draft,setDraft]=useState('')
  const [editing,setEditing]=useState<{id:string;text:string}|null>(null)
  const [visible,setVisible]=useState(80)
  const [dark,setDark]=useState(localStorage.getItem('lite:theme')!=='light')
  const abortRef=useRef<AbortController|null>(null)
  const taskRef=useRef<Promise<void>|null>(null)
  const verified=useRef(new Set<string>())
  const input=useRef<MessageInputFieldRef>(null)
  const scroll=useRef<HTMLDivElement>(null)
  const nearBottom=useRef(true)
  const account=accounts.find(a=>a.id===accountId)
  const replaceSession=(next:Session|null)=>{sessionRef.current=next;store.set(currentSessionIdAtom,next?.id??null);setSession(next);setEditing(null);setVisible(80)}
  const displayUpdate=(next:Session)=>{if(activeId.current===next.antigravity?.accountId&&sessionRef.current?.id===next.id){sessionRef.current=structuredClone(next);setSession(sessionRef.current)}}
  const refreshList=async(id=activeId.current)=>{const rows=await db.list(id);if(id===activeId.current)setSessions(rows)}
  const newSession=async(id=activeId.current)=>{
    if(!id)return
    const current=accounts.find(a=>a.id===id)
    const next:Session={id:crypto.randomUUID(),name:'新对话',type:'chat',messages:[],settings:{provider:'antigravity',modelId:modelId||cachedModels(current)[0]?.modelId},antigravity:{accountId:id,project:current?.project,skillIds:[]}}
    await db.save(next)
    await db.set(`lite:last-session:${id}`,next.id)
    if(activeId.current===id){replaceSession(next);await refreshList(id)}
  }
  const restore=async(id:string,rows:SessionMetaRecord[])=>{
    const last=await db.get<string>(`lite:last-session:${id}`,'')
    const existing=rows.find(row=>row.id===last)??rows[0]
    if(existing){const next=await db.load(existing.id,id);if(activeId.current===id){replaceSession(next);setModelId(next.settings?.modelId??'')}}
    else await newSession(id)
  }
  const stop=async()=>{abortRef.current?.abort();await taskRef.current?.catch(()=>{})}
  const switchAccount=async(id:string)=>{
    if(id===activeId.current)return
    setLoading(true);setError('')
    try{
      await stop()
      await antigravityNative.switchAccount({accountId:id})
      verified.current.delete(id);activeId.current=id;setAccountId(id);replaceSession(null);setModels(cachedModels(accounts.find(a=>a.id===id)));setModelId('')
      const rows=await db.list(id);setSessions(rows);await restore(id,rows);setDrawer(null)
    }catch(e){setError(errorText(e))}finally{setLoading(false)}
  }
  const syncAccounts=()=>{
    const next=accountSync.current.catch(()=>{}).then(async()=>{
      const result=await antigravityNative.listAccounts()
      setAccounts(result.accounts);setOAuthConfigured(result.oauthConfigured);setOAuthPending(result.oauthPending??false)
      if(result.storageError||result.oauthError)setError(result.storageError??result.oauthError??'')
      const id=result.activeAccountId??result.accounts[0]?.id??''
      if(id!==activeId.current||(!sessionRef.current&&id)){
        await stop();activeId.current=id;setAccountId(id);replaceSession(null);setModelId('')
        setModels(cachedModels(result.accounts.find(a=>a.id===id)));verified.current.delete(id)
        const rows=id?await db.list(id):[];setSessions(rows)
        if(id){await antigravityNative.switchAccount({accountId:id});await restore(id,rows)}
      }
    })
    accountSync.current=next;return next
  }
  useEffect(()=>{
    let mounted=true
    void (async()=>{try{setSkills(await db.skills());await syncAccounts()}catch(e){if(mounted)setError(errorText(e))}finally{if(mounted)setLoading(false)}})()
    const resize=()=>document.documentElement.style.setProperty('--app-height',`${window.visualViewport?.height??window.innerHeight}px`)
    resize();window.visualViewport?.addEventListener('resize',resize)
    void Keyboard.setResizeMode({mode:KeyboardResize.Native}).catch(()=>{})
    const back=App.addListener('backButton',()=>{if(document.activeElement?.tagName==='TEXTAREA'){(document.activeElement as HTMLTextAreaElement).blur();void Keyboard.hide()}else setDrawer(null)})
    const resume=App.addListener('appStateChange',({isActive})=>{if(isActive)void syncAccounts().catch(e=>setError(errorText(e)))})
    const changed=antigravityNative.addListener('accountsChanged',()=>{void syncAccounts().catch(e=>setError(errorText(e)))})
    return()=>{mounted=false;abortRef.current?.abort();window.visualViewport?.removeEventListener('resize',resize);for(const listener of [back,resume,changed])void listener.then(l=>l.remove()).catch(()=>{})}
  },[])
  useEffect(()=>{localStorage.setItem('lite:theme',dark?'dark':'light')},[dark])
  useEffect(()=>{if(nearBottom.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight},[session?.messages])
  const action=async(work:()=>Promise<void>)=>{setError('');try{await work()}catch(e){setError(errorText(e))}}
  const addAccount=()=>action(async()=>{
    if(!oauthConfigured)throw new Error('此构建未配置 Google OAuth 客户端，请使用配置完成的 APK。')
    await stop();setBusy(true);setOAuthPending(true)
    try{await antigravityNative.addAccount({timeoutMs:170000});await syncAccounts();const id=activeId.current;verified.current.delete(id);const found=await discover(id);if(activeId.current===id&&sessionRef.current){const next=structuredClone(sessionRef.current);const chosen=found.models.some(m=>m.modelId===next.settings?.modelId)?next.settings?.modelId:found.models[0].modelId;next.settings={...next.settings,modelId:chosen};setModelId(chosen??'');replaceSession(next);await db.save(next)}setDrawer(null)}finally{setBusy(false);setOAuthPending(false)}
  })
  const discover=async(id:string,signal?:AbortSignal)=>{
    const result=await client.discoverModels(id,signal)
    await antigravityNative.updateAccountCache({accountId:id,project:result.project,modelCache:{models:result.models,verifiedAt:Date.now()}})
    verified.current.add(id)
    if(activeId.current===id){setModels(result.models);setAccounts(previous=>previous.map(a=>a.id===id?{...a,project:result.project,modelCache:{models:result.models},reauthRequired:false}:a))}
    return result
  }
  const refreshModels=()=>action(async()=>{
    if(busy||!accountId)return
    const controller=new AbortController();abortRef.current=controller;setBusy(true)
    const work=(async()=>{try{const data=await discover(accountId,controller.signal);const picked=data.models.some(m=>m.modelId===modelId)?modelId:data.models[0].modelId;setModelId(picked);if(sessionRef.current){const next={...sessionRef.current,settings:{...sessionRef.current.settings,modelId:picked}};replaceSession(next);await db.save(next)}}finally{setBusy(false);abortRef.current=null}})()
    taskRef.current=work;await work
  })
  const generate=async(userText?:string,regenerateUserId?:string)=>{
    if(busy||loading||!sessionRef.current||!activeId.current)return
    const current=structuredClone(sessionRef.current)
    const id=activeId.current
    if(current.antigravity?.accountId!==id){setError('会话与当前账号不匹配，请重新打开该账号的会话。');return}
    const controller=new AbortController();abortRef.current=controller;setBusy(true);setError('');setNotice('');nearBottom.current=true
    const work=(async()=>{
      let assistant:Message|undefined
      let lastSave=0
      let pendingSave:Promise<void>=Promise.resolve()
      try{
        const instruction=buildSkillInstruction(skills,current.antigravity?.skillIds??[])
        let project=accounts.find(a=>a.id===id)?.project
        let available=models
        if(!verified.current.has(id)||!project){const discovered=await discover(id,controller.signal);project=discovered.project;available=discovered.models}
        controller.signal.throwIfAborted()
        const chosen=modelId||current.settings?.modelId||available[0]?.modelId
        if(!chosen||!available.some(m=>m.modelId===chosen))throw new Error('该账号当前无权使用所选模型，请刷新模型列表并重新选择。')
        const agy=current.antigravity
        if(!agy)throw new Error('会话缺少账号信息')
        agy.project=project;current.settings={...current.settings,provider:'antigravity',modelId:chosen};if(id===activeId.current)setModelId(chosen)
        if(regenerateUserId){
          const at=current.messages.findIndex(m=>m.id===regenerateUserId&&m.role==='user')
          if(at<0)throw new Error('找不到重试的用户消息。')
          if(current.messages.length>at+1){current.threads=[...(current.threads??[]),{id:crypto.randomUUID(),name:`${current.name} · ${new Date().toLocaleString()}`,createdAt:Date.now(),messages:structuredClone(current.messages)}]}
          current.messages=current.messages.slice(0,at+1)
          if(userText!==undefined)current.messages[at].contentParts=[{type:'text',text:userText}]
        }else{
          if(!userText?.trim())return
          current.messages.push({id:crypto.randomUUID(),role:'user',contentParts:[{type:'text',text:userText.trim()}],timestamp:Date.now()})
          if(current.name==='新对话')current.name=userText.trim().slice(0,40)
          input.current?.clearDraft();setDraft('')
        }
        assistant={id:crypto.randomUUID(),role:'assistant',contentParts:[],modelId:chosen,model:available.find(m=>m.modelId===chosen)?.nickname??chosen,aiProvider:'antigravity',generating:true,timestamp:Date.now()}
        current.messages.push(assistant)
        await db.save(current);displayUpdate(current)
        const result=await client.chat({accountId:id,project,modelId:chosen,sessionId:current.id,messages:current.messages.slice(0,-1),systemInstruction:instruction,signal:controller.signal,maxOutputTokens:4096,
          onUpdate(update){if(!assistant)return;assistant.contentParts=update.contentParts;assistant.antigravity=update.antigravity;displayUpdate(current);if(Date.now()-lastSave>1000){lastSave=Date.now();pendingSave=pendingSave.then(()=>db.save(current)).catch(()=>{controller.abort(new Error('本地保存失败，生成已停止。'))})}},
        })
        assistant.contentParts=result.contentParts;assistant.antigravity=result.antigravity;assistant.usage=result.usage;assistant.finishReason=result.finishReason
      }catch(e){
        if(assistant){assistant.error=controller.signal.aborted?'生成已停止，部分回复不用于后续上下文。':errorText(e);if(assistant.antigravity){assistant.antigravity.complete=false;assistant.antigravity.status=controller.signal.aborted?'cancelled':'failed'}}
        else if(activeId.current===id)setError(controller.signal.aborted?'操作已取消。':errorText(e))
      }finally{
        if(assistant){assistant.generating=false;await pendingSave;try{await db.save(current)}catch{if(id===activeId.current)setError('回复保存失败，请保留当前页面并重试。')}displayUpdate(current)}
        if(id===activeId.current)await refreshList(id).catch(()=>{})
        if(abortRef.current===controller){abortRef.current=null;setBusy(false)}
      }
    })()
    taskRef.current=work;await work
  }
  const loadSession=(id:string)=>action(async()=>{const owner=activeId.current;setLoading(true);try{await stop();const next=await db.load(id,owner);if(activeId.current!==owner)return;replaceSession(next);setModelId(next.settings?.modelId??'');await db.set(`lite:last-session:${owner}`,id);if(activeId.current===owner)setDrawer(null);nearBottom.current=true}finally{setLoading(false)}})
  const selectModel=(chosen:string|null)=>action(async()=>{if(!chosen||!sessionRef.current)return;setModelId(chosen);const next={...sessionRef.current,settings:{...sessionRef.current.settings,modelId:chosen}};replaceSession(next);await db.save(next)})
  const importSkill=()=>action(async()=>{const file=await antigravityNative.importSkill();const skill=parseConversationSkill(file.content,file.name,crypto.randomUUID());const next=[...skills,skill];await db.saveSkills(next);setSkills(next);setNotice(`已导入 ${skill.name}${skill.unsupported.length?'；存在不支持的工具依赖，不能启用。':''}`)})
  const toggleSkill=(id:string,on:boolean)=>action(async()=>{if(!sessionRef.current?.antigravity)return;const next=structuredClone(sessionRef.current);if(next.antigravity){const ids=next.antigravity.skillIds??[];next.antigravity.skillIds=on?[...new Set([...ids,id])]:ids.filter(v=>v!==id)}await db.save(next);replaceSession(next)})
  const removeSkill=(id:string)=>action(async()=>{const next=skills.filter(s=>s.id!==id);await db.saveSkills(next);setSkills(next);await toggleSkill(id,false)})
  const removeAccount=(id:string)=>action(async()=>{await stop();await antigravityNative.removeAccount({accountId:id});verified.current.delete(id);const result=await antigravityNative.listAccounts();setAccounts(result.accounts);activeId.current=result.activeAccountId??result.accounts[0]?.id??'';setAccountId(activeId.current);replaceSession(null);setModels(cachedModels(result.accounts.find(a=>a.id===activeId.current)));setModelId('');const rows=activeId.current?await db.list(activeId.current):[];setSessions(rows);if(activeId.current)await restore(activeId.current,rows)})
  const restoreBranch=(id:string)=>action(async()=>{if(!sessionRef.current)return;const next=structuredClone(sessionRef.current);const branch=next.threads?.find(t=>t.id===id);if(!branch)return;const present={id:crypto.randomUUID(),name:`${next.name} · 当前分支`,createdAt:Date.now(),messages:next.messages};next.messages=branch.messages;next.threads=[...(next.threads??[]).filter(t=>t.id!==id),present];await db.save(next);replaceSession(next);setDrawer(null)})
  const copy=(text:string)=>action(async()=>{if(navigator.clipboard){await navigator.clipboard.writeText(text)}else{const node=document.createElement('textarea');node.value=text;document.body.append(node);node.select();const copied=document.execCommand('copy');node.remove();if(!copied)throw new Error('复制失败，请长按选择文本。')}setNotice('已复制。')})
  return <MantineProvider forceColorScheme={dark?'dark':'light'}><main className={`lite ${dark?'dark':''}`}>
    <header className="toolbar"><Button variant="subtle" onClick={()=>setDrawer('chats')}>☰</Button><div className="heading"><b>Chatbox Lite</b><small>{account?.email??'Google 账号'}</small></div><Button size="xs" variant="subtle" onClick={()=>setDrawer('accounts')}>账号</Button><Button size="xs" variant="subtle" onClick={()=>setDrawer('skills')}>Skill</Button><Button size="xs" variant="subtle" aria-label="切换主题" onClick={()=>setDark(!dark)}>{dark?'☀':'☾'}</Button></header>
    {loading&&<div className="banner">正在打开本地会话…</div>}
    {error&&<div role="alert" className="banner error">{error}<button onClick={()=>setError('')}>关闭</button></div>}
    {notice&&<div role="status" className="banner">{notice}<button onClick={()=>setNotice('')}>关闭</button></div>}
    {!accountId&&!loading?<section className="welcome"><h1>开始你的对话</h1><p>使用 Google 账号连接 Antigravity。聊天和对话 Skill 保存在此设备。</p><Button loading={oauthPending} disabled={busy&&!oauthPending} onClick={()=>void addAccount()}>添加 Google 账号</Button>{oauthPending&&<Button variant="subtle" onClick={()=>void antigravityNative.cancelOAuth()}>取消授权</Button>}<small>{oauthConfigured?'授权在系统浏览器完成。':'当前 APK 尚未配置 OAuth 客户端。'}</small></section>:<>
      <div className="modelbar"><Select aria-label="选择模型" placeholder="先刷新模型列表" value={modelId||null} data={models.map(m=>({value:m.modelId,label:m.nickname??m.modelId}))} onChange={v=>void selectModel(v)} disabled={busy||loading} searchable/><Button size="xs" variant="subtle" disabled={busy||loading} onClick={()=>void refreshModels()}>刷新模型</Button></div>
      <div className="messages" ref={scroll} onScroll={()=>{const el=scroll.current;if(el)nearBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<180}}>
        {session&&session.messages.length>visible&&<Button variant="subtle" fullWidth onClick={()=>setVisible(v=>v+80)}>加载较早的消息</Button>}
        {session?.messages.slice(-visible).map(message=><article key={message.id} className={`message ${message.role}`}>
          <div className="messagehead"><strong>{message.role==='user'?'你':message.model??'助手'}</strong><span>{message.generating?'生成中…':message.antigravity&&!message.antigravity.complete?'未完成':''}</span></div>
          {editing?.id===message.id?<><Textarea aria-label="编辑消息" value={editing.text} onChange={e=>setEditing({...editing,text:e.currentTarget.value})} minRows={3} autosize/><Button size="xs" disabled={!editing.text.trim()||busy} onClick={()=>{void generate(editing.text,editing.id);setEditing(null)}}>保存并重新生成</Button><Button size="xs" variant="subtle" onClick={()=>setEditing(null)}>取消</Button></>:<>
            {message.contentParts.filter(p=>p.type==='reasoning').map((p,i)=><details key={`r${i}`}><summary>思考过程</summary><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm,remarkBreaks]}>{p.text}</ReactMarkdown></div></details>)}
            <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm,remarkBreaks]} components={{a:({href,children})=><a href={href} onClick={e=>{e.preventDefault();if(href&&/^https?:\/\//i.test(href))void Browser.open({url:href})}}>{children}</a>,img:({alt})=><span>{alt??'图片'}</span>}}>{textOf(message)}</ReactMarkdown></div>
            {message.error&&<p className="messageerror">{message.error}</p>}
            {!message.generating&&<div className="messageactions"><Button size="compact-xs" variant="subtle" onClick={()=>void copy(textOf(message))}>复制</Button>{message.role==='user'?<Button size="compact-xs" variant="subtle" disabled={busy||loading} onClick={()=>setEditing({id:message.id,text:textOf(message)})}>编辑</Button>:<Button size="compact-xs" variant="subtle" disabled={busy||loading} onClick={()=>{const at=session?.messages.findIndex(m=>m.id===message.id)??-1;const user=session?.messages.slice(0,at).findLast(m=>m.role==='user');if(user)void generate(undefined,user.id)}}>重新生成</Button>}</div>}
          </>}
        </article>)}
        {session&&!session.messages.length&&<div className="empty">选择模型后开始聊天。Skill 可在右上角为当前会话启用。</div>}
      </div>
      <footer className="composer"><MessageInputField key={`${accountId}:${session?.id??'none'}`} ref={input} isNewSession={false} viewportHeight={window.visualViewport?.height??window.innerHeight} isReadOnly={loading||!session} placeholder="输入消息，发送开始对话" ariaLabel="消息输入框" autoFocus={false} onValueChange={setDraft} onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!e.nativeEvent.isComposing){e.preventDefault();void generate(input.current?.getValue())}}} onPaste={()=>{}}/><div className="composeractions"><small>{session?.antigravity?.skillIds?.length?`已启用 ${session.antigravity.skillIds.length} 个 Skill`:'仅文本对话'}</small>{busy?<Button color="red" onClick={()=>void (oauthPending?antigravityNative.cancelOAuth():stop())}>停止</Button>:<Button disabled={loading||!draft.trim()||!session} onClick={()=>void generate(input.current?.getValue())}>发送</Button>}</div></footer>
    </>}
    <Drawer opened={drawer!==null} onClose={()=>setDrawer(null)} title={drawer==='chats'?'会话':drawer==='accounts'?'Google 账号':'对话 Skills'} size="90%">
      {drawer==='chats'&&<div className="drawerlist"><Button disabled={!accountId||busy||loading} onClick={()=>void action(async()=>{await newSession();setDrawer(null);nearBottom.current=true})}>新建对话</Button>{sessions.map(row=><Button variant={session?.id===row.id?'light':'subtle'} key={row.id} onClick={()=>void loadSession(row.id)} disabled={loading}>{row.name}</Button>)}{!!session?.threads?.length&&<><h3>历史分支</h3>{session.threads.map(t=><Button key={t.id} variant="subtle" disabled={busy} onClick={()=>void restoreBranch(t.id)}>{t.name}</Button>)}</>}</div>}
      {drawer==='accounts'&&<div className="drawerlist">{accounts.map(a=><section key={a.id} className="accountrow"><b>{a.name||a.email}</b><small>{a.email}{a.reauthRequired?' · 需要重新授权':''}</small><div><Button size="xs" disabled={loading||oauthPending} variant={a.id===accountId?'light':'subtle'} onClick={()=>void switchAccount(a.id)}>{a.id===accountId?'当前账号':'切换'}</Button><Button size="xs" color="red" variant="subtle" disabled={busy||loading} onClick={()=>{if(window.confirm(`移除 ${a.email} 的登录凭据？本地对话会保留。`))void removeAccount(a.id)}}>移除</Button></div></section>)}<Button loading={oauthPending} disabled={loading||(busy&&!oauthPending)} onClick={()=>void addAccount()}>添加 / 重新授权 Google 账号</Button>{oauthPending&&<Button variant="subtle" onClick={()=>void antigravityNative.cancelOAuth()}>取消授权</Button>}<small>模型列表按账号获取；切换后沿用该账号自己的会话。授权失败不会自动更换账号。</small></div>}
      {drawer==='skills'&&<div className="drawerlist"><p>导入 Markdown 或 SKILL.md，为当前会话添加写作与思考规则。</p><Button disabled={busy||loading} onClick={()=>void importSkill()}>导入 Skill 文件</Button>{skills.map(s=><section key={s.id} className="skillrow"><Checkbox label={s.name} checked={session?.antigravity?.skillIds?.includes(s.id)??false} disabled={busy||!session||s.unsupported.length>0} onChange={e=>void toggleSkill(s.id,e.currentTarget.checked)}/><p>{s.description}</p>{s.unsupported.length>0&&<p className="messageerror">不支持的依赖：{s.unsupported.join('；')}</p>}<details><summary>查看提示词</summary><pre>{s.body}</pre></details><Button size="compact-xs" color="red" variant="subtle" disabled={busy} onClick={()=>void removeSkill(s.id)}>删除</Button></section>)}</div>}
    </Drawer>
  </main></MantineProvider>
}
createRoot(document.getElementById('root')!).render(<AtomProvider store={store}><LiteApp/></AtomProvider>)
