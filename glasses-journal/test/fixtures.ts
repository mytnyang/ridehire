// Builders for tiny synthetic JPEG/MP4 files with known metadata.

export function buildJpeg(opts: {
  dateTimeOriginal?: string; // "2026:09:27 15:04:05"
  offset?: string; // "-05:00"
  lat?: number;
  lon?: number;
  make?: string;
  model?: string;
  littleEndian?: boolean;
}): Uint8Array {
  const le = opts.littleEndian ?? false;
  type Entry = { tag: number; type: number; count: number; data: number[] };
  const ascii = (tag: number, s: string): Entry => ({ tag, type: 2, count: s.length + 1, data: [...s].map((c) => c.charCodeAt(0)).concat(0) });
  const u16 = (n: number) => (le ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) => (le ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const rational = (v: number) => u32(Math.round(v * 1_000_000)).concat(u32(1_000_000));
  const dms = (deg: number): number[] => {
    const a = Math.abs(deg);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const s = (a - d - m / 60) * 3600;
    return [...rational(d), ...rational(m), ...rational(s)];
  };

  const ifd0: Entry[] = [];
  const exif: Entry[] = [];
  const gps: Entry[] = [];
  if (opts.make) ifd0.push(ascii(0x010f, opts.make));
  if (opts.model) ifd0.push(ascii(0x0110, opts.model));
  if (opts.dateTimeOriginal) exif.push(ascii(0x9003, opts.dateTimeOriginal));
  if (opts.offset) exif.push(ascii(0x9011, opts.offset));
  if (opts.lat !== undefined && opts.lon !== undefined) {
    gps.push(ascii(1, opts.lat < 0 ? "S" : "N"), { tag: 2, type: 5, count: 3, data: dms(opts.lat) });
    gps.push(ascii(3, opts.lon < 0 ? "W" : "E"), { tag: 4, type: 5, count: 3, data: dms(opts.lon) });
  }

  // Layout: header(8) | IFD0 | EXIF IFD | GPS IFD | overflow data
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const ifd0Entries = ifd0.length + (exif.length ? 1 : 0) + (gps.length ? 1 : 0);
  const ifd0At = 8;
  const exifAt = ifd0At + ifdSize(ifd0Entries);
  const gpsAt = exifAt + (exif.length ? ifdSize(exif.length) : 0);
  let dataAt = gpsAt + (gps.length ? ifdSize(gps.length) : 0);
  if (exif.length) ifd0.push({ tag: 0x8769, type: 4, count: 1, data: u32(exifAt) });
  if (gps.length) ifd0.push({ tag: 0x8825, type: 4, count: 1, data: u32(gpsAt) });

  const overflow: number[] = [];
  const writeIfd = (entries: Entry[]) => {
    const out = [...u16(entries.length)];
    for (const e of entries.sort((a, b) => a.tag - b.tag)) {
      out.push(...u16(e.tag), ...u16(e.type), ...u32(e.count));
      if (e.data.length <= 4) out.push(...e.data, ...Array(4 - e.data.length).fill(0));
      else {
        out.push(...u32(dataAt + overflow.length));
        overflow.push(...e.data);
      }
    }
    out.push(...u32(0));
    return out;
  };
  const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0At)];
  tiff.push(...writeIfd(ifd0));
  if (exif.length) tiff.push(...writeIfd(exif));
  if (gps.length) tiff.push(...writeIfd(gps));
  tiff.push(...overflow);

  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = app1.length + 2;
  // SOI, an APP0 segment first (like real cameras), APP1/EXIF, then SOS + EOI.
  const app0 = [0xff, 0xe0, 0x00, 0x07, 0x4a, 0x46, 0x49, 0x46, 0x00];
  return new Uint8Array([0xff, 0xd8, ...app0, 0xff, 0xe1, len >> 8, len & 0xff, ...app1, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

export function box(type: string, ...payload: (number[] | Uint8Array)[]): Uint8Array {
  const body = payload.flatMap((p) => [...p]);
  const size = body.length + 8;
  const t = [...type].map((c) => c.charCodeAt(0));
  return new Uint8Array([size >>> 24, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff, ...t, ...body]);
}

const u32be = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u16be = (n: number) => [n >> 8, n & 0xff];
const str = (s: string) => [...new TextEncoder().encode(s)];

export function buildMp4(opts: {
  createdUnix?: number;
  timescale?: number;
  duration?: number;
  iso6709?: string;
  appleKeys?: Record<string, string>;
  moovAtEnd?: boolean;
  mdatBytes?: number;
}): Uint8Array {
  const created = opts.createdUnix !== undefined ? opts.createdUnix + 2082844800 : 0;
  const mvhd = box("mvhd", [0, 0, 0, 0], u32be(created), u32be(created), u32be(opts.timescale ?? 1000), u32be(opts.duration ?? 0), Array(80).fill(0));
  const children: Uint8Array[] = [mvhd];
  if (opts.iso6709) {
    const s = str(opts.iso6709);
    children.push(box("udta", box("©xyz", u16be(s.length), u16be(0x15c7), s)));
  }
  if (opts.appleKeys) {
    const entries = Object.entries(opts.appleKeys);
    const keys = box("keys", [0, 0, 0, 0], u32be(entries.length), ...entries.map(([k]) => [...u32be(k.length + 8), ...str("mdta"), ...str(k)]));
    const items = entries.map(([, v], i) => {
      const data = box("data", u32be(1), u32be(0), str(v));
      return [...u32be(data.length + 8), ...u32be(i + 1), ...data];
    });
    const ilst = box("ilst", ...items);
    const hdlr = box("hdlr", Array(24).fill(0));
    children.push(box("meta", hdlr, keys, ilst));
  }
  const moov = box("moov", ...children);
  const ftyp = box("ftyp", str("isom"), u32be(0), str("isommp42"));
  const mdat = box("mdat", Array(opts.mdatBytes ?? 64).fill(7));
  const parts = opts.moovAtEnd ? [ftyp, mdat, moov] : [ftyp, moov, mdat];
  return new Uint8Array(parts.flatMap((p) => [...p]));
}
