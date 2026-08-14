# oh-story-pi

Web-novel writing toolkit (pi-exclusive edition) covering the full pipeline for
long-form and short-form Chinese web fiction: market scanning, deconstruction,
writing, review, de-AI polish, and cover/character-sheet image generation.
13 skills + 7 pi-subagents professional agents + a local writing dashboard,
distributed as a pi package.

## Core idea

> **Formula = deterministic emotional payoff**

A three-step professional-author workflow:

1. **Scan rankings** — analyze hot charts to spot trending genres, character
   archetypes, and entry points.
2. **Deconstruct** — reverse-engineer outlines, pacing, and plot material to
   build your personal module library.
3. **Write commercially** — apply hooks, gratification, and anticipation
   techniques.

Four guiding threads: reverse-engineering bestsellers · modular plot recomposition ·
layered context-state management · human-AI collaboration.

## Install

### Git channel (the current only release channel)

```bash
pi install git:github.com/cttailearn/oh-story-pi@v1.7.0
```

Update / uninstall:

```bash
pi update --extensions                                # update all packages (incl. oh-story-pi)
pi install git:github.com/cttailearn/oh-story-pi@new-ref   # upgrade to a new ref
pi remove git:github.com/cttailearn/oh-story-pi        # uninstall
```

### Deploy professional subagents (multi-agent collaboration)

The 7 professional agents (story-architect, narrative-writer, consistency-checker,
etc.) are written into your writing project's `.pi/agents/` by `/skill:story-setup`;
pi registers project subagents on new sessions. To verify activation, run
`/skill:story-review` in a new session — the report header shows
`Effective Mode: full/lean` when registration succeeded, or
`Fallback: ... -> solo` when the runtime does not expose the agents (check
pi-subagents: `pi install npm:pi-subagents`).

**Import-then-continue order:** run `/skill:story-setup` first in the project root
(deploys agents, merges AGENTS.md, creates the book directory), then (refresh or)
start a new session and run `/skill:story-import` to import an existing novel, then
`/skill:story-long-write 日更` or `/skill:story-long-write 写第N章` to continue
writing. `/skill:story-import` can also run standalone — it detects whether setup
was done and lets you choose between setting up first or continuing serially.

## Workflow overview

```mermaid
flowchart LR
    classDef entry fill:#f0f0f0,color:#333,stroke:#999,stroke-width:1px
    classDef phase fill:#e8f4fd,color:#1a1a2e,stroke:#4a9be8,stroke-width:1px
    classDef final fill:#fce4ec,color:#333,stroke:#e57373,stroke-width:1px

    entry_l{{"Long-form author"}}:::entry
    entry_s{{"Short-form author"}}:::entry
    entry_r{{"Has a direction"}}:::entry
    entry_i{{"Has an existing novel"}}:::entry

    subgraph S0 ["  Project init"]
        setup["/skill:story-setup"]:::phase
    end

    subgraph S1 ["  Market scan"]
        direction TB
        scan_l["Long-form scan"]:::phase
        scan_s["Short-form scan"]:::phase
    end

    subgraph S2 ["  Deconstruction"]
        direction TB
        analyze_l["Long-form analyze"]:::phase
        analyze_s["Short-form analyze"]:::phase
        import_l["Import existing novel"]:::phase
    end

    subgraph S3 ["  Writing"]
        direction TB
        write_l["Long-form write"]:::phase
        write_s["Short-form write"]:::phase
    end

    subgraph S4 ["  Final polish"]
        deslop["De-AI polish"]:::final
    end

    entry_l --> setup
    entry_s --> setup
    setup --> scan_l
    setup --> scan_s
    scan_l --> analyze_l
    scan_s --> analyze_s
    analyze_l --> write_l
    analyze_s --> write_s
    entry_r -.->|skip prep| write_l
    entry_r -.->|skip prep| write_s
    entry_i -.->|setup recommended| setup
    setup -.->|reverse import| import_l
    import_l -.->|continue| write_l
    write_l --> deslop
    write_s --> deslop
```

## Skills

| Skill | Trigger | Description |
| :------ | :----- | :----- |
| `story-setup` | `/skill:story-setup` `/准备写书` | Project init · subagent deployment, AGENTS.md merge, book directory creation |
| `story` | `/story` `/skill:story` `/story dashboard` | Toolbox router · fuzzy-intent dispatch + local deconstruction/writing Dashboard |
| `story-long-write` | `/skill:story-long-write` `/写长篇` | Long-form writing · outline, character design, chapter output |
| `story-long-analyze` | `/skill:story-long-analyze` | Long-form deconstruction · golden three chapters, gratification design, pacing analysis |
| `story-long-scan` | `/skill:story-long-scan` | Long-form market scan · Qidian/Fanqie/Jinjiang trends |
| `story-short-write` | `/skill:story-short-write` | Short-form writing · emotion design, twist drafting, polish |
| `story-short-analyze` | `/skill:story-short-analyze` | Short-form deconstruction · story core, structure, emotion line, twists, technique, resonance |
| `story-short-scan` | `/skill:story-short-scan` | Short-form market scan · Zhihu Yanxuan/Fanqie trending data |
| `story-deslop` | `/skill:story-deslop` `/去AI味` | De-AI polish · detect and remove AI writing traces |
| `story-import` | `/skill:story-import` `/导入小说` | Reverse import · parse an existing novel into the standard project layout |
| `story-review` | `/skill:story-review` `/审查` | Multi-perspective review · 4-agent review + Fanqie/Qidian/Zhihu scoring rubrics |
| `story-image` | `/skill:story-image` `/封面` `/角色卡图` `/人物图` `/三视图` `/场景图` | Image generation · covers/character sheets (unified portraits + three-view reference tables)/scenes, multiple backends (GPT-Image-2/GrsAI/Volcengine/DashScope/ComfyUI), asks for API keys when unconfigured |
| `browser-cdp` | `/skill:browser-cdp` | Browser automation · CDP protocol reusing logged-in sessions (pi's built-in agent_browser takes priority) |

> `story-deslop`'s local check is a writing lint: `blocking` findings are limited to
> deterministic phrasing/punctuation issues; everything else is judged by reading
> feel. External detectors (e.g. Zhuque) are self-test references only.

Natural-language triggers work too (skill descriptions auto-match):

- 「帮我开书」(help me start a book) → `story-long-write`
- 「这篇太 AI 了」(this reads too AI) → `story-deslop`
- 「把我的书导进来」(import my book) → `story-import`
- 「打开工作台」(open the dashboard) → `story dashboard`
- Asking about a character's state → spawns the `story-explorer` subagent

### Example output

Character-sheet images are generated by `story-image` from the character card —
unified portrait, three-view, and reference table layout (info panel / expression
grid / outfit breakdown / palette), bilingual prompts:

![Shen Zhi char-sheet demo (generated via GrsAI gpt-image-2)](demo/characters/沈栀/char-sheet_v1.webp)

> Real API generation (1024x1536), full pipeline: character card →
> character-card.py extraction → prompt-template.py assembly → imagegen.sh.

### Story Dashboard

Run `/story dashboard` to open the local writing dashboard: browse the
deconstruction library and long/short-form project file trees with search,
Markdown preview, text editing, conflict-protected saving, and confirm-before-delete.
The server listens on `127.0.0.1` only — novel content never leaves your machine.

## Agent system (pi-subagents)

7 professional subagents deployed to the project's `.pi/agents/` by `story-setup`
(pi-subagents format):

| Agent | Responsibility | Called by |
| :------ | :----- | :------- |
| `story-architect` | Genre positioning, worldbuilding, outline layout, twist engineering | Long/short-form writing Phase 1-3 |
| `character-designer` | Character profiles, speech-style files, motivation chains, dialogue | Long/short-form writing |
| `narrative-writer` | Prose writing, emotion-arc execution, de-AI 7-gate | Long-form Phase 4-5 / short-form Phase 3-4 |
| `consistency-checker` | Fact consistency, dropped foreshadowing, character-attribute conflicts (read-only) | Writing Phase 5 / review |
| `chapter-extractor` | Chapter summaries and plot-point extraction (read-only, parallel) | Long-form deconstruction Stage 2 |
| `story-explorer` | Structured project queries: characters/foreshadowing/progress (read-only) | Daily-update context loading / review / routing |
| `story-researcher` | Background research with source-cited reference files | Writing research / review fact-checking |

- **Model split** (deployed with templates, opencode-go provider): read-only
  high-frequency agents (story-explorer / chapter-extractor / consistency-checker)
  are pinned to `opencode-go/deepseek-v4-flash`; creative agents (story-architect /
  character-designer / narrative-writer / story-researcher) are pinned to
  `opencode-go/deepseek-v4-pro`. To change models, set `subagents.agentOverrides`
  in `~/.pi/agent/settings.json` by name.
- When subagents are unavailable (not deployed / pi-subagents missing / not exposed
  by the runtime), the affected skills degrade to solo/direct mode automatically
  and report `Fallback: ... -> solo` — writing flows never break.

## Writing guards

pi has no hooks mechanism; the old multi-CLI runtime hard-intercepts are covered
by two equivalent layers:

- **In-skill checkpoints**: daily-update/rewrite workflows force
  `tracking_commit.py check` (missing/inconsistent tracking state stops the flow,
  fail-closed), outline-boundary checks, and deterministic de-AI script checks.
- **Deterministic scripts**: `check-ai-patterns.js` (blocking phrasing/punctuation),
  `check-degeneration.js` (degeneration detection), `normalize-punctuation.js`
  (punctuation normalization) — run in the post-write self-check phase.

## Project layout

```text
project root/
├── AGENTS.md                 ← merged by story-setup (routing table + conventions)
├── .pi/
│   ├── agents/               ← 7 professional subagents (pi-subagents format)
│   └── settings.json         ← optional: project-level package install
├── .active-book              ← currently active book
├── .story-deployed           ← deployment sentinel (agents_version / target_cli: pi)
├── 拆文库/{书名}/            ← deconstruction results (data source)
├── 对标/{书名}/              ← benchmarking reference views
└── {书名}/                   ← long-form project (with 追踪/ or 设定/ subdirs)
    ├── 正文/                 ← chapters
    ├── 大纲/                 ← volume/beat outlines
    ├── 设定/                 ← characters, worldbuilding, genre positioning
    └── 追踪/                 ← _tracking-state.json (single structured authority) + derived views
```

Short-form projects are single-file: `{title}/正文.md` + `小节大纲.md` + `设定.md`.

## Knowledge base

`story-setup/references/agent-references/` is a 600KB+ shared writing knowledge
base (genre cards, gratification hooks, character methods, dialogue control,
emotion curves, de-AI corpora) loaded on demand by writing/review skills and
subagents. Skill bodies and the knowledge base ship with the pi package
(`pi update --extensions`); projects do not keep local copies.

## Platforms

- **pi**: natively supported (this package). After
  `pi install git:github.com/cttailearn/oh-story-pi@v1.7.0` the 13 skills are
  available and the `/story` alias is registered by the bundled extension. npm
  publish is on hold due to the account 2FA policy (package name `oh-story-pi`
  reserved).
- The legacy multi-CLI edition (Claude Code / OpenCode / Codex / ZCode /
  OpenClaw / Reasonix) lives in
  [oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)
  (≤ v0.7.5). This repository is pi-exclusive from v1.0.0.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). After changing skill bodies, run
`python scripts/static-check.py` and
`python scripts/check-current-skill-contracts.py` — both must pass with zero
failures.

## Feedback

- Issues & suggestions: GitHub Issues
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## Credits

Upstream project [oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode) (worldwonderer).
