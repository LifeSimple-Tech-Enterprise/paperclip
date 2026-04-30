import { WakeTerminatedError } from "./errors.js";

export interface WakeTerminatedSentinel {
  _terminal: true;
  reason: string;
}

export function isWakeTerminatedSentinel(value: unknown): value is WakeTerminatedSentinel {
  return typeof value === "object" && value !== null && "_terminal" in value;
}

type FetchFn = typeof fetch;

export function wrapFetchForWakeTermination(fetchFn: FetchFn): FetchFn {
  return async function wrappedFetch(...args: Parameters<FetchFn>): Promise<Response> {
    const response = await fetchFn(...args);
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
        (body as Record<string, unknown>).code === "WAKE_TERMINATED"
      ) {
        const reason =
          typeof (body as Record<string, unknown>).error === "string"
            ? ((body as Record<string, unknown>).error as string)
            : "wake_terminated";
        return { _terminal: true, reason } as unknown as Response;
      }
    }
    return response;
  } as FetchFn;
}

export { WakeTerminatedError };
