-- Lester 1.0.1: hashed API tokens (S3), persisted login throttling (S2),
-- Proof checkpoints (P2), chain hashVersion (P1).
--
-- Data safety: existing plaintext User.apiToken values are preserved in
-- ApiTokenLegacy and re-hashed by the application at next boot (a raw SQL
-- engine cannot compute scrypt/sha256 portably). Existing ProofEntry rows are
-- marked hashVersion='v1' and re-hashed to v2 by scripts/migrate.ts after the
-- legacy chain verifies — never silently.

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "firstFailedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFailedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ProofCheckpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seq" INTEGER NOT NULL,
    "headHash" TEXT NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature" TEXT NOT NULL,
    "keyId" TEXT NOT NULL
);

-- Preserve v1.0.0 plaintext API tokens for application-level re-hashing.
CREATE TABLE "ApiTokenLegacy" (
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "ApiTokenLegacy" ("userId", "token", "createdAt")
SELECT "id", "apiToken", "createdAt" FROM "User" WHERE "apiToken" IS NOT NULL;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("createdAt", "disabled", "displayName", "id", "passwordHash", "role", "updatedAt", "username") SELECT "createdAt", "disabled", "displayName", "id", "passwordHash", "role", "updatedAt", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Session" ("createdAt", "expiresAt", "id", "lastSeenAt", "userId") SELECT "createdAt", "expiresAt", "id", "lastSeenAt", "userId" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE TABLE "new_ProofEntry" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "username" TEXT,
    "workspaceId" TEXT,
    "workspaceName" TEXT,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "modelKey" TEXT,
    "provider" TEXT,
    "providerLabel" TEXT,
    "endpointHost" TEXT,
    "endpointIp" TEXT,
    "egress" TEXT,
    "latencyMs" INTEGER,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "redactions" INTEGER,
    "detail" TEXT NOT NULL DEFAULT '{}',
    "content" TEXT,
    "prevHash" TEXT,
    "selfHash" TEXT,
    "hashVersion" TEXT NOT NULL DEFAULT 'v2'
);
-- migrated rows keep their original (v1) hash form until the verified re-hash
INSERT INTO "new_ProofEntry" ("action", "content", "detail", "egress", "endpointHost", "endpointIp", "hashVersion", "latencyMs", "modelKey", "prevHash", "provider", "providerLabel", "redactions", "selfHash", "seq", "status", "tokensIn", "tokensOut", "ts", "userId", "username", "workspaceId", "workspaceName") SELECT "action", "content", "detail", "egress", "endpointHost", "endpointIp", 'v1', "latencyMs", "modelKey", "prevHash", "provider", "providerLabel", "redactions", "selfHash", "seq", "status", "tokensIn", "tokensOut", "ts", "userId", "username", "workspaceId", "workspaceName" FROM "ProofEntry";
DROP TABLE "ProofEntry";
ALTER TABLE "new_ProofEntry" RENAME TO "ProofEntry";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");
