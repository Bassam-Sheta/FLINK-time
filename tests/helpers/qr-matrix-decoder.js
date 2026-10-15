'use strict';

// Independent clean-matrix test decoder, not shipped to the portals. It reads
// format bits, unmasks, deinterleaves and checks every Reed-Solomon syndrome.
// No calls to the encoder. Model 2/M tables: Thonky QR error-correction table
// and alignment-pattern-locations, versions 1-26 (sufficient for 1024 ASCII bytes).
const assert = require('node:assert/strict');
const alignment = [[], [], [6,18], [6,22], [6,26], [6,30], [6,34], [6,22,38], [6,24,42], [6,26,46], [6,28,50], [6,30,54], [6,32,58], [6,34,62], [6,26,46,66], [6,26,48,70], [6,26,50,74], [6,30,54,78], [6,30,56,82], [6,30,58,86], [6,34,62,90], [6,28,50,72,94], [6,26,50,74,98], [6,30,54,78,102], [6,28,54,80,106], [6,32,58,84,110], [6,30,58,86,114]];
const blocksM = [0,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23];
const eccM = [0,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28];
const masks = [
  (x,y) => (x+y)%2 === 0, (_x,y) => y%2 === 0, x => x%3 === 0,
  (x,y) => (x+y)%3 === 0, (x,y) => (Math.floor(y/2)+Math.floor(x/3))%2 === 0,
  (x,y) => (x*y)%2+(x*y)%3 === 0, (x,y) => ((x*y)%2+(x*y)%3)%2 === 0,
  (x,y) => ((x+y)%2+(x*y)%3)%2 === 0
];

function multiply(a, b) {
  let result = 0;
  while (b) {
    if (b & 1) result ^= a;
    a <<= 1;
    if (a & 256) a ^= 0x11d;
    b >>>= 1;
  }
  return result;
}

function decodeMatrix(matrix) {
  const size = matrix.length;
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 26);
  assert.ok(matrix.every(row => row.length === size));
  const at = (x,y) => Number(Boolean(matrix[y][x]));
  const formatLocations = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  const word = formatLocations.reduce((word,[x,y],i) => word | at(x,y) << i, 0) ^ 0x5412;
  const format = word >>> 10;
  let remainder = word;
  for (let bit = 14; bit >= 10; bit--) if (remainder & 1 << bit) remainder ^= 0x537 << (bit - 10);
  assert.equal(remainder, 0, 'format BCH');
  assert.equal(format >>> 3, 0, 'medium error correction');
  const mask = masks[format & 7];
  const reserved = Array.from({length: size}, () => Array(size).fill(false));
  const reserve = (x,y,w,h) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) reserved[y+dy][x+dx] = true;
  };
  reserve(0,0,9,9); reserve(size-8,0,8,9); reserve(0,size-8,9,8);
  reserve(6,0,1,size); reserve(0,6,size,1);
  for (const y of alignment[version]) for (const x of alignment[version]) {
    if ((x === 6 && (y === 6 || y === size-7)) || (y === 6 && x === size-7)) continue;
    reserve(x-2,y-2,5,5);
  }
  if (version >= 7) { reserve(size-11,0,3,6); reserve(0,size-11,6,3); }
  const bits = [];
  let up = true;
  for (let right = size-1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let offset = 0; offset < size; offset++) {
      const y = up ? size-1-offset : offset;
      for (const x of [right,right-1]) if (!reserved[y][x]) bits.push(at(x,y) ^ Number(mask(x,y)));
    }
    up = !up;
  }
  const words = [];
  for (let offset = 0; offset+8 <= bits.length; offset += 8) words.push(bits.slice(offset,offset+8).reduce((v,b) => v*2+b,0));
  const count = blocksM[version], ecc = eccM[version];
  const short = count - words.length % count;
  const lengths = Array.from({length: count}, (_,i) => Math.floor(words.length/count)-ecc+Number(i >= short));
  const blocks = Array.from({length: count}, () => []);
  let cursor = 0;
  for (let col = 0; col < Math.max(...lengths); col++) {
    for (let i = 0; i < count; i++) if (col < lengths[i]) blocks[i].push(words[cursor++]);
  }
  for (let col = 0; col < ecc; col++) for (const block of blocks) block.push(words[cursor++]);
  assert.equal(cursor, words.length);
  for (const block of blocks) {
    let root = 1;
    for (let exponent = 0; exponent < ecc; exponent++) {
      assert.equal(block.reduce((s,b) => multiply(s,root) ^ b, 0), 0, 'Reed-Solomon syndrome');
      root = multiply(root,2);
    }
  }
  const dataBits = blocks.flatMap((block,i) => block.slice(0,lengths[i])).flatMap(byte => Array.from({length: 8}, (_,i) => byte >>> (7-i) & 1));
  let position = 0;
  const take = n => { const result = dataBits.slice(position,position+n).reduce((v,b) => v*2+b,0); position += n; return result; };
  assert.equal(take(4), 4, 'byte mode');
  const length = take(version < 10 ? 8 : 16);
  assert.ok(position + length*8 <= dataBits.length);
  return Buffer.from(Array.from({length}, () => take(8))).toString('utf8');
}

module.exports = { decodeMatrix };
