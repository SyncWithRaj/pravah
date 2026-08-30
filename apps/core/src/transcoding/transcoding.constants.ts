import { TranscodeQuality } from '@prisma/client';
export { TranscodeQuality };

// ─────────────────────────────────────────────────────────────────────────────
// BullMQ Queue Name
// ─────────────────────────────────────────────────────────────────────────────

export const TRANSCODE_QUEUE_NAME = 'video-transcoding';

// ─────────────────────────────────────────────────────────────────────────────
// HLS Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const HLS_SEGMENT_DURATION = 4; // seconds per .ts segment

// ─────────────────────────────────────────────────────────────────────────────
// Video MIME types that trigger the transcoding pipeline
// ─────────────────────────────────────────────────────────────────────────────

export const VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/avi',
  'video/x-msvideo',
];

// ─────────────────────────────────────────────────────────────────────────────
// Quality Profiles — sorted highest to lowest
// Only profiles at or below the source resolution are generated (no upscaling)
// ─────────────────────────────────────────────────────────────────────────────

export interface QualityProfile {
  name: string;
  width: number;
  height: number;
  videoBitrate: string;
  maxRate: string;
  bufSize: string;
  audioBitrate: string;
  prismaQuality: TranscodeQuality;
}

export const QUALITY_PROFILES: QualityProfile[] = [
  {
    name: '1080p',
    width: 1920,
    height: 1080,
    videoBitrate: '5000k',
    maxRate: '5350k',
    bufSize: '7500k',
    audioBitrate: '128k',
    prismaQuality: TranscodeQuality.Q_1080P,
  },
  {
    name: '720p',
    width: 1280,
    height: 720,
    videoBitrate: '3000k',
    maxRate: '3200k',
    bufSize: '4500k',
    audioBitrate: '128k',
    prismaQuality: TranscodeQuality.Q_720P,
  },
  {
    name: '480p',
    width: 854,
    height: 480,
    videoBitrate: '1400k',
    maxRate: '1500k',
    bufSize: '2100k',
    audioBitrate: '96k',
    prismaQuality: TranscodeQuality.Q_480P,
  },
  {
    name: '360p',
    width: 640,
    height: 360,
    videoBitrate: '800k',
    maxRate: '850k',
    bufSize: '1200k',
    audioBitrate: '96k',
    prismaQuality: TranscodeQuality.Q_360P,
  },
  {
    name: '240p',
    width: 426,
    height: 240,
    videoBitrate: '400k',
    maxRate: '450k',
    bufSize: '600k',
    audioBitrate: '64k',
    prismaQuality: TranscodeQuality.Q_240P,
  },
  {
    name: '144p',
    width: 256,
    height: 144,
    videoBitrate: '200k',
    maxRate: '250k',
    bufSize: '300k',
    audioBitrate: '48k',
    prismaQuality: TranscodeQuality.Q_144P,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic profile selector — implements the "no upscaling" rule
// Returns only profiles where BOTH dimensions are <= source dimensions
// e.g. source 720p → returns [720p, 480p, 360p, 240p, 144p]
// ─────────────────────────────────────────────────────────────────────────────

export function getApplicableProfiles(
  sourceWidth: number,
  sourceHeight: number,
): QualityProfile[] {
  return QUALITY_PROFILES.filter(
    (profile) => profile.width <= sourceWidth && profile.height <= sourceHeight,
  );
}
