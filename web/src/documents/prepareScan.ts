import type { PreparedScan } from '../api.ts';

// Скан к загрузке. JPEG без поворота в EXIF уходит как есть, без пересжатия: мелкий почерк его
// не переживает, а метаданные уберёт сервер. Повёрнутый через EXIF JPEG (снимок с телефона),
// PNG и прочее браузер перерисовывает в JPEG высокого качества в исходном размере — сервер
// картинки не поворачивает. Миниатюра для списка — 480 px.

const THUMB_SIDE = 480;
const MAX_BYTES = 24 * 1024 * 1024; // как на сервере (server/src/documents.ts)

export async function prepareScan(file: File): Promise<PreparedScan> {
  const head = new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer());
  const asIs = isJpeg(head) && safeOrientation(head) === 1;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`«${file.name}»: браузер не смог открыть это изображение`);
  }
  try {
    const original = asIs ? file : await encode(bitmap, Infinity, 0.92);
    if (original.size > MAX_BYTES) throw new Error(`«${file.name}»: скан больше 24 МБ`);
    return { file: original, thumb: await encode(bitmap, THUMB_SIDE, 0.82) };
  } finally {
    bitmap.close();
  }
}

async function encode(bitmap: ImageBitmap, maxSide: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d')!;
  // Прозрачный PNG в JPEG станет чёрным — подкладываем белый фон.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Не удалось подготовить скан');
  return blob;
}

const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// Не разобрали EXIF — считаем, что поворот есть: перерисованный скан хотя бы не ляжет боком.
const safeOrientation = (b: Uint8Array) => {
  try {
    return exifOrientation(b);
  } catch {
    return 0;
  }
};

/** Поворот из EXIF (1 — как есть). Смотрим только начало файла: EXIF всегда в заголовке. */
function exifOrientation(b: Uint8Array): number {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    const length = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xda) break; // дальше — сами данные картинки
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(i + 4, i + 10)) === 'Exif\0\0') {
      const tiff = i + 10;
      const view = new DataView(b.buffer, b.byteOffset);
      const little = b[tiff] === 0x49;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      const count = view.getUint16(ifd, little);
      for (let n = 0; n < count; n++) {
        const entry = ifd + 2 + n * 12;
        if (entry + 12 > b.length) break;
        if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
      }
      return 1;
    }
    i += 2 + length;
  }
  return 1;
}
