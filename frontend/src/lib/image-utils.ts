/** Image upload and compression utilities (WebP pipeline, size validation, fallback colors). */

const MAX_BASE64_LENGTH = 50_000;

type CropArea = { x: number; y: number; width: number; height: number };

const CROP_ENCODING_ATTEMPTS = [
  { size: 400, quality: 0.8 },
  { size: 400, quality: 0.6 },
  { size: 400, quality: 0.4 },
  { size: 320, quality: 0.6 },
  { size: 320, quality: 0.4 },
];

/** Encode a selected product-image crop within the database size limit. */
export function compressCroppedImage(image: HTMLImageElement, crop: CropArea): string | null {
  try {
    for (const { size, quality } of CROP_ENCODING_ATTEMPTS) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      // The crop may reach past the picture when zoomed out; that part stays white.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      const scaleX = size / crop.width;
      const scaleY = size / crop.height;
      const sx = Math.max(0, crop.x);
      const sy = Math.max(0, crop.y);
      const sw = Math.min(image.naturalWidth || image.width, crop.x + crop.width) - sx;
      const sh = Math.min(image.naturalHeight || image.height, crop.y + crop.height) - sy;
      if (sw > 0 && sh > 0) {
        ctx.drawImage(
          image,
          sx,
          sy,
          sw,
          sh,
          (sx - crop.x) * scaleX,
          (sy - crop.y) * scaleY,
          sw * scaleX,
          sh * scaleY,
        );
      }
      const dataUri = canvas.toDataURL('image/webp', quality);
      if (dataUri !== 'data:,' && dataUri.length <= MAX_BASE64_LENGTH) return dataUri;
    }
  } catch {
    return null;
  }

  return null;
}

/** Compresses an image file to a 1:1 WebP data URI within size limits. */
export function compressImage(file: File, quality = 0.8): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      // Determine crop dimensions (center-crop to 1:1)
      const size = Math.min(img.width, img.height);
      const offsetX = (img.width - size) / 2;
      const offsetY = (img.height - size) / 2;

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(null);
        return;
      }

      ctx.drawImage(img, offsetX, offsetY, size, size, 0, 0, size, size);

      // Try compression with retry at lower quality
      const qualities = [Math.min(1, Math.max(0, quality)), 0.6, 0.4];
      try {
        for (const q of qualities) {
          const dataUri = canvas.toDataURL('image/webp', q);
          if (dataUri.length <= MAX_BASE64_LENGTH) {
            resolve(dataUri);
            return;
          }
        }

        // All qualities too large — try PNG as fallback (smaller than original)
        const pngUri = canvas.toDataURL('image/png');
        if (pngUri.length <= MAX_BASE64_LENGTH) {
          resolve(pngUri);
          return;
        }
      } catch {
        resolve(null);
        return;
      }

      resolve(null); // Image too complex for the size limit
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };

    img.src = url;
  });
}

/** Generates deterministic HSL color from product name for fallback tiles. */
export function nameToColor(name: string): string {
  let hash = 0;
  for (const character of name) {
    const codePoint = character.codePointAt(0) ?? 0;
    hash = codePoint + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 45%, 65%)`;
}

/** Checks whether Base64 data URI is within character size limit (50K chars). */
export function validateImageSize(dataUri: string): boolean {
  return typeof dataUri === 'string' && dataUri.length <= MAX_BASE64_LENGTH;
}

/** Max Base64 string length (characters). ~36.6 KB decoded. */
export const MAX_IMAGE_LENGTH = MAX_BASE64_LENGTH;

/** Max raw file size before loading into memory (5 MB). */
export const MAX_RAW_FILE_SIZE = 5 * 1024 * 1024;

/** Scales an image file to fit `maxSide` (keeping its shape) and encodes WebP within `maxLength`. */
export function fitImage(file: File, maxSide: number, maxLength: number): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        for (const quality of [0.85, 0.7, 0.55, 0.4]) {
          const dataUri = canvas.toDataURL('image/webp', quality);
          if (dataUri !== 'data:,' && dataUri.length <= maxLength) return resolve(dataUri);
        }
      } catch {}
      resolve(null);
    };
    img.onerror = () => resolve(null);
    // The app CSP allows data: images but not blob: URLs.
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') img.src = reader.result;
      else resolve(null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
