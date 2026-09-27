// Decides the capture time/place for a file from the sources available, and
// records which source won so the Notion page can say where each value came from.

import type { ExifInfo } from "./exif";
import type { Mp4Info } from "./mp4";

/** What the iPhone Shortcut read from the Photos library. */
export interface PhoneMetadata {
  takenAt?: string;
  latitude?: number;
  longitude?: number;
  place?: string;
}

export interface CaptureTime {
  /** ISO 8601. Carries an offset or "Z" unless `timeZone` is set. */
  start: string;
  /** IANA zone Notion should apply when `start` has no offset. */
  timeZone?: string;
  source: string;
}

export interface Capture {
  taken: CaptureTime;
  latitude?: number;
  longitude?: number;
  locationSource?: string;
  place?: string;
  camera?: string;
  durationSeconds?: number;
}

const ISO_WITH_ZONE = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/;

export function resolveCapture(opts: {
  exif?: ExifInfo | null;
  mp4?: Mp4Info | null;
  phone: PhoneMetadata;
  timeZone: string;
  now: Date;
}): Capture {
  const { exif, mp4, phone, timeZone, now } = opts;

  let taken: CaptureTime;
  if (exif?.dateTimeOriginal && exif.offsetTimeOriginal) {
    taken = { start: exif.dateTimeOriginal + exif.offsetTimeOriginal, source: "Camera (EXIF, with UTC offset)" };
  } else if (phone.takenAt && ISO_WITH_ZONE.test(phone.takenAt)) {
    // Photos' "Date Taken" is zone-aware, so it beats a zoneless camera clock.
    taken = { start: phone.takenAt, source: "iPhone Photos library" };
  } else if (exif?.dateTimeOriginal) {
    taken = { start: exif.dateTimeOriginal, timeZone, source: `Camera (EXIF, assumed ${timeZone})` };
  } else if (mp4?.createdAt) {
    taken = { start: mp4.createdAt, source: "Video header (UTC)" };
  } else {
    taken = { start: now.toISOString(), source: "Upload time (no capture time found)" };
  }

  const capture: Capture = { taken };
  const fileLat = exif?.latitude ?? mp4?.latitude;
  const fileLon = exif?.longitude ?? mp4?.longitude;
  if (fileLat !== undefined && fileLon !== undefined) {
    capture.latitude = fileLat;
    capture.longitude = fileLon;
    capture.locationSource = "Embedded in file";
  } else if (isCoord(phone.latitude) && isCoord(phone.longitude)) {
    capture.latitude = phone.latitude;
    capture.longitude = phone.longitude;
    capture.locationSource = "iPhone Photos library";
  }
  if (phone.place) capture.place = phone.place;

  const make = exif?.make ?? mp4?.make;
  const model = exif?.model ?? mp4?.model;
  const camera = model && make && model.toLowerCase().includes(make.toLowerCase()) ? model : [make, model].filter(Boolean).join(" ");
  if (camera) capture.camera = camera;
  if (mp4?.durationSeconds) capture.durationSeconds = mp4.durationSeconds;
  return capture;
}

function isCoord(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n !== 0;
}

/** "Sep 27, 2026, 3:04 PM" in the capture's own local time. */
export function formatTaken(t: CaptureTime, displayZone: string): string {
  const fmt = (zone: string, d: Date) =>
    d.toLocaleString("en-US", { timeZone: zone, dateStyle: "medium", timeStyle: "short" });
  if (t.timeZone) return fmt("UTC", new Date(t.start + "Z")); // zoneless wall-clock time: show as-is
  return fmt(displayZone, new Date(t.start));
}
