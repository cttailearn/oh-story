// 角色注册表（agents-runtime §2.1）：role id → 模板 / 模型路由键 / 工具开关
export type RoleId = 'architect' | 'designer' | 'writer' | 'checker' | 'researcher' | 'explorer';

export interface RoleSpec {
  id: RoleId;
  /** 模板文件名（webui/agents/templates/ 相对） */
  template: string;
  /** webui-config.model_routing 键 */
  modelRole: string;
  allowTools: boolean;
  description: string;
}

export const ROLE_SPECS: Record<RoleId, RoleSpec> = {
  architect: {
    id: 'architect',
    template: 'story-architect.md',
    modelRole: 'architect',
    allowTools: false,
    description: '题材/世界观/大纲/金手指',
  },
  designer: {
    id: 'designer',
    template: 'character-designer.md',
    modelRole: 'designer',
    allowTools: false,
    description: '人设/语言风格/动机链',
  },
  writer: {
    id: 'writer',
    template: 'narrative-writer.md',
    modelRole: 'writer',
    allowTools: false,
    description: '正文/去AI味',
  },
  checker: {
    id: 'checker',
    template: 'consistency-checker.md',
    modelRole: 'checker',
    allowTools: false,
    description: '一致性/伏笔（只读）',
  },
  researcher: {
    id: 'researcher',
    template: 'story-researcher.md',
    modelRole: 'researcher',
    allowTools: false,
    description: '资料研究',
  },
  explorer: {
    id: 'explorer',
    template: 'story-explorer.md',
    modelRole: 'explorer',
    allowTools: true,
    description: '项目结构化查询（只读工具）',
  },
};

export function roleFor(id: string): RoleSpec {
  const r = ROLE_SPECS[id as RoleId];
  if (!r) throw new Error(`ROLE_NOT_FOUND: ${id}`);
  return r;
}
