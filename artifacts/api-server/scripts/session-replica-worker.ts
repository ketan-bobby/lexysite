/** Isolated real app instance: no index/bootstrap, scheduler or provider traffic. */
import { mock } from "node:test";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { pool } from "@workspace/db";

// The production bundler loads guide HTML as text; source-driven Node fixtures
// need the identical asset semantics without running the production bootstrap.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".html"))
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))};`,
      };
    return nextLoad(url, context);
  },
});
// Preserve email formatting/helpers but replace transport BEFORE app imports.
const email = await import("../src/lib/email");
mock.module(new URL("../src/lib/email.ts", import.meta.url).href, {
  namedExports: {
    ...email,
    sendEmail: async () => {
      process.send?.({ kind: "simulated-email" });
      return { ok: true, simulated: true };
    },
  },
});
const { default: app } = await import("../src/app");
const server = createServer(app);
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing replica address");
  process.send?.({ port: address.port, pid: process.pid });
});
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
};
process.once("SIGTERM", close);
process.once("SIGINT", close);
process.once("disconnect", close);
