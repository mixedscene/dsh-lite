import {describe,expect,it} from 'vitest'
import {buildSkillInstruction,parseConversationSkill,SKILL_MAX_BYTES} from './skills'
describe('conversation-only skills',()=>{
 it('imports front matter and injects the body once',()=>{const s=parseConversationSkill('---\nname: 中文写作\ndescription: >\n  使用短句\n  保持准确\n---\n只使用中文。','SKILL.md','a');expect(s.name).toBe('中文写作');expect(s.description).toBe('使用短句 保持准确');expect(buildSkillInstruction([s],['a'])).toBe('## 对话 Skill：中文写作\n只使用中文。')})
 it('rejects execution dependencies',()=>{const s=parseConversationSkill('---\nname: run\nallowed-tools: Bash\n---\nRun the script','s.md','s');expect(s.unsupported).toEqual(['allowed-tools: Bash']);expect(()=>buildSkillInstruction([s],['s'])).toThrow('不能启用')})
 it('blocks YAML tool lists',()=>{const s=parseConversationSkill('---\nname: run\nallowed-tools:\n  - Bash\n  - Read\n---\nbody','s.md','s');expect(s.unsupported).toHaveLength(1);expect(()=>buildSkillInstruction([s],['s'])).toThrow('不能启用')})
 it('rejects unterminated metadata',()=>{expect(()=>parseConversationSkill('---\nname: example\nbody','s.md','s')).toThrow('结束分隔符')})
 it('enforces byte limits and text encoding',()=>{expect(()=>parseConversationSkill('中'.repeat(SKILL_MAX_BYTES/2),'a.md','a')).toThrow('256 KiB');expect(()=>parseConversationSkill('bad\uFFFD','a.md','a')).toThrow('UTF-8')})
 it('does not enable a removed or disabled skill',()=>{const s=parseConversationSkill('hello','a.md','a');expect(buildSkillInstruction([s],[])).toBe('');expect(buildSkillInstruction([],['a'])).toBe('')})
 it('rejects active YAML tags',()=>{expect(()=>parseConversationSkill('---\nname: !!js/function bad\n---\nbody','a.md','a')).toThrow('YAML')})
})
