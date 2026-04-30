export type WakeTerminatedSentinel = { _terminal: true; reason: string };

export function isWakeTerminatedSentinel(value: unknown): value is WakeTerminatedSentinel {
  return typeof value === "object" && value !== null && "_terminal" in value;
}

export function wrapFetchForWakeTermination(
  fetchFn: typeof fetch,
): (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response | WakeTerminatedSentinel> {
  return async function wrappedFetch(input, init) {
    const response = await fetchFn(input, init);
    if (response.status === 410) {
      let body: unknown;
      try {
        body = await response.clone().json();
      } catch {
        return response;
      }
      if (
        typeof body === "object" &&
        body !== null &&
        (body as Record<string, unknown>)["code"] === "WAKE_TERMINATED"
      ) {
        const errorField = (body as Record<string, unknown>)["error"];
        const reason = typeof errorField === "string" && errorField.length > 0
          ? errorField
          : "wake_terminated";
        return { _terminal: true, reason };
      }
    }
    return response;
  };
}
