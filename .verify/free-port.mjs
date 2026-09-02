import net from "node:net";

/**
 * A free TCP port at or above `start`.
 *
 * Every harness script boots its own PGlite on a socket. With fixed ports they
 * collided with each other and with a running `npm run dev:sandbox`, which made
 * the test suite unrunnable while the sandbox was up.
 *
 * The check binds TWICE, and that matters: PGLiteSocketServer binds
 * specifically to 127.0.0.1, while `next dev` binds all interfaces. Windows
 * happily grants 0.0.0.0:P while 127.0.0.1:P is already held, so probing only
 * the wildcard reported "free" for a port PGlite then failed to open. A port is
 * free only if both binds succeed.
 */
function canBind(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    if (host) probe.listen(port, host);
    else probe.listen(port);
  });
}

export async function portFree(port) {
  if (!(await canBind(port, "127.0.0.1"))) return false;
  return canBind(port);
}

export async function freePortFrom(start, label = "port") {
  for (let port = start; port < start + 60; port += 1) {
    if (await portFree(port)) return port;
  }
  throw new Error(`No free ${label} between ${start} and ${start + 59}`);
}
