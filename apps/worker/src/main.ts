import { createJobQueue } from "@mail-hub/database";

const connectionString = process.env.DATABASE_URL;

if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("DATABASE_URL is required to start the worker.");
}

const queue = createJobQueue(connectionString);
await queue.start();

const stop = async () => {
  await queue.stop();
  process.exitCode = 0;
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
