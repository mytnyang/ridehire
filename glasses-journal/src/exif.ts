// Minimal EXIF reader for JPEG files: capture time, GPS position and camera.
// Only the first ~256 KB of the file is needed; EXIF lives in the APP1 segment
// right after the start-of-image marker.

export interface ExifInfo {
  /** "YYYY-MM-DDTHH:MM:SS", camera clock, no zone. */
  dateTimeOriginal?: string;
  /** "+HH:MM" / "-HH:MM" if the camera recorded it. */
  offsetTimeOriginal?: string;
  latitude?: number;
  longitude?: number;
  make?: string;
  model?: string;
}

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME = 0x0132;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const GPS_LAT_REF = 1;
const GPS_LAT = 2;
const GPS_LON_REF = 3;
const GPS_LON = 4;

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

type IfdValue = string | number[];

export function parseJpegExif(bytes: Uint8Array): ExifInfo | null {
  const tiff = findExifTiff(bytes);
  if (!tiff) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = String.fromCharCode(tiff[0], tiff[1]);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  if (view.getUint16(2, le) !== 42) return null;

  const ifd0 = readIfd(view, view.getUint32(4, le), le);
  const info: ExifInfo = {};
  const make = ifd0.get(TAG_MAKE);
  const model = ifd0.get(TAG_MODEL);
  if (typeof make === "string" && make) info.make = make;
  if (typeof model === "string" && model) info.model = model;

  const exifPtr = ifd0.get(TAG_EXIF_IFD);
  const exif = Array.isArray(exifPtr) ? readIfd(view, exifPtr[0], le) : new Map<number, IfdValue>();
  const dto = exif.get(TAG_DATETIME_ORIGINAL) ?? ifd0.get(TAG_DATETIME);
  if (typeof dto === "string") {
    const iso = exifDateToIso(dto);
    if (iso) info.dateTimeOriginal = iso;
  }
  const offset = exif.get(TAG_OFFSET_TIME_ORIGINAL);
  if (typeof offset === "string" && /^[+-]\d\d:\d\d$/.test(offset)) info.offsetTimeOriginal = offset;

  const gpsPtr = ifd0.get(TAG_GPS_IFD);
  if (Array.isArray(gpsPtr)) {
    const gps = readIfd(view, gpsPtr[0], le);
    const lat = dmsToDegrees(gps.get(GPS_LAT), gps.get(GPS_LAT_REF), "S");
    const lon = dmsToDegrees(gps.get(GPS_LON), gps.get(GPS_LON_REF), "W");
    if (lat !== undefined && lon !== undefined && !(lat === 0 && lon === 0)) {
      info.latitude = lat;
      info.longitude = lon;
    }
  }
  return info;
}

/** Returns the TIFF block inside the JPEG's "Exif\0\0" APP1 segment. */
function findExifTiff(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return null;
    const marker = bytes[pos + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // start of scan / end of image
    const len = (bytes[pos + 2] << 8) | bytes[pos + 3];
    const start = pos + 4;
    const end = pos + 2 + len;
    if (marker === 0xe1 && end <= bytes.length && isExifHeader(bytes, start)) {
      return bytes.subarray(start + 6, end);
    }
    pos = end;
  }
  return null;
}

function isExifHeader(b: Uint8Array, i: number): boolean {
  return b[i] === 0x45 && b[i + 1] === 0x78 && b[i + 2] === 0x69 && b[i + 3] === 0x66 && b[i + 4] === 0 && b[i + 5] === 0;
}

function readIfd(view: DataView, offset: number, le: boolean): Map<number, IfdValue> {
  const out = new Map<number, IfdValue>();
  if (offset + 2 > view.byteLength) return out;
  const count = view.getUint16(offset, le);
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = view.getUint16(entry, le);
    const type = view.getUint16(entry + 2, le);
    const n = view.getUint32(entry + 4, le);
    const size = TYPE_SIZES[type];
    if (!size) continue;
    const total = size * n;
    const dataAt = total <= 4 ? entry + 8 : view.getUint32(entry + 8, le);
    if (dataAt + total > view.byteLength) continue;
    const value = readValue(view, type, n, dataAt, le);
    if (value !== undefined) out.set(tag, value);
  }
  return out;
}

function readValue(view: DataView, type: number, n: number, at: number, le: boolean): IfdValue | undefined {
  switch (type) {
    case 2: {
      let s = "";
      for (let i = 0; i < n; i++) {
        const c = view.getUint8(at + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    }
    case 1:
    case 7:
      return Array.from({ length: n }, (_, i) => view.getUint8(at + i));
    case 3:
      return Array.from({ length: n }, (_, i) => view.getUint16(at + i * 2, le));
    case 4:
      return Array.from({ length: n }, (_, i) => view.getUint32(at + i * 4, le));
    case 9:
      return Array.from({ length: n }, (_, i) => view.getInt32(at + i * 4, le));
    case 5:
    case 10:
      return Array.from({ length: n }, (_, i) => {
        const num = type === 5 ? view.getUint32(at + i * 8, le) : view.getInt32(at + i * 8, le);
        const den = type === 5 ? view.getUint32(at + i * 8 + 4, le) : view.getInt32(at + i * 8 + 4, le);
        return den === 0 ? 0 : num / den;
      });
  }
  return undefined;
}

function dmsToDegrees(dms: IfdValue | undefined, ref: IfdValue | undefined, negativeRef: string): number | undefined {
  if (!Array.isArray(dms) || dms.length < 3) return undefined;
  const deg = dms[0] + dms[1] / 60 + dms[2] / 3600;
  const sign = typeof ref === "string" && ref.toUpperCase().startsWith(negativeRef) ? -1 : 1;
  return Math.round(sign * deg * 1e6) / 1e6;
}

/** "2026:09:27 15:04:05" -> "2026-09-27T15:04:05" */
function exifDateToIso(s: string): string | undefined {
  const m = /^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(s);
  if (!m || m[1] === "0000") return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}
