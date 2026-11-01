/**
 * Child process for the resume-after-kill spawn tests (S50). It runs the
 * real CLI `main()`. The test selects the fixture provider
 * (`fixtures/plugins/ma-llm-resume-fixture-plugin`), which scripts each
 * round and kills the process at the round the test names.
 *
 * Argv: the CLI argv.
 *
 * @module startup/fixtures/resume-kill-child
 */

import { main } from "../../main.ts"

process.exitCode = await main({ argv: process.argv.slice(2) })
