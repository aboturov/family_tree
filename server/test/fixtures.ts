import { encode } from 'jpeg-js';

// Маленькие JPEG для тестов сканов: настоящие (их можно разобрать и уменьшить), с EXIF по желанию.

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** EXIF с поворотом и строкой-«координатами», чтобы проверить, что метаданные вычищены. */
export function exif(orientation: number, secret = 'GPS 57.0412 N'): Uint8Array {
  const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
  return concat(new TextEncoder().encode('Exif\0\0'), new Uint8Array(tiff), new TextEncoder().encode(secret));
}

/** JPEG заданного размера; seed меняет картинку — и хеш файла. */
export function jpeg(width = 40, height = 30, { exif: app1, seed = 0 }: { exif?: Uint8Array; seed?: number } = {}) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i / 4 + seed * 37) % 256;
    data[i + 1] = 120;
    data[i + 2] = 200;
    data[i + 3] = 255;
  }
  const bytes = new Uint8Array(encode({ width, height, data }, 90).data);
  if (!app1) return bytes;
  const length = app1.length + 2;
  const segment = concat(new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff]), app1);
  return concat(bytes.subarray(0, 2), segment, bytes.subarray(2));
}

export const contains = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text));
