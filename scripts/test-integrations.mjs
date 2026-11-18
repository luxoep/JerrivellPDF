// SPDX-License-Identifier: MIT OR Apache-2.0
import { integrationChecks } from './release-checks.mjs';
await integrationChecks(process.argv[2], process.argv[3]);
