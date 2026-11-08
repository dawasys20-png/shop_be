
require("dotenv").config();

const path = require("node:path");
const { runner } = require("node-pg-migrate");

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  await runner({
    databaseUrl: {
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: true,
      },
    },
    dir: path.join(__dirname, "..", "migrations"),
    direction: "up",
    migrationsTable: "pgmigrations",
    verbose: true,
  });

}

if (require.main === module) {
  runMigrations().catch((error) => {
    console.error("Error running migrations:", error);
    process.exitCode = 1;
  });
}

module.exports = { runMigrations };
