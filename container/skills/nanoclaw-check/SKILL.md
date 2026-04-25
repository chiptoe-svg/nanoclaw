---
name: nanoclaw-check
description: Monitor qwibitai/nanoclaw upstream for activity related to Chip's contributions. Classifies new issues/PRs/comments as FYI vs response-needed, drafts responses for review, delivers a summary to Telegram. Triggered by scheduled task; safe to run manually as `/nanoclaw-check`.
---

# /nanoclaw-check — nanoclaw upstream monitor

Background skill. Runs on a schedule (typically 9am, 1pm, 5pm). Reads stable context from this skill folder; reads/writes mutable state from the group folder. Drafts responses but **NEVER posts them autonomously** — Chip approves before anything ships to a public thread.

## Inputs

- **Stable context (read-only):** `./context.md` in this skill's folder. Contains active threads, response policies, voice patterns, scope discipline, technical context.
- **Mutable state (read/write):** `/workspace/group/nanoclaw-monitor/last-check.json` (timestamp) and `/workspace/group/nanoclaw-monitor/history.md` (event log).
- **Auth:** `gh` CLI authenticated via `GH_TOKEN` env var (read-only public-repo access scope is enough).

## Step 1 — Load context (required)

Read `./context.md` in full before proceeding. Do not skip this step. The classification rules, response policies per thread, voice guide, and scope discipline live there. All downstream decisions depend on it.

If `./context.md` is missing or empty, abort with a message to Chip via `mcp__nanoclaw__send_message`: *"context.md missing in nanoclaw-check skill folder — skill cannot run safely"*. Do not improvise without context.

## Step 2 — Read state

Read `/workspace/group/nanoclaw-monitor/last-check.json`. Expected shape:

```json
{
  "lastCheckedIso": "2026-04-24T17:00:00Z",
  "lastDeliveryIso": "2026-04-24T17:05:00Z",
  "lastEventCount": 2
}
```

If missing, treat as first run: set `lastCheckedIso` to 7 days ago. Create the directory if needed.

Read `/workspace/group/nanoclaw-monitor/history.md` if present. Append-only event log; use it for recent-event memory (e.g., "we already flagged this PR yesterday — only mention if there's new activity since then").

## Step 3 — Query upstream activity since last check

Goal: find any new issues, PRs, comments, or reviews on `qwibitai/nanoclaw` since `lastCheckedIso`.

Strategy:

1. **Check tracked threads** (numbers in context.md §Active threads — currently #1843, #1955, #1956, #1966, #1984, #1994, #1995). For each:

   ```bash
   gh issue view <N> --repo qwibitai/nanoclaw --json comments,state,closedAt
   gh pr view <N> --repo qwibitai/nanoclaw --json comments,reviews,state,mergedAt 2>/dev/null
   ```

   Filter comments/reviews by `createdAt > lastCheckedIso`.

2. **Find new issues/PRs** in the repo touching keywords from context.md (codex, provider, opencode, file-ops, latency, mcp, @chiptoe-svg):

   ```bash
   gh search issues "repo:qwibitai/nanoclaw updated:>=$LAST_CHECK codex" --json number,title,author,createdAt,state
   gh search issues "repo:qwibitai/nanoclaw updated:>=$LAST_CHECK provider"
   # ...repeat for other keywords
   ```

   Use `--updated` filter (catches issues with new comments without per-thread queries).

3. **Watch for direct mentions** of `@chiptoe-svg` anywhere in the repo:

   ```bash
   gh search issues "repo:qwibitai/nanoclaw mentions:chiptoe-svg updated:>=$LAST_CHECK"
   ```

Deduplicate results.

## Step 4 — Classify each item

For each new event, classify per `context.md` §Scope discipline rules:

- **FYI (no action)** — informational, no response needed:
  - Comments by maintainer or others on threads that don't ask Chip anything
  - +1 reactions or simple acknowledgments
  - Activity on threads where context.md response policy says "Staying silent" (e.g., #1995)
  - Activity on threads we already commented on where conversation is quiet

- **RESPONSE NEEDED** — draft a reply per voice guide:
  - Direct @mention or quote of Chip
  - Maintainer responds to one of Chip's open issues (#1955, #1956) with design questions
  - Someone asks a question about Chip's #1843 code that needs context only Chip has
  - Reviewer feedback on Chip's posted comments asking for clarification

When in doubt, classify as FYI. Over-flagging "needs response" trains learned helplessness.

## Step 5 — Draft responses (only for RESPONSE NEEDED items)

For each item classified RESPONSE NEEDED:

1. Read the full thread (the relevant comment + immediate prior context). Use `gh pr view <N> --comments` or `gh issue view <N> --comments`.
2. Match Chip's voice per `context.md` §Voice guide:
   - Acknowledge the work first
   - Bold-label structure for multi-point responses
   - Honest about scope; avoid hedges ("really", "actually", "just")
   - End with scope clarity
3. Generate draft. Keep it tight — drafts that exceed ~250 words probably overstuffed.
4. Provide reasoning for why you suggested this response (1–2 sentences). Helps Chip evaluate.

If drafting feels uncertain (e.g., novel design question, unclear voice fit), **don't draft** — flag as "needs Chip's eyes" with no draft. Better than a bad draft.

## Step 6 — Deliver summary via Telegram

Use `mcp__nanoclaw__send_message` to send a summary to the current group (Telegram main).

### When to send vs. stay silent

- **Send:** any RESPONSE NEEDED items, OR any FYI items the agent thinks Chip wants to know about (significant merges, new contributors engaging Chip's threads, etc.)
- **Stay silent:** all events were trivial FYI (minor non-Chip comments on quiet threads, etc.) AND less than 7 days since last delivery
- **Heartbeat:** if 7+ days since last delivery, send a brief "all quiet — last 7 days had N small events, none requiring action" so Chip knows the skill is still running

### Format

```
📬 Nanoclaw update — N items since <last check>

## No action
- [#NNNN](url) — 1-line summary
- [#NNNN](url) — 1-line summary

## Worth responding to
### [#NNNN](url) — 1-line context
**Suggested response:**
```
<draft>
```
**Why:** <1-2 sentence reasoning>

---

(or if quiet:)

📬 Nanoclaw quiet check — no new activity since <last check>
```

Use Markdown that Telegram renders. Truncate any URL with > 80 chars.

## Step 7 — Update mutable state

Atomic-ish write to `/workspace/group/nanoclaw-monitor/last-check.json`:

```json
{
  "lastCheckedIso": "<now ISO>",
  "lastDeliveryIso": "<now ISO if delivered, else preserve prior>",
  "lastEventCount": <N>
}
```

Append to `/workspace/group/nanoclaw-monitor/history.md`:

```markdown
## 2026-04-25 13:00 EST — N events
- FYI: #NNNN — 1-line summary
- RESPONSE NEEDED: #NNNN — 1-line summary (draft delivered)
- HEARTBEAT (no events) — when applicable
```

Keep `history.md` append-only. Trimming/archiving is Chip's call.

## Step 8 — Flag stale context (occasional)

If during analysis the agent notices `context.md` looks stale (e.g., a thread is closed and no longer needs monitoring, a contributor hasn't been active in 30+ days), include a one-liner at the bottom of the delivery message:

> 🔧 *Context note: thread #1955 closed last week — consider removing from active threads list on next rebuild.*

Don't edit `context.md` directly. Flag it for Chip.

## Failure modes

- **`gh` auth fails** → send error message to Chip, don't crash silently
- **`context.md` missing** → abort per Step 1
- **Network/rate-limit error** → log to `history.md`, retry on next scheduled run
- **Drafting can't decide between FYI and RESPONSE** → classify as RESPONSE without draft, let Chip judge
- **State file corruption** → recreate with `lastCheckedIso` = 24 hours ago (conservative restart)

## Manual invocation

This skill is safe to run manually any time as `/nanoclaw-check`. Will use the same state file, so manual + scheduled runs interleave cleanly.

## What this skill does NOT do

- Post comments to GitHub (autonomously or otherwise)
- Edit `context.md` (only flag for Chip's manual update)
- Notify Chip of events Chip already commented on within the last 24h (unless someone responds to him)
- Engage threads explicitly listed as "Staying silent" in context.md
- Make architectural recommendations to Chip beyond what's in context.md voice guide
