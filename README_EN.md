# oh-story-pi

Web-novel writing toolkit (pi-exclusive edition): ranking research, deconstruction, writing, review, de-AI polish, and cover generation for long-form and short-form Chinese web fiction. 13 skills + 7 pi-subagents + a local writing dashboard, distributed as a pi package.

## Install

```bash
pi install git:github.com/cttailearn/oh-story-pi@v1.1.1
```

Update / uninstall:

```bash
pi update --extensions                                # update all packages (incl. oh-story-pi)
pi install git:github.com/cttailearn/oh-story-pi@new-ref   # upgrade to a new ref
pi remove git:github.com/cttailearn/oh-story-pi        # uninstall
```

Run `/skill:story-setup` in your writing project to deploy the 7 professional subagents
to `.pi/agents/`, merge `AGENTS.md`, create the standard book directory, and write the
`.story-deployed` sentinel. Start a new pi session afterwards so subagents register.

`pi install npm:pi-subagents` is required for multi-agent cooperation; without it the
skills degrade to solo/direct mode (reported as `Fallback: ... -> solo`).

## Quick reference

| Intent | Command | Skill |
| :------- | :-------- | :------ |
| Route / dashboard | `/story`, `/story dashboard` | story |
| Write long-form | `/skill:story-long-write` | story-long-write |
| Write short-form | `/skill:story-short-write` | story-short-write |
| Deconstruct a novel | `/skill:story-long-analyze` | story-long-analyze |
| Deconstruct a short story | `/skill:story-short-analyze` | story-short-analyze |
| Ranking / market scan | `/skill:story-long-scan` | story-long-scan |
| Short-form market scan | `/skill:story-short-scan` | story-short-scan |
| De-AI polish | `/skill:story-deslop` | story-deslop |
| Import existing novel | `/skill:story-import` | story-import |
| Review manuscript | `/skill:story-review` | story-review |
| Generate cover | `/skill:story-cover` | story-cover |
| Browser automation | `/skill:browser-cdp` | browser-cdp |

Natural-language triggers work too (skill descriptions auto-match), e.g.
"I want to write a novel", "this reads too AI", "import my book".

## Notes

- The package is distributed via the git channel only (npm publish is on hold due to the account 2FA policy; the `oh-story-pi` package name is reserved).

- pi has no hooks mechanism; the old multi-CLI runtime guards are covered by in-skill
  checkpoints (`tracking_commit.py check`, fail-closed tracking) and deterministic
  scripts (`check-ai-patterns.js`, `check-degeneration.js`, `normalize-punctuation.js`).
- The legacy multi-CLI edition lives in
  [oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode) (≤ v0.7.5).
  This repository is pi-exclusive from v1.0.0.
- See [CHANGELOG.md](CHANGELOG.md) for the full history.
