/**
 * A stateful stand-in for the `openshell` CLI: sandboxes live in a map and the
 * subcommands the driver uses (create / get / list / delete / status) behave
 * like the real CLI's observable surface — JSON docs, label selectors, a
 * not-found error on get, idempotent delete. Tests assert on what the driver
 * DID (recorded argv + child env) and steer the runtime by mutating `boxes`.
 */
import type { OpenShellCli } from '../openshell-driver.js';

export interface FakeSandbox {
  name: string;
  phase: string;
  exit_code: number | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export class FakeOpenShell implements OpenShellCli {
  readonly bin = 'openshell';
  readonly calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
  readonly boxes = new Map<string, FakeSandbox>();
  /** Next call whose joined argv matches throws this message (consumed once). */
  failNext: Array<{ match: RegExp; message: string }> = [];
  /** Simulates a CLI older than 0.1.10 (no `policy lint`). */
  lintUnsupported = false;
  statusOutput = 'Server Status\n  Status: Connected\n';

  async run(args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<string> {
    this.calls.push({ args, env: opts?.env });
    const joined = args.join(' ');
    const fail = this.failNext.find((f) => f.match.test(joined));
    if (fail) {
      this.failNext.splice(this.failNext.indexOf(fail), 1);
      throw new Error(fail.message);
    }
    if (args[0] === 'status') return this.statusOutput;
    if (args[0] === 'policy' && args[1] === 'lint') {
      if (this.lintUnsupported) throw new Error("error: unrecognized subcommand 'lint'");
      return 'policy ok';
    }
    const [, verb] = args;
    if (verb === 'get') {
      const box = this.boxes.get(args[2]);
      if (!box) throw new Error(`Error: × code: 'Some requested entity was not found', message: "sandbox not found"`);
      return JSON.stringify(box);
    }
    if (verb === 'list') {
      const selector = args[args.indexOf('--selector') + 1] ?? '';
      const want = Object.fromEntries(selector.split(',').map((kv) => kv.split('=')));
      const sandboxes = [...this.boxes.values()].filter((b) =>
        Object.entries(want).every(([k, v]) => b.labels[k] === v),
      );
      return JSON.stringify({ next_page_token: '', sandboxes });
    }
    if (verb === 'delete') {
      this.boxes.delete(args[2]);
      return `✓ Deleted sandbox ${args[2]}`;
    }
    if (verb === 'create') {
      const name = args[args.indexOf('--name') + 1];
      if (this.boxes.has(name)) throw new Error(`sandbox '${name}' already exists`);
      const labels: Record<string, string> = {};
      const annotations: Record<string, string> = {};
      args.forEach((a, i) => {
        if (a === '--label' || a === '--annotation') {
          const [k, ...v] = args[i + 1].split('=');
          (a === '--label' ? labels : annotations)[k] = v.join('=');
        }
      });
      const box: FakeSandbox = { name, phase: 'Ready', exit_code: null, labels, annotations };
      this.boxes.set(name, box);
      return JSON.stringify(box);
    }
    throw new Error(`fake openshell: unhandled ${joined}`);
  }

  argsOf(verb: string): string[] | undefined {
    return this.calls.find((c) => c.args[1] === verb)?.args;
  }
}
