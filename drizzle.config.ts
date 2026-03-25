import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./packages/evidence/src/schema.ts",
  out: "./packages/evidence/drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.HOST_DATABASE_URL ??
      "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf"
  }
});
