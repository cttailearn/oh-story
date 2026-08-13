# oh-story → pi 专属包迁移方案

> 决策：彻底删除多端适配（Claude Code / Codex / OpenCode / ZCode / Reasonix / OpenClaw），
> 产出 pi 纯净包；npm 发布 + git 安装双通道；story-setup 精简为 pi 项目初始化；
> 专业子代理转 pi-subagents 格式。
>
> 依据文档：pi docs/packages.md、docs/skills.md、docs/extensions.md、pi-subagents skill。

## Step 1：删除多端配置与脚本

删除：

- 目录：`.claude-plugin/`、`.zcode-plugin/`
- 文件：`marketplace.json`、`reasonix-plugin.json`
- workflows：`cli-compat.yml`、`cross-platform.yml`、`publish-clawhub.yml`、`sync-opencode.yml`
- `skills/story-setup/references/` 下：`codex/`、`opencode/`、`zcode/`、`openclaw/`、`reasonix/`
- `scripts/` 下全部适配器脚本：`check-claude-adapter.sh`、`check-codex-adapter.sh`、
  `check-openclaw-skills.sh`、`check-opencode-adapter.sh`、`check-reasonix-adapter.sh`、
  `check-shared-files.sh`、`check-story-setup-deployment.sh`、`check-zcode-adapter.sh`、
  `sync-opencode.py`、`generate-codex-agents.py`、`generate-codex-hooks.py`、
  `test-codex-cli-e2e.sh`、`test-codex-hook-merge.py`、`test-codex-hooks.sh`、
  `test-opencode-cli-e2e.sh`、`test-zcode-hooks.sh`、hooks 相关 check/test 脚本

保留（平台无关）：

- `skills/story-setup/references/agent-references/`（604K 共享写作知识，纯专业文档）
- `skills/story-setup/references/generic/`、`templates/`（逐个审查，剔除多端段）
- `scripts/static-check.py/.sh`、`skill-numbering.py`、`check-current-skill-contracts.py`、
  dashboard 相关测试脚本（逐个审查其内部对多端目录的引用）
- `.github/workflows/dashboard.yml`（改写 path 过滤，去掉 `.claude-plugin` 等引用）

## Step 2：技能正文 pi 化（13 个 SKILL.md + references）

1. frontmatter：删 `metadata: {"openclaw":...}`；description 触发方式改为
   `/skill:story-*` + 自然语言（保留中文触发词，pi 自动匹配）
2. agent 查找链：`.claude/agents/{agent}.md → .opencode/agents → .codex/agents/{agent}.toml`
   统一改为 `.pi/agents/{agent}.md`（pi-subagents 格式）
3. 触发词替换：`/story` → `/skill:story`、`$story-*` → 删除、`/story dashboard` →
   `/skill:story dashboard`（pi 支持 `/skill:name args`）
4. 更新指令：`npx skills add worldwonderer/oh-story-claudecode -y -g` →
   `pi update --extensions`；版本检查 `gh release view -R worldwonderer/oh-story-claudecode` →
   `-R cttailearn/oh-story-pi`；更新安装命令改 `pi update npm:oh-story-pi`（git 源则 `pi install git:...@新ref`）
5. 删除 ZCode 3.3.4 边界说明、OpenCode 阻塞说明等平台段落
6. 涉及 skill：story、story-review、story-import、story-deslop、story-long-analyze、
   story-long-write、story-short-write、story-short-analyze、story-image、browser-cdp（10 个含 spawn/平台逻辑）
7. `browser-cdp`：删除 opencode 卡顿段落；增补 pi 原生 `agent_browser` 工具说明
8. `agents_version` 机制：保留 `.story-deployed` sentinel 但简化（pi 无 hooks 部署，只剩 agents 同步）

## Step 3：story-setup 精简为 pi 项目初始化

- 职责改为：① 验证 oh-story-pi 包已装且 references 完整；② 创建书目录结构
  （长篇/短篇标准目录）；③ 写/合并 `.pi/settings.json` 与 `AGENTS.md`；
  ④ 把包内 `agents/` 的 pi-subagents 定义部署到项目 `.pi/agents/`（合并不覆盖）；
  ⑤ 写 `.story-deployed` sentinel（`target_cli: pi`）
- references 预计 1.4MB → ~650KB（agent-references + generic + 精简 templates）
- 删除全部 hooks/commands 部署逻辑（pi 无 hooks；commands 由扩展或 `/skill:` 承担）

## Step 4：子代理 pi-subagents 化

- 盘点 templates 中全部 agent（story-explorer、story-researcher、chapter-extractor、
  narrative-writer、story-architect、character-designer、consistency-checker 等）
- 转成 pi-subagents markdown 格式（frontmatter: name/description/model/thinking/tools/
  skills/skillPath），系统提示保留原 agent 正文
- 分发：包内 `agents/` 目录；全局安装说明复制到 `~/.pi/agent/agents/`，
  项目级由 story-setup 部署到 `.pi/agents/`
- skills 中 spawn 检查：`.pi/agents/{agent}.md` 存在 + pi-subagents 工具可用 →
  否则 solo 降级（保留现有降级文案风格）

## Step 5：pi 打包

- `package.json` 重写：

```json
{
  "name": "oh-story-pi",
  "version": "1.0.0",
  "description": "网络小说创作工具箱（pi 专属版）：扫榜、拆文、写作、审查、去AI味、封面",
  "keywords": ["pi-package", "novel", "writing", "网文"],
  "pi": {
    "skills": ["./skills"],
    "image": "https://github.com/cttailearn/oh-story-pi/raw/main/demo/story-dashboard.png"
  }
}
```

- 可选扩展 `extensions/index.ts`：注册 `/story`、`/story-dashboard` 命令别名（转发到
  `/skill:story`），保持原 UX；`resources_discover` 注册包内 `agents/`
- `VERSION` 文件（skills/story/VERSION）随版本更新
- 更新 `README.md`（pi 安装/更新/卸载、触发方式、story-setup 用法）
- 保持 `tests/` dashboard 测试可运行（`npm test`）

## Step 6：发布（git 为主，npm 暂缓）

1. git：GitHub Release 打 tag `v1.0.0` ✅ 已完成；验证 `pi install git:github.com/cttailearn/oh-story-pi@v1.0.0` ✅ 已完成
2. npm：**暂缓**——npm 账号 2FA 政策收紧（bypass 2FA token 受限），多次尝试发布被 E403/EOTP 拦截。包名 `oh-story-pi` 已确认未被占用并预留；待账号 2FA 就绪后补发（`npm publish --access public --otp=<码>` 或 bypass 权限 token）
3. 验证矩阵（已完成）：
   - `pi install git:github.com/cttailearn/oh-story-pi@v1.0.0` → 新开会话 → `/skill:story` 触发
   - `pi update --extensions` 升级路径
   - `pi -e .` 整包加载（skills + /story 扩展）
4. 清理用户本地旧安装：✅ 已移除 `~/.agents/skills/story*`（旧多端版），改由 pi 包管理

## 风险与注意

- npm 包名可用性需查证
- spawn 检查逻辑散布在 10 个 skill 中，统一改写避免遗漏（用 grep 全量核对
  `.claude\|codex\|opencode\|zcode\|reasonix\|openclaw` 归零）
- `npx skills add` 旧升级指令出现在多个 skill 与 README，全部替换后全仓 grep 验证
- 旧项目（已用多端版部署 `.claude/` 等）与新 pi 版的兼容：story-setup 检测到
  `.story-deployed` 中 `target_cli` 非 pi 时提示迁移
- 发布后 CHANGELOG 从 v0.7.5 续写；语义化版本建议 1.0.0（pi 专属是产品线变更）
