/**
 * Cucumber configuration for the LIF-31 recovery-behaviour BDD suite.
 *
 * Run the full suite:
 *   npm run test:e2e:bdd
 *
 * Run with tag filter:
 *   npm run test:e2e:bdd -- --tags "@feature-recovery-watchdog"
 *   npm run test:e2e:bdd -- --tags "@feature-heartbeat-silent-cap"
 *   npm run test:e2e:bdd -- --tags "@feature-plan-in-review"
 *
 * Prerequisites: a running Paperclip instance (local_trusted mode).
 *   pnpm paperclipai onboard --yes --run
 *   PAPERCLIP_E2E_PORT=3199 npm run test:e2e:bdd
 */

export default {
  requireModule: ["tsx/cjs"],
  require: [
    "tests/e2e/support/global-setup.ts",
    "tests/e2e/support/step-defs/**/*.steps.ts",
  ],
  paths: ["tests/e2e/features/**/*.feature"],
  format: ["progress-bar", "json:tests/e2e/cucumber-report.json"],
  formatOptions: { snippetInterface: "async-await" },
  timeout: 60000,
};
