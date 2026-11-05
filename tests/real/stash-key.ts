try { process.loadEnvFile(".env.local"); } catch { /* no .env.local: only what the shell has */ }
process.env.STASHED_NEAR_AI_KEY = process.env.NEAR_AI_API_KEY ?? "";
