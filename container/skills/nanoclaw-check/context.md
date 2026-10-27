# Nanoclaw contribution context

Reference document for the `/nanoclaw-check` skill. Describes what we're monitoring on the upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) repo, who's involved, current state of each thread, voice patterns for drafting responses, and scope discipline on where NOT to engage.

---

## What we're monitoring and why

Chip Tonkin (@chiptoe-svg) contributed the Codex backend to nanoclaw (PR #1843, merged 2026-04-20). This opened nanoclaw up to model-agnostic agent backends — previously Claude-SDK-only. Since the merge, an active ecosystem of follow-up issues and PRs has formed around the provider architecture, with overlap on custom endpoints, file-ops tools, import resolution, and latency.

The monitoring agent's job: **detect new activity on threads Chip has touched, classify whether it needs a response, and draft one if so — for Chip's review before posting.** Never post autonomously.

### Project context for the agent

- **qwibitai/nanoclaw** is the upstream OSS project. Branches: `main` (v1 legacy), `v2` (rewrite, active), `providers` (integration branch ≈ v2 + provider scaffolding, where PRs land first)
- **chiptoe-svg/nanoclaw_flexagents** is Chip's middle-tier fork (v1-based) with multi-runtime support (Claude/Codex/Gemini). Not a non-goal to sync with v2 — deliberately divergent.
- **chiptoe-svg/CUagent** is Chip's downstream fork for Clemson department-chair work (MS365, email triage, Apple Reminders, NanoVoice).

Contributions flow upstream as standalone PRs (not fork-wide rebases). PR #1843 is the model.

---

## Active threads

Each thread has: **state**, **what it's about**, **Chip's position/role**, **what a response should/shouldn't do**.

### PR #1843 — Codex provider via app-server JSON-RPC

- **State:** Merged 2026-04-20 as commit `af542ad`. Six commits total on branch `feat/codex-provider`.
- **About:** Added Codex as a full agent provider via `codex app-server` over JSON-RPC. Session resume, streaming, MCP, native compaction, approvals. Model-agnostic via `OPENAI_BASE_URL`.
- **Chip's role:** Primary author. Wrote the narrative PR body (Mode A vs Mode B framing, why app-server over SDK, OpenCode overlap).
- **Response policy:** Generally no active response needed on this PR anymore — it's merged. If someone opens a NEW issue/PR citing #1843 directly, that's worth flagging.

### Issue #1955 — Latency wins + branch target question

- **State:** OPEN. Filed 2026-04-21. Awaiting maintainer response.
- **About:** Follow-up to #1843 proposing three latency improvements ported from FlexAgents: TS precompile at container build, direct MCP binary paths (vs npx shims), baseInstructions hygiene. Asks maintainer whether `providers` or `v2` is the preferred target branch.
- **Chip's role:** Author. Will PR when maintainer responds.
- **Response policy:** Act on maintainer guidance when it arrives. If silence continues past ~10 days, consider a polite Discord check-in (NOT a nudge comment on the issue).

### Issue #1956 — File-ops MCP tools proposal

- **State:** OPEN. Filed 2026-04-21. One scoping-revision comment by Chip on 2026-04-23. Awaiting maintainer response.
- **About:** Proposes native `Read`/`Write`/`Edit`/`Glob`/`Grep` as MCP tools on the `nanoclaw` MCP server so all providers get a consistent file-ops surface. Original proposal was 5 tools; revised scoping comment suggests v1 = Read/Write/Edit (high-value) and defer Glob/Grep (marginal wins over bash).
- **Chip's role:** Author.
- **Response policy:** Monitor for maintainer's scope preference. **Do not file the web-fetch/web-search follow-up yet** — wait for file-ops conventions to settle.

### PR #1966 — @-import resolver for CLAUDE.md

- **State:** OPEN. Filed by **@IamAdamJowett** on 2026-04-24.
- **About:** Adds recursive `@-import` resolution to the Codex provider so group CLAUDE.md files with `@./.claude-global.md` and similar directives inline correctly. Supersedes Chip's narrow fix in #1843 (commit `aba6182`) that special-cased global only. Also adds `CLAUDE.local.md` support.
- **Chip's role:** Not author. Posted one supportive-context comment explaining #1843's scope-minimum choice and history.
- **Response policy:** Generally no further response needed unless author asks questions or maintainer engages Chip directly. Stay supportive, not territorial.

### Issue #1984 — Custom OpenAI-compat endpoints (Codex + OpenCode)

- **State:** OPEN. Filed by **@TeeJS** on 2026-04-24.
- **About:** Discussion umbrella for making custom OpenAI-compat endpoints (LiteLLM, llama.cpp, vLLM) actually work for both Codex and OpenCode providers. TeeJS has working code in their fork.
- **Chip's role:** Not author. Posted one substantive comment: history of why `138c277` removed the `-c model_provider_base_url` override (it was a no-op; flat key Codex never read), confirmation that the env-var path regressed between Codex 0.118 and 0.124, support for TeeJS's fix direction, scope lean (2 PRs not 4).
- **Response policy:** Monitor for maintainer weighing in on design questions. If maintainer directly asks Chip about the #1843 history, engage. Otherwise TeeJS drives.

### PR #1994 — Codex custom-endpoint fix (closes #1984 Codex half)

- **State:** OPEN. Filed by **@TeeJS** on 2026-04-24. Targets `providers`.
- **About:** The Codex half of #1984. Skips `auth.json` copy when group has `container.json` env `OPENAI_BASE_URL`; emits 5 `-c` overrides defining custom `openai-custom` provider with `wire_api="responses"`.
- **Chip's role:** Reviewer. Posted three observations: (1) misleading comment about "Chat Completions REST" when it's actually WebSocket `/v1/responses`, (2) env-override ordering question (comment says "overrides provider defaults" but ordering unclear), (3) missing unit tests for `createCodexConfigOverrides`.
- **Response policy:** Watch for TeeJS's replies to any of the 3 observations. If they ask for clarification, respond. If maintainer merges without addressing, don't push back publicly.

### PR #1995 — OpenCode custom-endpoint fix + /add-local-llama skill (closes #1984 OpenCode half)

- **State:** OPEN. Filed by **@TeeJS** on 2026-04-24. Targets `providers`.
- **About:** OpenCode half of #1984. Three env-gated hooks (`OPENCODE_PROVIDER_NPM`, `_NO_AUTH`, `_API_KEY`) + 218-line `/add-local-llama` skill with direct llama.cpp and LiteLLM modes.
- **Chip's role:** **Staying silent.** We said on #1994 "no useful signal to add on OpenCode side — don't know that codebase deeply enough." Consistency matters.
- **Response policy:** **Do not comment on this PR.** Even for seemingly-minor observations (skill-convention concerns, naming like `/add-local-llama` vs `/add-local-llm`, DB-mutation approach). Monitor for maintainer's response, but stay out of substance.

---

## Who's who

### @gavrielc — Maintainer

- Leads nanoclaw project. Merged #1843 same day it was force-pushed clean.
- Discord-active; publicly credited Chip and Tal Moskovitz in a Discord announcement on 2026-04-20 ("Special thanks to Tal Moskovitz and @chiptoe for the contributions").
- Tone: decisive, time-constrained, appreciative of clean work.
- What works with him: tight PR bodies, empirical validation, clear scope.

### @TeeJS — Active contributor

- Filed #1984, #1994, #1995 in ~24 hours. Strong contributor behavior.
- Has own fork with working code for custom-endpoint patterns. Documents thoroughly.
- Tone to match: collegial, respects their lane, acknowledge their working code before critique.

### @IamAdamJowett — Active contributor

- Filed #1966 (@-import resolver) on 2026-04-24.
- Picked up an area Chip had explicitly left unfinished in #1843. No ego — treated it as natural continuation.
- Tone to match: support their fix, note #1843 history without being defensive.

### Chip Tonkin (@chiptoe-svg) — that's us

- Graphic Communications department chair at Clemson.
- Runs CUagent (MS365, Apple Reminders, email triage, NanoVoice).
- Built FlexAgents (v1-based multi-runtime fork) initially for Clemson deployment scenarios.
- Voice patterns covered below.

---

## Scope discipline — what NOT to do

These are rules learned during engagement. Violations erode standing.

### Do NOT

- **Post a reply to any GitHub thread without Chip's approval.** The agent drafts; Chip posts.
- **Comment on OpenCode provider internals.** We said we don't know the codebase. Staying silent on #1995 is consistent; breaking that is inconsistent.
- **Raise architectural preference publicly** (e.g., "Codex handles local LLMs better than OpenCode"). That's a design taste question, not review feedback. Private notes only.
- **Critique naming on others' PRs** unless maintainer asks, or unless directly blocking merge.
- **File new issues while #1955 and #1956 are still awaiting response.** Crowding the queue signals aggression. Wait for those to move before filing web-fetch/web-search follow-ups.
- **Push back on `/add-local-llama` naming or DB-mutation skill approach** publicly. File privately if important; otherwise move on.
- **Re-litigate scope choices** from #1843. We made deliberate calls (scope-minimum @-import resolution, no `-c` override after 0.118 verification). When someone improves on them, the response is gratitude + context, not defense.
- **Comment on threads where Chip already commented and the conversation is quiet.** Don't double-tap.

### DO

- **Default to silence.** Many threads need nothing from us. Flag as FYI.
- **When Chip is directly asked (tagged, mentioned, or quoted), draft a response.**
- **When a thread affects Chip's merged code** in a way the author might want context on, draft a short history comment.
- **When maintainer asks a design question** on one of Chip's own issues/PRs, draft a substantive response.
- **Flag high-signal events** (merges, declines, maintainer responses to #1955/#1956) even if no action is needed — Chip wants to know.

---

## Voice guide

Chip's voice in GitHub comments is **collegial, substantive, honest about scope, and acknowledges others' work first before critique.** Drafts should match this pattern.

### Patterns to emulate

1. **Acknowledge the work first.** Never open with a critique. *"Clean PR"*, *"Thanks for this"*, *"Good catch"*, *"Fair catch"* style openers.
2. **Organize observations with bold labels.** When multiple points, use `**Re: #1** ... **Re: #2** ... **Scoping.** ...` structure.
3. **Own prior mistakes explicitly.** *"Fair catch — `src/providers/codex.ts` was shipped with unconditional copy because the subscription path was the primary use case..."*
4. **Offer context, not excuses.** When explaining why something was done a particular way, name the tradeoff/constraint without defensiveness.
5. **End with scope clarity.** *"Scoping — my lean is 2 PRs, not 4."* or *"No useful signal to add on the OpenCode side — don't know that codebase deeply enough."*
6. **Flag things that aren't this PR's job.** *"Not TeeJS to solve here, but user-facing friction — worth a follow-up rename."*
7. **Avoid "really", "actually", "just"** — they read as hedges. Prefer concrete claims.

### Example — historical context on someone else's fix PR (#1966)

> Thanks for this — the broader `@-import` resolution is exactly right. Some background since #1843 left parts of this deliberately unfinished:
>
> **What #1843 did.** The downstream fork (v1-based) had a working Codex persona assembly — concatenated `AGENT.md`/`CLAUDE.md` across `[global, group]` directories with `---`, appended a tool-guidance block, written as `AGENTS.md`, passed as `baseInstructions`. That shape is orthogonal to v2's `@-import` composition model, so the scope-minimum approach of #1843 mirrored OpenCode's `readClaudeMdForPrompt` — unconditionally read `/workspace/global/CLAUDE.md` and append to the group CLAUDE.md with `---`. That matched the existing non-Claude-provider pattern and got global content to Codex for default scaffolds, but left other `@-imports` (`.claude-shared.md`, `.claude-fragments/*`) as literal text. #1966 is the right v2-native resolution for both: matches how Claude Code natively composes persona files, intentionally doesn't double-include global when the group doesn't import it, and the resolver extracted here is the obvious primitive to share with OpenCode as a clean follow-up.
>
> **CLAUDE.local.md.** We missed that entirely — good catch.
>
> **Separate non-blocking observation.** [content-layer tone concern with concrete example prose]

### Example — review comment on someone else's active PR (#1994)

> Clean PR — scope matches what #1984 discussed, and re-using `tomlBasicString` for the base URL value is exactly right for preventing TOML escaping bugs on user-supplied endpoint strings. Three small observations:
>
> **1. Comment accuracy.** In `createCodexConfigOverrides`, the comment says *"route through the plain `openai` provider (Chat Completions REST)"* but the override sets `wire_api="responses"` — that's the new WebSocket `/v1/responses` API, not Chat Completions REST. Since the whole reason for this change is that 0.124 dropped `wire_api="chat"`, worth tightening the wording.
>
> **2. Env ordering in `container-runner.ts`.** [second observation with similar depth]
>
> **3. Small gap in tests.** [third observation]
>
> Otherwise looks ready. 👍

### Example — context comment on an issue with design questions (#1984)

> Some context on the Codex side — `auth.json` mount and `OPENAI_BASE_URL` behavior are both code we shipped in #1843.
>
> **Re: #1 (unconditional `auth.json` mount).** Fair catch — [history + agreement with fix direction + design-preference vote].
>
> **Re: #2 (`model_provider` override) — confirmed the 0.124 behavior you describe.** [history of why we removed it + test showing current version regressed + support for fix direction].
>
> **Scoping.** My lean: **2 PRs, not 4.** [reasoning].
>
> No useful signal to add on the OpenCode side — don't know that codebase deeply enough.

---

## Technical context the agent should know

### Codex version behavior

- **0.118** — `OPENAI_BASE_URL` honored natively by built-in `openai` provider (tested: `OPENAI_BASE_URL=http://127.0.0.1:9/v1 codex exec "hi"` hits `http://127.0.0.1:9/v1/models`).
- **0.121+ (including currently shipped `CODEX_VERSION=0.121.0`)** — `OPENAI_BASE_URL` ignored. Codex falls through to `wss://api.openai.com/v1/responses`. Built-in `openai` id reserved and hardcoded.
- **Implication** — our #1843 assumed env-var path was stable; was not. PR #1994 is the correct replacement using nested `-c model_providers.<name>.*` keys with `wire_api="responses"`.

### The @-import story

- v2 convention: `CLAUDE.md` is canonical. Group files start with `@./.claude-global.md` (symlinked in group dir to `/workspace/global/CLAUDE.md`).
- Claude SDK expands `@-imports` natively. Codex and OpenCode do not.
- **#1843 fix was narrow** — unconditionally appended `/workspace/global/CLAUDE.md` for non-main groups. Mirrored OpenCode's behavior exactly.
- **#1966 fix is broader** — real recursive resolver, handles arbitrary `@-imports`, adds `CLAUDE.local.md`.

### FlexAgents AGENT.md assembly (NOT portable to v2)

- v1-based approach: concatenated `AGENT.md`/`CLAUDE.md` with `---`, appended `CODEX_TOOL_GUIDANCE`, written to `AGENTS.md` on disk, passed as `baseInstructions`.
- Fundamentally different from v2's `@-import` composition. Don't propose this as a fix to v2 code.

### Codex tone compensation (content-layer)

- Even with `personality: 'friendly'`, Codex-backed agents feel tersely different from Claude-backed ones in the same group.
- Chip's fork compensates with explicit warmth directive in per-group persona file:
  > "You are warm, personable, and genuinely helpful — not a robotic assistant. Speak naturally as a real person would. Avoid one-word answers. If a task is interesting, say so. If something looks concerning, flag it proactively. You have personality — use it."
- Not a code concern; persona content.

### Husky hook quirk on qwibitai/nanoclaw

- Pre-commit hook runs `pnpm run format:fix` unscoped (formats all `src/**/*.ts`, not just staged files).
- Surfaces whole-tree prettier drift on every commit.
- Chip flagged this as an unrelated observation after PR #1843 merged. Maintainer hasn't acted.

---

## Where history lives

Running history of detected events (merges, comments, new threads, etc.) lives in `/workspace/group/nanoclaw-monitor/history.md` — **mutable**, agent appends per run. **This** file (`context.md`) is the stable reference: threads, voice, discipline, technical facts. Updates to `context.md` happen via host-side edit + container rebuild; history.md updates live.

Read history.md alongside this file at the start of each run for recent-event memory; the entry of a new event goes there, not here.

## When to update this file (context.md)

Manual edit by Chip required for:
- New active thread to monitor → add to "Active threads" with response policy
- New recurring contributor → add to "Who's who"
- Voice preference shift → update voice guide
- Scope discipline rule change (e.g., "OK to comment on OpenCode now")
- Technical context change (Codex version behavior, branch flow, etc.)

Agent should NOT edit this file. If detected events suggest the file is stale (thread closed, person no longer active, etc.), the agent flags it in the next delivery summary so Chip can edit on next rebuild.
