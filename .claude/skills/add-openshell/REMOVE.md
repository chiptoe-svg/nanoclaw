# Remove OpenShell MicroVM sessions

1. In `.env`, delete `NANOCLAW_OPENSHELL_GROUPS` and
   `NANOCLAW_OPENSHELL_FORWARD_PORT`, and delete
   `NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER=openshell` (the remote mailbox then
   wraps `docker` again). Restart the host with `bash setup/lib/restart.sh`,
   then restart each formerly listed group with
   `ncl groups restart --id <group-id>` so its next session runs in Docker.

2. Delete the group's leftover sandboxes. Their names start with
   `nc-<slug>-`, where `<slug>` is the first 8 letters and digits of this
   copy's install slug:

   ```bash
   openshell sandbox list
   openshell sandbox delete <name>
   ```

3. Delete this line from `src/drivers/installed.ts`, leaving the other lines:

   ```ts
   import './openshell/register.js';
   ```

4. Delete every file the skill copied (the destinations in the `nc:copy` block
   of [SKILL.md](SKILL.md)):

   ```bash
   rm -rf src/drivers/openshell src/drivers/openshell-driver.ts src/drivers/openshell-driver.test.ts
   ```

5. Delete the driver's staging and log directories:

   ```bash
   rm -rf data/openshell-staging data/openshell-logs
   ```

6. Rebuild and restart: `pnpm run build && bash setup/lib/restart.sh`.

OpenShell itself (Homebrew formula, gateway service, `~/.config/openshell/`)
belongs to the operator; uninstall it separately if nothing else uses it.
