// Минимальный ZIP без сжатия (метод «stored») — без сторонних библиотек.
// Файл резервной копии — обычный ZIP: его можно открыть и на компьютере.
// Данные собираются в Blob по частям, поэтому большие фото не копируются в
// одну строку в памяти телефона.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}

const enc = new TextEncoder();
const MAX_ZIP_SIZE = 0xFFFFFFFF; // без ZIP64

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const day = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

function header(size) {
  const buf = new ArrayBuffer(size);
  return { buf, view: new DataView(buf) };
}

async function bytesOf(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return enc.encode(data);
  return new Uint8Array(await data.arrayBuffer());
}

// Контрольная сумма Blob по частям — большое видео не читается в память целиком.
export async function crc32Blob(blob, chunk = 4 * 1024 * 1024) {
  let crc = 0;
  for (let offset = 0; offset < blob.size; offset += chunk) {
    crc = crc32(new Uint8Array(await blob.slice(offset, offset + chunk).arrayBuffer()), crc);
  }
  return crc;
}

// entries: [{ name, data: string | Uint8Array | Blob, crc?, date? }]
// Для Blob содержимое не копируется: CRC считается по частям, а сам Blob
// вставляется в архив как есть. Возвращает Blob типа application/zip.
export async function createZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const isBlob = entry.data instanceof Blob;
    const bytes = isBlob ? null : await bytesOf(entry.data);
    const length = isBlob ? entry.data.size : bytes.length;
    const crc = isBlob ? (entry.crc ?? await crc32Blob(entry.data)) : crc32(bytes);
    const { time, day } = dosDateTime(entry.date);
    const { buf, view } = header(30);
    view.setUint32(0, 0x04034B50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true); // имена в UTF-8
    view.setUint16(8, 0, true); // без сжатия
    view.setUint16(10, time, true);
    view.setUint16(12, day, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, length, true);
    view.setUint32(22, length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    parts.push(buf, name, isBlob ? entry.data : bytes);

    const c = header(46);
    c.view.setUint32(0, 0x02014B50, true);
    c.view.setUint16(4, 20, true);
    c.view.setUint16(6, 20, true);
    c.view.setUint16(8, 0x0800, true);
    c.view.setUint16(10, 0, true);
    c.view.setUint16(12, time, true);
    c.view.setUint16(14, day, true);
    c.view.setUint32(16, crc, true);
    c.view.setUint32(20, length, true);
    c.view.setUint32(24, length, true);
    c.view.setUint16(28, name.length, true);
    c.view.setUint32(42, offset, true);
    central.push(c.buf, name);

    offset += 30 + name.length + length;
    if (offset > MAX_ZIP_SIZE) throw new Error('Резервная копия больше 4 ГБ — такой объём не поддерживается.');
  }
  const centralSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
  const end = header(22);
  end.view.setUint32(0, 0x06054B50, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buf], { type: 'application/zip' });
}

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

// Читает оглавление ZIP. Возвращает Map имя → { size, crc, read() },
// где read() отдаёт Blob содержимого. Поддерживается только метод «stored».
export async function readZip(blob) {
  if (!blob || typeof blob.slice !== 'function' || blob.size < 22) throw new ZipError('Файл не является резервной копией JARVIS (слишком мал).');
  const tailSize = Math.min(blob.size, 22 + 0xFFFF);
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('Файл не является резервной копией JARVIS (это не ZIP-архив).');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset + cdSize > blob.size) throw new ZipError('Архив повреждён: оглавление выходит за пределы файла.');
  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014B50) throw new ZipError('Архив повреждён: неверное оглавление.');
    const method = cd.getUint16(p + 10, true);
    const crc = cd.getUint32(p + 16, true);
    const csize = cd.getUint32(p + 20, true);
    const size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const local = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (method !== 0 || csize !== size) throw new ZipError('Архив сжат или изменён другой программой. Используйте файл, сохранённый JARVIS, без пересжатия.');
    entries.set(name, {
      size,
      crc,
      async read() {
        const h = new DataView(await blob.slice(local, local + 30).arrayBuffer());
        if (h.getUint32(0, true) !== 0x04034B50) throw new ZipError(`Архив повреждён: файл «${name}».`);
        const start = local + 30 + h.getUint16(26, true) + h.getUint16(28, true);
        if (start + size > blob.size) throw new ZipError(`Архив обрезан: файл «${name}».`);
        return blob.slice(start, start + size);
      },
    });
  }
  return entries;
}
