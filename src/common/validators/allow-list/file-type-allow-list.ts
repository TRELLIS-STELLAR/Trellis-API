/**
 * Strict allow-list for uploaded file types (#279).
 *
 * A file is accepted only when **all three** agree on one allow-listed type:
 *
 *   1. its extension (exactly one meaningful extension, from the table below),
 *   2. its declared MIME type (one of that type's MIME types), and
 *   3. its content (that type's magic-byte signature, or — for text types —
 *      valid UTF-8 without NUL bytes).
 *
 * The previous check trusted the declared MIME type, skipped content checks
 * whenever the signature was unknown, and accepted active-content formats.
 * Deliberately **not** allow-listed:
 *   - `image/svg+xml`, `text/html`, `application/xml` — can carry script or
 *     external entities, so they are an XSS / XXE vector when served back;
 *   - anything executable or without a verifiable signature.
 */

export type AllowListedCategory =
  | "image"
  | "document"
  | "video"
  | "audio"
  | "archive";

interface Signature {
  offset: number;
  bytes: number[];
}

export interface FileTypeEntry {
  id: string;
  category: AllowListedCategory;
  extensions: string[];
  mimeTypes: string[];
  /** Content must match one of these. Absent → text type (UTF-8 check). */
  signatures?: Signature[][];
}

const ascii = (text: string, offset = 0): Signature => ({
  offset,
  bytes: [...text].map((c) => c.charCodeAt(0)),
});
const hex = (offset: number, ...bytes: number[]): Signature => ({
  offset,
  bytes,
});

const ZIP = [
  [hex(0, 0x50, 0x4b, 0x03, 0x04)],
  [hex(0, 0x50, 0x4b, 0x05, 0x06)],
];
const OLE = [[hex(0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)]];
const FTYP = [[ascii("ftyp", 4)]];
const EBML = [[hex(0, 0x1a, 0x45, 0xdf, 0xa3)]];

export const FILE_TYPE_ALLOW_LIST: readonly FileTypeEntry[] = Object.freeze([
  {
    id: "jpeg",
    category: "image",
    extensions: ["jpg", "jpeg"],
    mimeTypes: ["image/jpeg", "image/jpg"],
    signatures: [[hex(0, 0xff, 0xd8, 0xff)]],
  },
  {
    id: "png",
    category: "image",
    extensions: ["png"],
    mimeTypes: ["image/png"],
    signatures: [[hex(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)]],
  },
  {
    id: "gif",
    category: "image",
    extensions: ["gif"],
    mimeTypes: ["image/gif"],
    signatures: [[ascii("GIF87a")], [ascii("GIF89a")]],
  },
  {
    id: "webp",
    category: "image",
    extensions: ["webp"],
    mimeTypes: ["image/webp"],
    signatures: [[ascii("RIFF"), ascii("WEBP", 8)]],
  },
  {
    id: "tiff",
    category: "image",
    extensions: ["tif", "tiff"],
    mimeTypes: ["image/tiff"],
    signatures: [
      [hex(0, 0x49, 0x49, 0x2a, 0x00)],
      [hex(0, 0x4d, 0x4d, 0x00, 0x2a)],
    ],
  },
  {
    id: "bmp",
    category: "image",
    extensions: ["bmp"],
    mimeTypes: ["image/bmp"],
    signatures: [[ascii("BM")]],
  },
  {
    id: "avif",
    category: "image",
    extensions: ["avif"],
    mimeTypes: ["image/avif"],
    signatures: [[ascii("ftypavif", 4)], [ascii("ftypavis", 4)]],
  },

  {
    id: "pdf",
    category: "document",
    extensions: ["pdf"],
    mimeTypes: ["application/pdf"],
    signatures: [[ascii("%PDF-")]],
  },
  {
    id: "docx",
    category: "document",
    extensions: ["docx"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    signatures: ZIP,
  },
  {
    id: "xlsx",
    category: "document",
    extensions: ["xlsx"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    signatures: ZIP,
  },
  {
    id: "pptx",
    category: "document",
    extensions: ["pptx"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    signatures: ZIP,
  },
  {
    id: "doc",
    category: "document",
    extensions: ["doc"],
    mimeTypes: ["application/msword"],
    signatures: OLE,
  },
  {
    id: "xls",
    category: "document",
    extensions: ["xls"],
    mimeTypes: ["application/vnd.ms-excel"],
    signatures: OLE,
  },
  {
    id: "ppt",
    category: "document",
    extensions: ["ppt"],
    mimeTypes: ["application/vnd.ms-powerpoint"],
    signatures: OLE,
  },
  {
    id: "text",
    category: "document",
    extensions: ["txt"],
    mimeTypes: ["text/plain"],
  },
  {
    id: "csv",
    category: "document",
    extensions: ["csv"],
    mimeTypes: ["text/csv", "text/plain", "application/vnd.ms-excel"],
  },
  {
    id: "json",
    category: "document",
    extensions: ["json"],
    mimeTypes: ["application/json", "text/plain"],
  },

  {
    id: "mp4",
    category: "video",
    extensions: ["mp4", "m4v"],
    mimeTypes: ["video/mp4"],
    signatures: FTYP,
  },
  {
    id: "mov",
    category: "video",
    extensions: ["mov"],
    mimeTypes: ["video/quicktime"],
    signatures: FTYP,
  },
  {
    id: "webm",
    category: "video",
    extensions: ["webm"],
    mimeTypes: ["video/webm", "audio/webm"],
    signatures: EBML,
  },
  {
    id: "mkv",
    category: "video",
    extensions: ["mkv"],
    mimeTypes: ["video/x-matroska"],
    signatures: EBML,
  },
  {
    id: "avi",
    category: "video",
    extensions: ["avi"],
    mimeTypes: ["video/x-msvideo"],
    signatures: [[ascii("RIFF"), ascii("AVI ", 8)]],
  },
  {
    id: "ogg",
    category: "audio",
    extensions: ["ogg", "oga", "ogv"],
    mimeTypes: ["audio/ogg", "video/ogg"],
    signatures: [[ascii("OggS")]],
  },

  {
    id: "mp3",
    category: "audio",
    extensions: ["mp3"],
    mimeTypes: ["audio/mpeg"],
    signatures: [
      [ascii("ID3")],
      [hex(0, 0xff, 0xfb)],
      [hex(0, 0xff, 0xf3)],
      [hex(0, 0xff, 0xf2)],
    ],
  },
  {
    id: "wav",
    category: "audio",
    extensions: ["wav"],
    mimeTypes: ["audio/wav", "audio/x-wav"],
    signatures: [[ascii("RIFF"), ascii("WAVE", 8)]],
  },
  {
    id: "flac",
    category: "audio",
    extensions: ["flac"],
    mimeTypes: ["audio/flac"],
    signatures: [[ascii("fLaC")]],
  },
  {
    id: "aac",
    category: "audio",
    extensions: ["aac"],
    mimeTypes: ["audio/aac"],
    signatures: [[hex(0, 0xff, 0xf1)], [hex(0, 0xff, 0xf9)]],
  },
  {
    id: "m4a",
    category: "audio",
    extensions: ["m4a"],
    mimeTypes: ["audio/mp4"],
    signatures: FTYP,
  },

  {
    id: "zip",
    category: "archive",
    extensions: ["zip"],
    mimeTypes: ["application/zip"],
    signatures: ZIP,
  },
  {
    id: "gzip",
    category: "archive",
    extensions: ["gz", "tgz"],
    mimeTypes: ["application/gzip"],
    signatures: [[hex(0, 0x1f, 0x8b)]],
  },
  {
    id: "tar",
    category: "archive",
    extensions: ["tar"],
    mimeTypes: ["application/x-tar"],
    signatures: [[ascii("ustar", 257)]],
  },
  {
    id: "7z",
    category: "archive",
    extensions: ["7z"],
    mimeTypes: ["application/x-7z-compressed"],
    signatures: [[hex(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)]],
  },
  {
    id: "rar",
    category: "archive",
    extensions: ["rar"],
    mimeTypes: ["application/x-rar-compressed"],
    signatures: [[ascii("Rar!")]],
  },
  {
    id: "bzip2",
    category: "archive",
    extensions: ["bz2"],
    mimeTypes: ["application/x-bzip2"],
    signatures: [[ascii("BZh")]],
  },
]);

export interface FileTypeCheckInput {
  originalname: string;
  mimetype: string;
  buffer?: Buffer;
}

export interface FileTypeCheckResult {
  allowed: boolean;
  /** The allow-list entry that matched every rule. */
  entry?: FileTypeEntry;
  errors: string[];
}

/** Extensions that must never appear anywhere in a filename (`report.exe.pdf`). */
const EXECUTABLE_EXTENSIONS = new Set([
  "exe",
  "dll",
  "bat",
  "cmd",
  "com",
  "msi",
  "scr",
  "pif",
  "vbs",
  "vbe",
  "js",
  "jse",
  "mjs",
  "ws",
  "wsf",
  "wsh",
  "ps1",
  "psm1",
  "sh",
  "bash",
  "reg",
  "inf",
  "sct",
  "hta",
  "cpl",
  "jar",
  "apk",
  "app",
  "html",
  "htm",
  "xhtml",
  "svg",
  "php",
  "phtml",
  "asp",
  "aspx",
  "jsp",
  "py",
  "rb",
]);

function matchesSignature(buffer: Buffer, signature: Signature[]): boolean {
  return signature.every(({ offset, bytes }) => {
    if (buffer.length < offset + bytes.length) return false;
    return bytes.every((byte, i) => buffer[offset + i] === byte);
  });
}

function isPlainText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  // Round-tripping detects invalid UTF-8 (replacement characters appear).
  const text = buffer.toString("utf8");
  return (
    !text.includes("�") && Buffer.byteLength(text, "utf8") === buffer.length
  );
}

/** Checks a file against {@link FILE_TYPE_ALLOW_LIST}. Pure; never throws. */
export function checkFileTypeAllowList(
  file: FileTypeCheckInput,
  options: { categories?: AllowListedCategory[] } = {},
): FileTypeCheckResult {
  const errors: string[] = [];
  const name = (file.originalname ?? "").trim();
  const parts = name.toLowerCase().split(".");
  const extension = parts.length > 1 ? parts[parts.length - 1] : "";
  const mime = (file.mimetype ?? "").toLowerCase().split(";")[0].trim();

  if (!extension) {
    return {
      allowed: false,
      errors: ["File must have an allow-listed extension"],
    };
  }
  if (/[\u0000-\u001f\\/]/.test(name)) {
    errors.push("File name contains control or path characters");
  }
  const hidden = parts
    .slice(1, -1)
    .find((part) => EXECUTABLE_EXTENSIONS.has(part));
  if (hidden) {
    errors.push(`File name hides an executable extension (.${hidden})`);
  }

  const candidates = FILE_TYPE_ALLOW_LIST.filter((entry) =>
    entry.extensions.includes(extension),
  );
  if (candidates.length === 0) {
    errors.push(`File extension .${extension} is not allow-listed`);
    return { allowed: false, errors };
  }

  const byMime = candidates.filter((entry) => entry.mimeTypes.includes(mime));
  if (byMime.length === 0) {
    errors.push(
      `Declared type ${mime || "(none)"} does not match the .${extension} extension`,
    );
    return { allowed: false, errors };
  }

  const byCategory = options.categories?.length
    ? byMime.filter((entry) => options.categories!.includes(entry.category))
    : byMime;
  if (byCategory.length === 0) {
    errors.push(
      `File category is not allowed here. Allowed: ${options.categories!.join(", ")}`,
    );
    return { allowed: false, errors };
  }

  if (!file.buffer || file.buffer.length === 0) {
    errors.push("File content is required to verify its type");
    return { allowed: false, errors };
  }

  const entry = byCategory.find((candidate) =>
    candidate.signatures
      ? candidate.signatures.some((signature) =>
          matchesSignature(file.buffer!, signature),
        )
      : isPlainText(file.buffer!),
  );
  if (!entry) {
    errors.push(`File content does not match the declared ${mime} type`);
    return { allowed: false, errors };
  }

  return errors.length > 0
    ? { allowed: false, entry, errors }
    : { allowed: true, entry, errors };
}

export type FileTypeAllowListMode = "enforce" | "report" | "off";

/**
 * `FILE_TYPE_ALLOWLIST_MODE`:
 * - `enforce` (default) — reject files that fail the strict allow-list;
 * - `report` — accept them but log the violation (migration / observation);
 * - `off` — legacy behaviour only (emergency rollback).
 */
export function fileTypeAllowListMode(value: unknown): FileTypeAllowListMode {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "report" || normalized === "off"
    ? normalized
    : "enforce";
}
