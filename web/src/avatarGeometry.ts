import type { AvatarCrop } from './tree/model.ts';

/**
 * Где рисовать фото, чтобы в круге диаметром diameter оказался выбранный кусок кадра.
 * Координаты — относительно левого верхнего угла квадрата, описанного вокруг круга.
 */
export function avatarImageBox(crop: AvatarCrop, photo: { width: number; height: number }, diameter: number) {
  const scale = diameter / (crop.zoom * Math.min(photo.width, photo.height));
  const width = photo.width * scale;
  const height = photo.height * scale;
  return { x: diameter / 2 - crop.x * width, y: diameter / 2 - crop.y * height, width, height };
}

/** Ограничивает кадрирование, чтобы круг не выходил за края фото. */
export function clampCrop(crop: AvatarCrop, photo: { width: number; height: number }): AvatarCrop {
  const zoom = Math.min(1, Math.max(0.05, crop.zoom));
  const radius = (zoom * Math.min(photo.width, photo.height)) / 2;
  const clamp = (value: number, side: number) => Math.min(1 - radius / side, Math.max(radius / side, value));
  return { zoom, x: clamp(crop.x, photo.width), y: clamp(crop.y, photo.height) };
}
