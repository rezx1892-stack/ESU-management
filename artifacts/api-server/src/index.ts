import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Start Discord bot with exponential-backoff retry so a temporary
// Cloudflare / gateway rate-limit doesn't leave the bot offline forever.
(async () => {
  const MAX_RETRIES = 20;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await startBot();
      return; // connected — done
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg === "login_timeout";
      const backoffMs = Math.min(30_000, 5_000 * Math.pow(1.5, attempt - 1));
      if (isTimeout) {
        logger.warn({ attempt, backoffMs }, "Discord login timed out (rate-limited?) — retrying after backoff");
      } else {
        logger.error({ err, attempt, backoffMs }, "Discord bot crashed — retrying after backoff");
      }
      if (attempt === MAX_RETRIES) {
        logger.error("Discord bot failed to connect after maximum retries — giving up");
        return;
      }
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
})();
