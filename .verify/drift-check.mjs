// Confirms the hand-written migrations produce exactly the schema that
// schema.prisma describes. Exit code 2 from `migrate diff` means drift.
import { spawn } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = 54330;
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?schema=public&connection_limit=1&statement_cache_size=0`;
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
await server.start();

const cmd =
  "npx prisma migrate diff --from-migrations ./prisma/migrations " +
  "--to-schema-datamodel ./prisma/schema.prisma " +
  `--shadow-database-url "${url}" --exit-code`;

const code = await new Promise((resolve) => {
  // schema.prisma references DATABASE_URL_UNPOOLED, so the CLI needs it set even
  // though migrate diff only touches the shadow database.
  const child = spawn(cmd, {
    shell: true,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url },
  });
  child.on("exit", (c) => resolve(c ?? 1));
});

await server.stop();
await db.close();
console.log(code === 0 ? "\nNO DRIFT: migrations match schema.prisma" : `\nDRIFT (exit ${code})`);
process.exit(code === 0 ? 0 : 1);
