// SPDX-License-Identifier: GPL-3.0-or-later
import { integrationChecks } from './release-checks.mjs';
await integrationChecks(process.argv[2], process.argv[3]);
