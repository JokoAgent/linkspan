import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const directory = dirname(require.resolve('http-parser-js/package.json'));
const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
assert.equal(manifest.version, '0.5.10');
const source = await readFile(join(directory, 'http-parser.js'));
const license = await readFile(join(directory, 'LICENSE.md'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(source), '172740bb3cb7babf77721f2903df3c8166c4a745326f1ed4ab578d2564a74638');
assert.equal(sha256(license), '78cd8b5ed8c97bfca3d7ba48cbba846df42bfcf96ebe137cd6122100236fb6e1');
assert.ok(!/\b(?:require|process|Buffer)\b/u.test(source.toString('utf8')), 'The private parser must remain portable.');
const output = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
await writeFile(join(output, 'connect-parser.js'), `// Fixed http-parser-js 0.5.10, unmodified source inside a private ESM scope.\nconst parserExports = {};\n(function(exports) {\n${source.toString('utf8')}\n})(parserExports);\nexport const HTTPParser = parserExports.HTTPParser;\n`);
await writeFile(join(output, 'CONNECT_PARSER_LICENSE.txt'), license);
await writeFile(join(output, 'connect-parser-input.json'), JSON.stringify({ name: manifest.name, version: manifest.version,
  source: 'https://github.com/creationix/http-parser-js', sourceSha256: sha256(source), licenseSha256: sha256(license),
  wrapper: 'unmodified upstream source in a private ESM scope; no runtime package dependency' }, null, 2) + '\n');
