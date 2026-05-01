-- up: add requires_workspace column to agents table (LIF-454 Layer 1)
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "requires_workspace" boolean NOT NULL DEFAULT false;
