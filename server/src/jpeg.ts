import { decode, encode } from 'jpeg-js';

// Сканы документов храним как есть, без пересжатия: мелкий почерк после него не прочесть.
// Убираем только метаданные — снимок с телефона хранит в EXIF координаты, то есть адрес. Сервер
// не поворачивает картинки, поэтому файл с поворотом в EXIF браузер присылает уже повёрнутым,
// а импорт такой файл не берёт.

export const isJpeg = (bytes: Uint8Array) =>
  bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** start — первый байт FF, data — начало данных после длины, end — следующий сегмент. */
type Segment = { marker: number; start: number; data: number; end: number };

const SOS = 0xda;
const EOI = 0xd9;
// Маркеры без длины: TEM и RST0–RST7.
const standalone = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
// SOF0–SOF15, кроме DHT (C4), JPG (C8) и DAC (CC).
const isFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** Сегменты заголовка до начала сжатых данных (SOS) включительно. */
function headerSegments(bytes: Uint8Array): Segment[] {
  if (!isJpeg(bytes)) throw new Error('Это не JPEG');
  const segments: Segment[] = [];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('Повреждённый JPEG');
    let markerAt = i + 1;
    while (bytes[markerAt] === 0xff) markerAt++; // байты-заполнители
    const marker = bytes[markerAt];
    if (marker === EOI) break;
    if (standalone(marker)) {
      segments.push({ marker, start: i, data: markerAt + 1, end: markerAt + 1 });
      i = markerAt + 1;
      continue;
    }
    if (markerAt + 2 >= bytes.length) throw new Error('Повреждённый JPEG');
    const end = markerAt + 1 + ((bytes[markerAt + 1] << 8) | bytes[markerAt + 2]);
    if (end > bytes.length) throw new Error('Повреждённый JPEG');
    segments.push({ marker, start: i, data: markerAt + 3, end });
    if (marker === SOS) return segments;
    i = end;
  }
  throw new Error('В JPEG нет изображения');
}

export type JpegInfo = { width: number; height: number; orientation: number };

export function readJpegInfo(bytes: Uint8Array): JpegInfo {
  const segments = headerSegments(bytes);
  const frame = segments.find((s) => isFrame(s.marker));
  if (!frame) throw new Error('В JPEG нет размеров');
  // После длины: точность (1), высота (2), ширина (2).
  const height = (bytes[frame.data + 1] << 8) | bytes[frame.data + 2];
  const width = (bytes[frame.data + 3] << 8) | bytes[frame.data + 4];
  if (!width || !height) throw new Error('В JPEG нет размеров');
  return { width, height, orientation: exifOrientation(bytes, segments) };
}

/** Поворот из EXIF (1 — как есть); без EXIF — 1. */
function exifOrientation(bytes: Uint8Array, segments: Segment[]): number {
  for (const s of segments) {
    if (s.marker !== 0xe1) continue;
    const data = bytes.subarray(s.data, s.end);
    if (String.fromCharCode(...data.subarray(0, 6)) !== 'Exif\0\0') continue;
    const tiff = data.subarray(6);
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    if (tiff.length < 8) return 1;
    const little = tiff[0] === 0x49; // «II» — little-endian, «MM» — big-endian
    const ifd = view.getUint32(4, little);
    if (ifd + 2 > tiff.length) return 1;
    const count = view.getUint16(ifd, little);
    for (let n = 0; n < count; n++) {
      const entry = ifd + 2 + n * 12;
      if (entry + 12 > tiff.length) return 1;
      if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
    }
  }
  return 1;
}

// Оставляем то, что влияет на картинку: JFIF (APP0), цветовой профиль (APP2) и Adobe (APP14 —
// как читать CMYK). EXIF и XMP (APP1), IPTC (APP13), прочие APPn и комментарии — убираем.
const KEEP_APP = new Set([0xe0, 0xe2, 0xee]);
const isMetadata = (marker: number) => (marker >= 0xe0 && marker <= 0xef && !KEEP_APP.has(marker)) || marker === 0xfe;

/** Тот же JPEG без метаданных; сжатые данные не трогаем. */
export function stripMetadata(bytes: Uint8Array): Uint8Array {
  const segments = headerSegments(bytes);
  const kept = segments.filter((s) => !isMetadata(s.marker));
  const sos = segments.at(-1)!;
  const parts = [bytes.subarray(0, 2), ...kept.slice(0, -1).map((s) => bytes.subarray(s.start, s.end)), bytes.subarray(sos.start)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Миниатюра для списка документов — при импорте с сервера, где нет браузера. Чистый JS
 * (jpeg-js): кадр 6000×4000 — несколько секунд, для разового импорта терпимо.
 */
export function makeThumbnail(bytes: Uint8Array, maxSide = 480): Uint8Array {
  const image = decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 200, maxMemoryUsageInMB: 2048 });
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const out = new Uint8Array(width * height * 4);
  // Среднее по прямоугольнику исходных пикселей: при сильном уменьшении текст не рябит.
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * image.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          r += image.data[i];
          g += image.data[i + 1];
          b += image.data[i + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return new Uint8Array(encode({ width, height, data: out }, 82).data);
}
