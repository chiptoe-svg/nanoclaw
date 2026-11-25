/**
 * Host-side loopback TCP forwarder: 127.0.0.1:<listen> → 127.0.0.1:<target>.
 *
 * OpenShell always blocks a fixed set of ports on exact hostnames, and
 * OneCLI's proxy port (10255) is one of them, so a sandbox cannot reach the
 * credential gateway directly. The driver re-points the sandbox's proxy env at
 * this forwarder instead. Bound to loopback only — it must never become a
 * LAN-reachable open proxy hop — and started lazily, on the first session
 * that needs it, so a host with no OpenShell sessions opens no port at all.
 */
import net from 'net';

import { log } from '../../log.js';

export interface Forwarder {
  readonly listenPort: number;
  readonly targetPort: number;
  close(): Promise<void>;
}

export function startForwarder(listenPort: number, targetPort: number, host = '127.0.0.1'): Promise<Forwarder> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, host);
    sockets.add(client);
    sockets.add(upstream);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', drop);
    upstream.on('error', (err) => {
      log.debug('OpenShell forwarder upstream error', { targetPort, err: err.message });
      drop();
    });
    client.on('close', drop);
    upstream.on('close', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  // The host process has its own reasons to stay alive; this must not be one.
  server.unref();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, host, () => {
      server.off('error', reject);
      server.on('error', (err) => log.warn('OpenShell forwarder error', { listenPort, err: err.message }));
      log.info('OpenShell proxy forwarder listening', { listen: `${host}:${listenPort}`, target: targetPort });
      resolve({
        listenPort,
        targetPort,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
