/**
 * ZipBundle — cria e lê arquivos .zip nativamente em Node.js (sem dep externa).
 *
 * Usado pelo sistema de backup pra criar bundles .zip reais em vez de
 * JSON com base64 (que aumenta 33% o tamanho).
 *
 * Formato ZIP suportado:
 *  - Compression: deflate (método 8) ou store (método 0)
 *  - Suporta múltiplos arquivos com paths (ex: "data/memories.json")
 *  - Encoding UTF-8 para filenames
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

// ============================================================================
// ZIP WRITER — cria um .zip a partir de { filename: Buffer }
// ============================================================================

interface ZipEntry {
  filename: string;
  data: Buffer;
}

/**
 * Cria um buffer .zip a partir de um mapa de { filename: content }.
 * content pode ser string ou Buffer.
 * Usa compressão deflate (zlib) pra reduzir tamanho.
 */
export function createZip(files: Record<string, string | Buffer>): Buffer {
  const entries: ZipEntry[] = [];
  for (const [name, content] of Object.entries(files)) {
    entries.push({
      filename: name,
      data: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
    });
  }

  const chunks: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const filenameBuf = Buffer.from(entry.filename, 'utf8');
    // Comprime com deflate (método 8). Se ficar maior que o original, usa store (método 0).
    let compressed: Buffer = Buffer.from(deflateRawSync(entry.data, { level: 6 }));
    let method = 8; // deflate
    if (compressed.length >= entry.data.length) {
      compressed = entry.data;
      method = 0; // store
    }

    const crc = crc32(entry.data);
    const compSize = compressed.length;
    const uncompSize = entry.data.length;

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);    // signature
    localHeader.writeUInt16LE(20, 4);             // version needed
    localHeader.writeUInt16LE(0x0800, 6);         // flags (UTF-8 filename)
    localHeader.writeUInt16LE(method, 8);          // compression method
    localHeader.writeUInt16LE(0, 10);              // mod time
    localHeader.writeUInt16LE(0, 12);              // mod date
    localHeader.writeUInt32LE(crc, 14);           // CRC-32
    localHeader.writeUInt32LE(compSize, 18);       // compressed size
    localHeader.writeUInt32LE(uncompSize, 22);     // uncompressed size
    localHeader.writeUInt16LE(filenameBuf.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28);              // extra field length

    chunks.push(localHeader, filenameBuf, compressed);

    // Central directory header (46 bytes + filename)
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);       // signature
    cdHeader.writeUInt16LE(20, 4);                // version made by
    cdHeader.writeUInt16LE(20, 6);                // version needed
    cdHeader.writeUInt16LE(0x0800, 8);            // flags (UTF-8)
    cdHeader.writeUInt16LE(method, 10);            // compression method
    cdHeader.writeUInt16LE(0, 12);                // mod time
    cdHeader.writeUInt16LE(0, 14);                // mod date
    cdHeader.writeUInt32LE(crc, 16);               // CRC-32
    cdHeader.writeUInt32LE(compSize, 20);          // compressed size
    cdHeader.writeUInt32LE(uncompSize, 24);        // uncompressed size
    cdHeader.writeUInt16LE(filenameBuf.length, 28); // filename length
    cdHeader.writeUInt16LE(0, 30);                 // extra field length
    cdHeader.writeUInt16LE(0, 32);                 // comment length
    cdHeader.writeUInt16LE(0, 34);                 // disk number
    cdHeader.writeUInt16LE(0, 36);                 // internal attrs
    cdHeader.writeUInt32LE(0, 38);                 // external attrs
    cdHeader.writeUInt32LE(offset, 42);             // local header offset

    centralDir.push(cdHeader, filenameBuf);

    offset += localHeader.length + filenameBuf.length + compressed.length;
  }

  // End of central directory record (22 bytes)
  const centralSize = centralDir.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);             // signature
  eocd.writeUInt16LE(0, 4);                       // disk number
  eocd.writeUInt16LE(0, 6);                       // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);           // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);          // total entries
  eocd.writeUInt32LE(centralSize, 12);             // central dir size
  eocd.writeUInt32LE(offset, 16);                  // central dir offset
  eocd.writeUInt16LE(0, 20);                       // comment length

  return Buffer.concat([...chunks, ...centralDir, eocd]);
}

// ============================================================================
// ZIP READER — lê um .zip e retorna { filename: Buffer }
// ============================================================================

/**
 * Lê um buffer .zip e retorna um mapa de { filename: Buffer }.
 * Suporta deflate (método 8) e store (método 0).
 */
export function readZip(zipBuf: Buffer): Record<string, Buffer> {
  const result: Record<string, Buffer> = {};

  // Acha o End of Central Directory record (procura de trás pra frente)
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('ZIP inválido: EOCD não encontrado');

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = zipBuf.readUInt32LE(eocdOffset + 16);

  // Itera pelas entradas do central directory
  let pos = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`ZIP inválido: central dir entry ${i} não tem assinatura correta`);
    }

    const method = zipBuf.readUInt16LE(pos + 10);
    const compSize = zipBuf.readUInt32LE(pos + 20);
    const uncompSize = zipBuf.readUInt32LE(pos + 24);
    const filenameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const commentLen = zipBuf.readUInt16LE(pos + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(pos + 42);

    const filename = zipBuf.toString('utf8', pos + 46, pos + 46 + filenameLen);

    // Vai pro local file header
    if (zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`ZIP inválido: local header não encontrado pra ${filename}`);
    }
    const localFilenameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFilenameLen + localExtraLen;
    const compressedData = zipBuf.subarray(dataStart, dataStart + compSize);

    // Descomprime
    let data: Buffer;
    if (method === 0) {
      data = compressedData; // store
    } else if (method === 8) {
      data = inflateRawSync(compressedData); // deflate
    } else {
      throw new Error(`ZIP: método de compressão ${method} não suportado (${filename})`);
    }

    if (data.length !== uncompSize) {
      throw new Error(`ZIP: tamanho não confere (${filename}): esperado ${uncompSize}, got ${data.length}`);
    }

    // Pula diretórios (terminam com /)
    if (!filename.endsWith('/')) {
      result[filename] = data;
    }

    // Próxima entrada do central dir
    pos += 46 + filenameLen + extraLen + commentLen;
  }

  return result;
}

// ============================================================================
// CRC-32 — implementação nativa (sem dep externa)
// ============================================================================

let crcTable: Uint32Array | null = null;

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[i] = c;
  }
  return table;
}

function crc32(buf: Buffer): number {
  if (!crcTable) crcTable = makeCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
