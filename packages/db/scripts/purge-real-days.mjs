// S5.5/V2.1 (D-046): deletes one user's saved days with real Amap places, their outings and their
// conversations (they name real places). Versions, activities, reservations, progress, confirmations,
// tasks, messages and decision records (chat_traces) cascade from their parent rows. Saved preferences
// are the user's own words and have their own delete-all on the 我的偏好 page.
// V2.12: per user (stages/V2.12.md §3.6); other users' data is untouched.
// Usage from the repository root: pnpm real-places:purge --user <用户名> --yes
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const at = process.argv.indexOf("--user");
const username = at >= 0 ? process.argv[at + 1]?.trim().toLowerCase() : undefined;
if (!username || !process.argv.includes("--yes")) {
  console.error("Usage: pnpm real-places:purge --user <username> --yes  (permanently deletes that user's real-place days, outings and conversations)");
  process.exit(2);
}
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const { rows } = await client.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!rows[0]) {
    console.error(`No user ${username}.`);
    process.exitCode = 2;
  } else {
    const userId = rows[0].id;
    await client.query("BEGIN");
    const chats = await client.query("DELETE FROM conversations WHERE user_id = $1", [userId]);
    const outings = await client.query("DELETE FROM trips WHERE user_id = $1", [userId]);
    const { rowCount } = await client.query("DELETE FROM journeys WHERE user_id = $1 AND creation_kind = 'real_day'", [userId]);
    await client.query("COMMIT");
    console.log(`${username}: deleted ${rowCount} real-place day(s), ${outings.rowCount} outing(s), ${chats.rowCount} conversation(s).`);
  }
} catch {
  await client.query("ROLLBACK").catch(() => {});
  // Never echo connection strings or driver messages.
  console.error("Purge failed: database unavailable or not migrated.");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
