/**
 * Cucumber BeforeAll hook — bootstraps TEST_COMPANY_ID from the running
 * Paperclip instance when the env var is not pre-set.
 *
 * The server must already be running (local_trusted mode).
 * Pass PAPERCLIP_E2E_PORT to point at a non-default port.
 */

import { BeforeAll, AfterAll, setDefaultTimeout } from "@cucumber/cucumber";
import { BASE_URL } from "./test-utils";

setDefaultTimeout(60_000);

BeforeAll(async function () {
  if (process.env.TEST_COMPANY_ID) return;

  const res = await fetch(`${BASE_URL}/api/companies`).catch(() => null);
  if (!res || !res.ok) {
    throw new Error(
      `Cannot bootstrap TEST_COMPANY_ID: Paperclip is not reachable at ${BASE_URL}. ` +
        "Start the server first (e.g. pnpm paperclipai onboard --yes --run).",
    );
  }
  const companies = (await res.json()) as Array<{ id: string }>;
  if (companies.length === 0) {
    throw new Error("No companies found in the running Paperclip instance.");
  }
  process.env.TEST_COMPANY_ID = companies[0].id;
});

AfterAll(async function () {
  // intentionally empty
});
