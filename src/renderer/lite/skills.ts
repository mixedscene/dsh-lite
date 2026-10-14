export const SKILL_MAX_BYTES=256*1024
export interface ConversationSkill { id:string; name:string; description:string; body:string; unsupported:string[] }

/** Data-only Markdown YAML front matter; no tags or JavaScript engines. */
export function parseConversationSkill(content:string,fileName:string,id:string):ConversationSkill {
  if(new TextEncoder().encode(content).length>SKILL_MAX_BYTES) throw new Error('Skill 超过 256 KiB 大小限制。')
  if(content.includes('\u0000')||content.includes('\ufffd')) throw new Error('Skill 需要使用有效 UTF-8 文本编码。')
  const normalized=content.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n')
  const match=normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if(normalized.startsWith('---\n')&&!match) throw new Error('Skill YAML 元数据缺少结束分隔符。')
  let name=fileName.replace(/\.md$/i,''); let description=''; const unsupported:string[]=[]
  if(match) {
    const lines=match[1].split('\n')
    for(let i=0;i<lines.length;i++) {
      const field=lines[i].match(/^([\w-]+):\s*(.*?)\s*$/)
      if(!field) continue
      const key=field[1].toLowerCase(); let value=field[2]
      if(value==='|'||value==='>') {
        const block:string[]=[]
        while(i+1<lines.length&&/^\s+/.test(lines[i+1])) block.push(lines[++i].trim())
        value=block.join(value==='>'?' ':'\n')
      } else if(value==='') {
        const block:string[]=[]
        while(i+1<lines.length&&/^\s+/.test(lines[i+1])) block.push(lines[++i].trim())
        value=block.join(' ')
      } else value=value.replace(/^(['"])([\s\S]*)\1$/,'$2')
      if(key==='name') name=value
      if(key==='description') description=value
      if(/^(allowed-tools|tools|mcp|scripts|dependencies|requires)$/.test(key)&&value&&value!=='[]') unsupported.push(`${key}: ${value}`)
      if(/!!|!<|&\w|\*\w/.test(value)) throw new Error('不支持带 YAML 标签、锚点或别名的 Skill 元数据。')
    }
  }
  const body=normalized.slice(match?.[0].length??0).trim()
  if(!name.trim()||!body) throw new Error('Skill 名称和正文不能为空。')
  const dependencies=body.match(/(?:requires?|依赖|需要)\s*[:：]?\s*(?:MCP|shell|bash|python|脚本|文件系统|执行命令)[^\n]*/gi)??[]
  unsupported.push(...dependencies)
  return {id,name:name.trim().slice(0,120),description:description.slice(0,500),body,unsupported:[...new Set(unsupported)]}
}
export function buildSkillInstruction(skills:ConversationSkill[],ids:string[]):string {
  const selected=skills.filter(skill=>ids.includes(skill.id))
  const unsupported=selected.find(skill=>skill.unsupported.length)
  if(unsupported) throw new Error(`Skill「${unsupported.name}」依赖不支持的工具，不能启用。`)
  return selected.map(skill=>`## 对话 Skill：${skill.name}\n${skill.body}`).join('\n\n')
}
