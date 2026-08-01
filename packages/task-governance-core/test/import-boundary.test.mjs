import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const forbidden = [
  '@narada-core/task-governance',
  '@narada-core/task-lifecycle-mcp',
  '@narada-core/mcp-transport',
  '@narada-core/control-plane',
  '@narada-core/intent-zones',
];

const files = [
  ...JSON.parse(readFileSync(join(packageRoot, '.import-boundary-files.json'), 'utf8')),
];

for (const relativePath of files) {
  const text = readFileSync(join(packageRoot, relativePath), 'utf8');
  for (const specifier of forbidden) {
    assert.equal(text.includes(specifier), false, `${relativePath} imports forbidden package ${specifier}`);
  }
}

console.log('task-governance-core import boundary ok');
