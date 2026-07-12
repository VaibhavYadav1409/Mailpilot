// crypto.ts and jwt.ts throw at import time if their required env vars are
// missing (fail-fast by design — see the comments in those files). Tests
// that import them need these set before the import happens, which is why
// this file is wired in as vitest's `setupFiles` rather than imported
// per-test.
process.env.GMAIL_TOKEN_ENC_KEY ??= "a".repeat(64);
process.env.JWT_SECRET ??= "test-secret-do-not-use-in-production";
process.env.REPORT_STORAGE_DRIVER ??= "local";
