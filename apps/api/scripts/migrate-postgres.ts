import { migratePostgres } from "../src/migrate";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL for PostgreSQL migrations");
await migratePostgres(connectionString);
