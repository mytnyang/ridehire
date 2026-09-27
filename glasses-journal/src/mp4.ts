// Minimal MP4/QuickTime metadata reader: creation time, duration, GPS and camera.
// Reads only box headers and the `moov` box, so a multi-GB video costs a few
// small ranged reads.

export interface Mp4Info {
  /** ISO 8601 UTC instant from the movie header, if set. */
  createdAt?: string;
  durationSeconds?: number;
  latitude?: number;
  longitude?: number;
  make?: string;
  model?: string;
}

/** Reads `length` bytes at `offset` (fewer at end of file). */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

const MAX_MOOV_BYTES = 32 * 1024 * 1024;
const SECONDS_1904_TO_1970 = 2082844800;
const CONTAINERS = new Set(["moov", "udta"]);

interface Box {
  type: string;
  start: number; // offset of the box header
  headerSize: number;
  size: number; // including header
}

export async function readMp4Info(read: RangeReader, fileSize: number): Promise<Mp4Info | null> {
  let pos = 0;
  while (pos + 8 <= fileSize) {
    const head = await read(pos, 16);
    const box = parseBoxHeader(head, 0, fileSize - pos);
    if (!box) return null;
    if (box.type === "moov") {
      if (box.size > MAX_MOOV_BYTES) return null;
      const moov = await read(pos, box.size);
      return parseMoov(moov);
    }
    pos += box.size;
  }
  return null;
}

export function parseMoov(moov: Uint8Array): Mp4Info {
  const info: Mp4Info = {};
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const top = parseBoxHeader(moov, 0, moov.length);
  if (!top) return info;
  walk(moov, view, top.headerSize, top.size, info);
  return info;
}

function walk(b: Uint8Array, view: DataView, from: number, to: number, info: Mp4Info): void {
  let pos = from;
  while (pos + 8 <= to) {
    const box = parseBoxHeader(b, pos, to - pos);
    if (!box) return;
    const body = pos + box.headerSize;
    const end = pos + box.size;
    switch (box.type) {
      case "mvhd":
        readMvhd(view, body, info);
        break;
      case "©xyz": {
        const text = readUdtaString(b, view, body, end);
        if (text) applyIso6709(text, info);
        break;
      }
      case "©mak":
        info.make ??= readUdtaString(b, view, body, end);
        break;
      case "©mod":
        info.model ??= readUdtaString(b, view, body, end);
        break;
      case "meta":
        readMeta(b, view, body, end, info);
        break;
      default:
        if (CONTAINERS.has(box.type)) walk(b, view, body, end, info);
    }
    pos = end;
  }
}

function readMvhd(view: DataView, body: number, info: Mp4Info): void {
  const version = view.getUint8(body);
  let created: number;
  let timescale: number;
  let duration: number;
  if (version === 1) {
    created = Number(view.getBigUint64(body + 4));
    timescale = view.getUint32(body + 20);
    duration = Number(view.getBigUint64(body + 24));
  } else {
    created = view.getUint32(body + 4);
    timescale = view.getUint32(body + 12);
    duration = view.getUint32(body + 16);
  }
  if (created > SECONDS_1904_TO_1970) {
    info.createdAt = new Date((created - SECONDS_1904_TO_1970) * 1000).toISOString().replace(".000Z", "Z");
  }
  if (timescale > 0) info.durationSeconds = Math.round((duration / timescale) * 10) / 10;
}

// QuickTime user-data strings: u16 length, u16 language, then the bytes.
function readUdtaString(b: Uint8Array, view: DataView, body: number, end: number): string | undefined {
  if (body + 4 > end) return undefined;
  const len = view.getUint16(body);
  const start = body + 4;
  if (start + len > end) return undefined;
  return new TextDecoder().decode(b.subarray(start, start + len)).trim() || undefined;
}

// `meta` with `keys` + `ilst` (Apple style). ISO `meta` is a full box with 4
// extra bytes of version/flags before its children; QuickTime's is not.
function readMeta(b: Uint8Array, view: DataView, body: number, end: number, info: Mp4Info): void {
  let pos = body;
  if (pos + 4 <= end && view.getUint32(pos) === 0) pos += 4;
  const keys: string[] = [];
  const values = new Map<number, string>();
  while (pos + 8 <= end) {
    const box = parseBoxHeader(b, pos, end - pos);
    if (!box) return;
    const inner = pos + box.headerSize;
    const boxEnd = pos + box.size;
    if (box.type === "keys") {
      const count = view.getUint32(inner + 4);
      let k = inner + 8;
      for (let i = 0; i < count && k + 8 <= boxEnd; i++) {
        const size = view.getUint32(k);
        if (size < 8) break;
        keys.push(new TextDecoder().decode(b.subarray(k + 8, k + size)));
        k += size;
      }
    } else if (box.type === "ilst") {
      let item = inner;
      while (item + 8 <= boxEnd) {
        const itemSize = view.getUint32(item);
        if (itemSize < 8) break;
        const index = view.getUint32(item + 4);
        const data = item + 8;
        if (data + 16 <= item + itemSize && fourcc(b, data + 4) === "data") {
          const dataSize = view.getUint32(data);
          const text = new TextDecoder().decode(b.subarray(data + 16, data + dataSize));
          values.set(index, text);
        }
        item += itemSize;
      }
    }
    pos = boxEnd;
  }
  keys.forEach((key, i) => {
    const value = values.get(i + 1)?.trim();
    if (!value) return;
    if (key === "com.apple.quicktime.location.ISO6709") applyIso6709(value, info);
    else if (key === "com.apple.quicktime.make") info.make ??= value;
    else if (key === "com.apple.quicktime.model") info.model ??= value;
  });
}

/** "+37.7749-122.4194+010.000/" -> lat/lon */
export function applyIso6709(text: string, info: Mp4Info): void {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(text);
  if (!m) return;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)) {
    info.latitude ??= lat;
    info.longitude ??= lon;
  }
}

function parseBoxHeader(b: Uint8Array, pos: number, available: number): Box | null {
  if (pos + 8 > b.length) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let size = view.getUint32(pos);
  const type = fourcc(b, pos + 4);
  let headerSize = 8;
  if (size === 1) {
    if (pos + 16 > b.length) return null;
    size = Number(view.getBigUint64(pos + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = available;
  }
  if (size < headerSize || size > available) return null;
  return { type, start: pos, headerSize, size };
}

function fourcc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
}
