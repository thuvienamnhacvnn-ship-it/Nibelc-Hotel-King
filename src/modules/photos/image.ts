/**
 * Nhận dạng ảnh từ byte đầu file và đọc kích thước từ header — không giải mã ảnh, không thư viện native
 * (Smart App Control trên máy dev chặn sharp). Đuôi file và Content-Type do máy khách gửi KHÔNG được tin.
 */

export type ImageKind = "jpeg" | "png" | "webp" | "heic";

export const IMAGE_MIME: Record<ImageKind, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
};

export const IMAGE_EXT: Record<ImageKind, string> = { jpeg: "jpg", png: "png", webp: "webp", heic: "heic" };

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp" && HEIF_BRANDS.has(buf.toString("latin1", 8, 12))) return "heic";
  return null;
}

export interface Dimensions {
  width: number;
  height: number;
}

export function readDimensions(kind: ImageKind, buf: Buffer): Dimensions | null {
  try {
    switch (kind) {
      case "png":
        return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
      case "jpeg":
        return jpegSize(buf);
      case "webp":
        return webpSize(buf);
      case "heic":
        return heicSize(buf);
    }
  } catch {
    return null;
  }
}

/** Duyệt các segment tới marker SOFn. Ảnh có EXIF xoay 90° vẫn báo kích thước gốc — cạnh ngắn không đổi. */
function jpegSize(buf: Buffer): Dimensions | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (marker === 0xda || marker === 0xd9) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(buf: Buffer): Dimensions | null {
  const chunk = buf.toString("latin1", 12, 16);
  if (chunk === "VP8 " && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L" && buf.length >= 25) {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && buf.length >= 30) return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  return null;
}

/** HEIF: tìm hộp `ispe` (image spatial extents) trong meta → iprp → ipco. Lấy cái lớn nhất (bỏ qua ảnh thu nhỏ). */
function heicSize(buf: Buffer): Dimensions | null {
  let best: Dimensions | null = null;
  const limit = Math.min(buf.length, 1 << 20);
  for (let i = 4; i + 16 <= limit; i++) {
    if (buf[i] === 0x69 && buf.toString("latin1", i, i + 4) === "ispe") {
      const width = buf.readUInt32BE(i + 8);
      const height = buf.readUInt32BE(i + 12);
      if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) best = { width, height };
    }
  }
  return best;
}
