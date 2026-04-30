export class WakeTerminatedError extends Error {
  reason: string;
  constructor(reason: string) {
    super(`wake terminated by harness: ${reason}`);
    this.name = "WakeTerminatedError";
    this.reason = reason;
  }
}
