// One-shot helper: lift line ranges out of server.js into a module file.
// Verbatim extraction — the moved text is not reformatted, so the route-inventory diff
// stays a meaningful check. Ranges are 1-based and inclusive.
//
//   node tools/_extract.js <outFile> <header.txt> <start>-<end> [<start>-<end> ...]
//
// Prints the extracted body to the module, replaces it in server.js with a marker comment,
// and leaves an explicit register(app, ctx) wiring line for a human to place.

const fs = require('fs');
const path = require('path');

const [, , outFile, headerFile, ...ranges] = process.argv;
const SERVER = path.join(__dirname, '..', 'server.js');
let s = fs.readFileSync(SERVER, 'utf8');
const nl = s.includes('\r\n') ? '\r\n' : '\n';
const lines = s.split(nl);

const parsed = ranges.map(r => r.split('-').map(Number)).sort((a, b) => a[0] - b[0]);
for (const [a, b] of parsed) if (!(a >= 1 && b <= lines.length && a <= b)) {
  console.error(`  !! bad range ${a}-${b} (file has ${lines.length} lines)`); process.exit(1);
}

const chunks = parsed.map(([a, b]) => lines.slice(a - 1, b).join(nl));
const header = fs.readFileSync(path.join(__dirname, headerFile), 'utf8').split('\n').join(nl);

const body = header + nl + chunks.join(nl + nl) + nl;
fs.mkdirSync(path.dirname(path.join(__dirname, '..', outFile)), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', outFile), body);

// Remove from server.js, highest range first so earlier indices stay valid.
let removed = 0;
for (const [a, b] of [...parsed].reverse()) { lines.splice(a - 1, b - a + 1); removed += b - a + 1; }
fs.writeFileSync(SERVER, lines.join(nl));

console.log(`  ${outFile}: ${chunks.length} chunk(s), ${removed} lines lifted out of server.js`);
