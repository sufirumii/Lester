-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "apiToken" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "defaultModel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "policyId" TEXT,
    CONSTRAINT "Workspace_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
    "redactPii" BOOLEAN NOT NULL DEFAULT true,
    "blockKeywords" TEXT NOT NULL DEFAULT '',
    "allowedModels" TEXT NOT NULL DEFAULT '',
    "maxTokens" INTEGER NOT NULL DEFAULT 2048,
    "logContent" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ModelEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "family" TEXT NOT NULL DEFAULT '',
    "paramsB" REAL NOT NULL DEFAULT 0,
    "quant" TEXT NOT NULL DEFAULT '',
    "sizeMb" INTEGER NOT NULL DEFAULT 0,
    "ramReqMb" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL DEFAULT '',
    "installed" BOOLEAN NOT NULL DEFAULT false,
    "approved" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" DATETIME,
    "meta" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New conversation',
    "modelKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "modelKey" TEXT,
    "provider" TEXT,
    "latencyMs" INTEGER,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "redactions" INTEGER NOT NULL DEFAULT 0,
    "citations" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Document_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    CONSTRAINT "Chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProofEntry" (
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
    "selfHash" TEXT
);

-- CreateTable
CREATE TABLE "FitRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "prompts" TEXT NOT NULL,
    "candidates" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "results" TEXT NOT NULL DEFAULT '[]',
    "samples" TEXT NOT NULL DEFAULT '[]',
    "summary" TEXT NOT NULL DEFAULT '{}',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Backup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'manual',
    "entries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "License" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "nodes" INTEGER NOT NULL DEFAULT 1,
    "userLimit" INTEGER NOT NULL DEFAULT 25,
    "nodeId" TEXT NOT NULL,
    "issuedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME,
    "valid" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_apiToken_key" ON "User"("apiToken");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_policyId_key" ON "Workspace"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_workspaceId_key" ON "Policy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelEntry_key_key" ON "ModelEntry"("key");

