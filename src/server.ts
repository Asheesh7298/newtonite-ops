import { createApp } from "./app";
import { config } from "./config";
import { pool } from "./db";

const server = createApp().listen(config.port, () => console.log(`Operations Under Pressure on :${config.port}`));

const shutdown = () => {
  server.close(() => pool.end().then(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
