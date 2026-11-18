// SPDX-License-Identifier: MIT OR Apache-2.0
// Original, non-confidential drawings for native desktop acceptance only.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {drawing} from './compare-fixtures.mjs';
const output=path.resolve(process.argv[2]??'test-results/0.10.0/desktop-fixtures');
await mkdir(output,{recursive:true});
await writeFile(path.join(output,'Drawing A.pdf'),drawing());
await writeFile(path.join(output,'Drawing B.pdf'),drawing({changed:true}));
console.log(output);
