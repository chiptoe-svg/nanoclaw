/**
 * Registers the `openshell` session driver kind. Reached through the import
 * appended to `src/drivers/installed.ts`.
 *
 * The driver is the install's `docker` driver with the agent groups in
 * NANOCLAW_OPENSHELL_GROUPS routed to OpenShell MicroVMs (composite.ts). With
 * no group listed it is the `docker` driver itself, unwrapped.
 *
 * It is not selected directly. A MicroVM cannot share the session directory's
 * SQLite files with the host, so every OpenShell group runs on the remote
 * mailbox: the operator selects `NANOCLAW_RUNTIME_DRIVER=remote-mailbox` and
 * `NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER=openshell`. The mailbox driver stays
 * the outer layer (it rewrites the spec); `translate.ts` then realizes the
 * rewritten spec as a sandbox. `warnIfNotStacked` names the missing setting.
 */
import path from 'path';

import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { REMOTE_MAILBOX_GROUPS, REMOTE_MAILBOX_INNER_DRIVER } from '../../mailbox/remote/config.js';
import { getSessionDriverFactory, registerSessionDriver } from '../driver-registry.js';
import { OpenShellSessionDriver } from '../openshell-driver.js';
import type { MountPolicy, SessionDriver } from '../types.js';
import { withOpenShellGroups } from './composite.js';
import { OPENSHELL_FORWARD_PORT, OPENSHELL_GROUPS } from './config.js';

export const OPENSHELL_DRIVER_KIND = 'openshell';
/** The driver every group not listed in NANOCLAW_OPENSHELL_GROUPS keeps. */
export const PRIMARY_DRIVER_KIND = 'docker';

/** Looked up when the driver is built, not at import: `docker` registers after the overlays load. */
export function createOpenShellDriver(policy: MountPolicy): SessionDriver {
  const factory = getSessionDriverFactory(PRIMARY_DRIVER_KIND);
  if (!factory) throw new Error(`openshell driver: no '${PRIMARY_DRIVER_KIND}' driver is registered`);
  return withOpenShellGroups(
    factory(policy),
    { groups: OPENSHELL_GROUPS, remoteMailboxGroups: REMOTE_MAILBOX_GROUPS },
    () =>
      new OpenShellSessionDriver({
        ...policy,
        forwardPort: OPENSHELL_FORWARD_PORT,
        stagingRoot: path.join(policy.dataRoot, 'openshell-staging'),
      }),
  );
}

registerSessionDriver(OPENSHELL_DRIVER_KIND, createOpenShellDriver);

/** Groups are listed but the driver chain does not reach OpenShell: say which setting is missing. */
export function warnIfNotStacked(
  env: NodeJS.ProcessEnv = process.env,
  groups: readonly string[] = OPENSHELL_GROUPS,
  innerDriver: string = REMOTE_MAILBOX_INNER_DRIVER,
): void {
  if (groups.length === 0) return;
  const runtime = (
    env.NANOCLAW_RUNTIME_DRIVER?.trim() ||
    readEnvFile(['NANOCLAW_RUNTIME_DRIVER']).NANOCLAW_RUNTIME_DRIVER?.trim() ||
    ''
  ).toLowerCase();
  if (runtime === 'remote-mailbox' && innerDriver === OPENSHELL_DRIVER_KIND) return;
  log.error(
    'NANOCLAW_OPENSHELL_GROUPS is set but the session driver does not reach OpenShell: set ' +
      'NANOCLAW_RUNTIME_DRIVER=remote-mailbox and NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER=openshell; ' +
      'until then the listed groups do not run as OpenShell MicroVMs',
    { groups, runtimeDriver: runtime || 'docker', innerDriver },
  );
}

warnIfNotStacked();
