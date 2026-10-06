/** Google WOFF2 decoder (wawoff2, MIT), isolated from the server's event loop. */
import decompress from 'wawoff2/decompress.js';

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 1536 * 1024) throw new Error('The WOFF2 input is too large.');
  chunks.push(chunk);
}
const bytes = await decompress(Buffer.concat(chunks));
if (bytes.length > 8 * 1024 * 1024) throw new Error('The WOFF2 output is too large.');
process.stdout.write(bytes);
