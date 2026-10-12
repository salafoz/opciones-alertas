// Preparación única: genera los iconos de la app y el par de claves VAPID para Web Push.
// La clave privada queda en .secrets/ (fuera de git) y se sube como secreto de GitHub Actions.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = ~0; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return ~c >>> 0; };
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4);
  return out;
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) raw.set(pixel(x / size, y / size), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Cuatro barras ascendentes dentro de la zona segura de un icono "maskable".
const bars = [[0.26, 0.6], [0.39, 0.5], [0.52, 0.41], [0.65, 0.29]];
const inBar = (x, y) => bars.some(([bx, top]) => x >= bx && x < bx + 0.09 && y >= top && y < 0.72);
const icon = (x, y) => (inBar(x, y) ? [53, 211, 154, 255] : [11, 18, 32, 255]);
const badge = (x, y) => (inBar(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 0]);

await fs.writeFile(path.join(DOCS, 'icon-192.png'), png(192, icon));
await fs.writeFile(path.join(DOCS, 'icon-512.png'), png(512, icon));
await fs.writeFile(path.join(DOCS, 'badge.png'), png(96, badge));

const secretFile = path.join(ROOT, '.secrets', 'vapid-private.txt');
if (await fs.stat(secretFile).catch(() => null)) {
  console.log('Las claves VAPID ya existen: no se regeneran.');
} else {
  const keys = webpush.generateVAPIDKeys();
  await fs.mkdir(path.dirname(secretFile), { recursive: true });
  await fs.writeFile(secretFile, keys.privateKey);
  await fs.writeFile(path.join(DOCS, 'vapid-public.txt'), keys.publicKey + '\n');
  console.log('Claves VAPID generadas.');
}
console.log('Iconos generados.');
