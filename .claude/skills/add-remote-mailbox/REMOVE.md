# Remove the remote agent mailbox

1. In `.env`, delete `NANOCLAW_REMOTE_MAILBOX_GROUPS` and `NANOCLAW_MAILBOX_PORT`,
   and delete `NANOCLAW_RUNTIME_DRIVER=remote-mailbox` (or set it back to the
   driver the install used before). Restart the host with
   `bash setup/lib/restart.sh`, then restart each formerly listed group with
   `ncl groups restart --id <group-id>` so its next container gets the mounted
   session directory.

2. Delete this line from `src/drivers/installed.ts`, leaving the other lines:

   ```ts
   import '../mailbox/remote/driver.js';
   ```

3. Restore the runner's default mailbox slot,
   `container/agent-runner/src/mailbox/compose.ts`:

   ```ts
   /** Singular mailbox composition slot. See docs/agent-mailbox-seam-migration.md. */
   import { registerAgentMailbox } from './index.js';
   import { SqliteAgentMailbox } from './sqlite/index.js';

   registerAgentMailbox(() => new SqliteAgentMailbox());
   ```

4. Delete every other file the skill copied (the destinations in the `nc:copy`
   block of [SKILL.md](SKILL.md)):

   ```bash
   rm -rf src/mailbox/remote container/agent-runner/src/mailbox/remote
   ```

5. Delete the state the host service kept: tokens and per-session scratch
   directories and heartbeat files.

   ```bash
   rm -rf data/mailbox-tokens data/v2-sessions/*/.remote-workspace
   ```

6. If the egress-lockdown relay was set to forward the mailbox port, remove
   that forward.

7. Rebuild and restart: `pnpm run build && bash setup/lib/restart.sh`.
