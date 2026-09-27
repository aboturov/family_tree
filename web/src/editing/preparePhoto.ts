import type { PreparedPhoto } from '../api.ts';

const FULL_SIDE = 2000;
const THUMB_SIDE = 480;

/**
 * Готовит фото к загрузке прямо в браузере: поворачивает по EXIF, уменьшает до двух размеров
 * и перекодирует в JPEG. Метаданные (дата съёмки, координаты) при этом не сохраняются.
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`«${file.name}»: браузер не смог открыть это изображение`);
  }
  try {
    const full = await encode(bitmap, FULL_SIDE, 0.88);
    const thumb = await encode(bitmap, THUMB_SIDE, 0.85);
    return { full: full.blob, thumb: thumb.blob, width: full.width, height: full.height };
  } finally {
    bitmap.close();
  }
}

async function encode(bitmap: ImageBitmap, maxSide: number, quality: number) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  // Прозрачный PNG в JPEG станет чёрным — подкладываем белый фон.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Не удалось подготовить фото');
  return { blob, width, height };
}
