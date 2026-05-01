-- down: drop requires_workspace column from agents table (LIF-454 Layer 1)
ALTER TABLE "agents" DROP COLUMN IF EXISTS "requires_workspace";
