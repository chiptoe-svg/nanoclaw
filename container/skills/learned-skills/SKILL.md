---
name: learned-skills
description: How to write, update and review your own learned skills with propose_skill. Use before proposing a skill, or when asked to review recent work for lessons worth keeping.
---

# Learned skills

A learned skill is the procedure for one class of task done the best way for this user: the steps, the tools and commands that work, the order, how the user wants the result to look, and the pitfalls that cost time. You propose it with `propose_skill`; an admin reads the full text and approves it; it is installed at `~/.claude/skills/<name>/SKILL.md` and future sessions load it when its description matches.

## Decide what to do

In this order:

1. **A skill you used this session was wrong, missing a step, or out of date** → update it now. Read `~/.claude/skills/<name>/SKILL.md` first (not your memory of it), fix the sentence that misled you in place, and send the whole file. Never append "UPDATE: actually…" under the old text.
2. **One of your learned skills covers this area** → update it with the new rule or step.
3. **A new class of task with a procedure that is now clear** → create a skill named for the class (`earnings-call-notes`, `x-scrape-recovery`), never for one instance, a date, a ticker, an error string or "fix-X-today".
4. **Otherwise** → nothing. Most tasks should end here.

Only your learned skills can be updated or archived. In `ls -l ~/.claude/skills` they are real directories; installed skills are links into `/app/skills` and cannot be changed this way. If an installed skill is wrong, tell the user what should change.

## What counts as a signal

- The user corrected your format, tone, workflow or choice of source, or said "stop doing X", "always", "from now on". These are the strongest signals.
- A technique, fix or workaround took real effort to find and will be needed again.
- You repeated a multi-step procedure you had already worked out before.

## Never capture

- **Environment failures**: missing binaries, "command not found", expired logins, a site that was down. Capture the fix if you found one, not the failure.
- **Negative claims** ("the browser tool doesn't work on X"). They harden into refusals long after the problem is gone.
- **Unresolved attempts**: if you never found a working method, there is no procedure to save.
- **One-off narratives**, quoted user text, dates, ticket or PR numbers, prices or other data that will go stale.
- **Credentials of any kind.** The host rejects proposals that look like they contain one.
- **A one-off request as a standing preference**, unless the user marked it general.

## Format

```markdown
---
name: <same as the propose_skill name>
description: <one line, 20-300 characters: what it is for and when to use it>
---

# <Title>

## When to use

<the situations this applies to, concretely enough to match on>

## Procedure

1. <steps in order, with the exact tools, commands, paths or sources that work>

## Pitfalls

- <rule, imperative> — <one clause on why>

## Verification

<how to check the result is right before reporting it>
```

Keep it under 12,000 characters; most good skills are well under 3,000. The same lesson learned twice is one rule, not two. Write rules the next session can follow without this conversation.

## Proposing

- `propose_skill({ op: "create", name, content, rationale })` — full SKILL.md in `content`.
- `propose_skill({ op: "update", name, content, rationale })` — read the current file first; send the complete new version. If another change was approved since you read it, the host refuses and you re-read.
- `propose_skill({ op: "archive", name, rationale })` — for a learned skill that is obsolete or fully absorbed into another (say which).

`rationale` is what the approver reads first: one or two sentences on what happened. Then tell the user in one sentence what you proposed, and carry on — don't wait for the decision.

The host refuses a new skill that overlaps heavily with an existing learned skill; update that one instead.

## Reviewing recent work

A scheduled skill review wakes you only when its gate script flagged heavy turns: past requests that took many tool calls and ended without a proposal. The task data lists them (`flagged`: `at`, `toolCalls`, `request`). For each:

1. Read what actually happened: `bun /app/skills/learned-skills/show-turn.ts <at>`. Judge from the transcript, not from memory.
2. Look for the signals above, and for waste: steps that failed and were retried, commands you had to look up, files you searched for, a slow route where a direct one existed. A procedure that would have made the turn take a third of the calls is worth keeping.
3. Check your learned skills in that area (`ls -l ~/.claude/skills`, read the relevant ones) and decide update, create or nothing, using the order at the top.

Propose at most two changes per review, updates before creations. A heavy turn is not automatically a lesson: research that needed many searches may simply have needed them. "Nothing worth saving" is a good result.

Keep the whole review inside `<internal>…</internal>`. Don't message the user; the approval request already tells them what you proposed.

Outside a scheduled review, if the user asks you to review recent work, do the same with the conversation you have, and reply to them normally.
