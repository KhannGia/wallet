import { buildApp, createDeps } from "./app.ts";

const deps = createDeps();
const app = buildApp(deps);

// Listening on 0.0.0.0 rather than localhost, otherwise the port is
// unreachable from outside the container.
await app.listen({ host: "0.0.0.0", port: deps.env.PORT });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await deps.pool.end();
      process.exit(0);
    })();
  });
}
