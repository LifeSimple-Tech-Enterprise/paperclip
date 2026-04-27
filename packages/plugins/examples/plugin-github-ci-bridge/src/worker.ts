/**
 * github-ci-bridge worker stubs — TDD red phase.
 *
 * All functions throw "not implemented" so that tests importing these symbols
 * compile but fail at runtime. Drafter (LIF-340 / LIF-341 / LIF-342) will
 * replace these stubs with real implementations.
 */

export async function onWebhook(_input: unknown): Promise<{ ok: boolean }> {
  throw new Error("not implemented");
}

export async function verifyHmac(
  _rawBody: string,
  _signatureHeader: string,
  _timestampHeader: string,
  _secrets: string[],
): Promise<{ ok: boolean; reason?: string }> {
  throw new Error("not implemented");
}

export async function resolveIssue(
  _payload: unknown,
  _dbHandle: unknown,
): Promise<{ issueId: string | null; unresolved?: boolean }> {
  throw new Error("not implemented");
}

export async function reactToEvent(
  _event: unknown,
  _ctx: unknown,
): Promise<void> {
  throw new Error("not implemented");
}
