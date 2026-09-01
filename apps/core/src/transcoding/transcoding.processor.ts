import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/minio/minio.service';
import { KafkaService } from '../common/kafka/kafka.service';
import { TranscodeStatus } from '@prisma/client';
import { TranscodingJobData } from './transcoding.interfaces';
import {
  TRANSCODE_QUEUE_NAME,
  HLS_SEGMENT_DURATION,
  getApplicableProfiles,
} from './transcoding.constants';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

@Processor(TRANSCODE_QUEUE_NAME, { concurrency: 2 })
export class TranscodingProcessor extends WorkerHost {
  private readonly logger = new Logger(TranscodingProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly kafkaService: KafkaService,
  ) {
    super();
  }

  async process(job: Job<TranscodingJobData>): Promise<void> {
    const { fileId, versionId, ownerId, rawStoragePath } = job.data;
    const startTime = Date.now();
    const tempDir = `/tmp/pravah-transcode/${fileId}-${versionId}`;

    this.logger.log(
      `Starting transcoding job ${job.id}: file ${fileId}, version ${versionId}`,
    );

    try {
      // 1. Create temp working directory
      fs.mkdirSync(tempDir, { recursive: true });
      fs.mkdirSync(`${tempDir}/hls`, { recursive: true });

      // 2. Download raw video from MinIO to local disk
      const inputPath = `${tempDir}/input_original`;
      const stream = await this.minioService.getObjectStream(rawStoragePath);
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(inputPath);
        stream.pipe(writeStream);
        writeStream.on('finish', () => resolve());
        writeStream.on('error', (err: Error) => reject(err));
        stream.on('error', (err: Error) => reject(err));
      });

      this.logger.log(
        `Downloaded raw video to ${inputPath} (${(fs.statSync(inputPath).size / 1024 / 1024).toFixed(1)} MB)`,
      );

      // 3. Probe source video dimensions and duration with ffprobe
      const probeResult = await this.runCommand('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,duration',
        '-of',
        'json',
        inputPath,
      ]);

      interface FfprobeStream {
        width: number;
        height: number;
        duration?: string;
      }
      interface FfprobeOutput {
        streams: FfprobeStream[];
      }

      const probeData = JSON.parse(probeResult) as FfprobeOutput;
      const sourceWidth: number = probeData.streams[0].width;
      const sourceHeight: number = probeData.streams[0].height;
      const duration: number = parseFloat(probeData.streams[0].duration || '0');

      this.logger.log(
        `Source video: ${sourceWidth}x${sourceHeight}, ${duration.toFixed(1)}s`,
      );

      // 4. Determine applicable profiles (no upscaling)
      const profiles = getApplicableProfiles(sourceWidth, sourceHeight);

      if (profiles.length === 0) {
        this.logger.warn(
          `Source ${sourceWidth}x${sourceHeight} is smaller than the lowest profile (256x144). Skipping transcoding.`,
        );
        return;
      }

      this.logger.log(
        `Applicable profiles: ${profiles.map((p) => p.name).join(', ')}`,
      );

      // 5. Create Prisma records for each quality
      for (const profile of profiles) {
        await this.prisma.videoTranscode.upsert({
          where: {
            fileId_versionId_quality: {
              fileId,
              versionId,
              quality: profile.prismaQuality,
            },
          },
          create: {
            fileId,
            versionId,
            quality: profile.prismaQuality,
            status: TranscodeStatus.PENDING,
          },
          update: {
            status: TranscodeStatus.PENDING,
            errorMessage: null,
          },
        });
      }

      // 6. Run FFmpeg for each quality profile (sequential, one per resolution)
      let totalSegments = 0;

      for (const profile of profiles) {
        const profileDir = `${tempDir}/hls/${profile.name}`;
        fs.mkdirSync(profileDir, { recursive: true });

        // Mark as PROCESSING
        await this.prisma.videoTranscode.update({
          where: {
            fileId_versionId_quality: {
              fileId,
              versionId,
              quality: profile.prismaQuality,
            },
          },
          data: { status: TranscodeStatus.PROCESSING },
        });

        this.logger.log(
          `Transcoding ${profile.name} (${profile.width}x${profile.height})...`,
        );

        const ffmpegArgs = [
          '-i',
          inputPath,
          '-vf',
          `scale=w=${profile.width}:h=${profile.height}`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-threads',
          '0',
          '-b:v',
          profile.videoBitrate,
          '-maxrate',
          profile.maxRate,
          '-bufsize',
          profile.bufSize,
          '-c:a',
          'aac',
          '-b:a',
          profile.audioBitrate,
          '-f',
          'hls',
          '-hls_time',
          HLS_SEGMENT_DURATION.toString(),
          '-hls_playlist_type',
          'vod',
          '-hls_segment_filename',
          `${profileDir}/segment-%03d.ts`,
          `${profileDir}/index.m3u8`,
        ];

        await this.runCommand('ffmpeg', ffmpegArgs);

        // Count segments generated for this profile
        const segmentFiles = fs
          .readdirSync(profileDir)
          .filter((f) => f.endsWith('.ts'));
        totalSegments += segmentFiles.length;

        // Parse bitrate from profile for DB storage
        const bitrateKbps = parseInt(profile.videoBitrate.replace('k', ''), 10);

        // Mark as COMPLETED in Prisma
        await this.prisma.videoTranscode.update({
          where: {
            fileId_versionId_quality: {
              fileId,
              versionId,
              quality: profile.prismaQuality,
            },
          },
          data: {
            status: TranscodeStatus.COMPLETED,
            storagePath: `hls/${ownerId}/${fileId}/${versionId}/${profile.name}/`,
            durationSeconds: duration,
            width: profile.width,
            height: profile.height,
            bitrateKbps,
          },
        });

        this.logger.log(
          `Completed ${profile.name}: ${segmentFiles.length} segments`,
        );
      }

      // 7. Generate master.m3u8 playlist
      const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3', ''];

      for (const profile of profiles) {
        const bitrateValue =
          parseInt(profile.videoBitrate.replace('k', ''), 10) * 1000;
        masterLines.push(
          `#EXT-X-STREAM-INF:BANDWIDTH=${bitrateValue},RESOLUTION=${profile.width}x${profile.height},NAME="${profile.name}"`,
        );
        masterLines.push(`${profile.name}/index.m3u8`);
      }

      const masterContent = masterLines.join('\n') + '\n';
      fs.writeFileSync(`${tempDir}/hls/master.m3u8`, masterContent);

      // 8. Upload all HLS files to MinIO
      const hlsBasePath = `hls/${ownerId}/${fileId}/${versionId}`;

      // Upload master.m3u8
      await this.minioService.uploadChunk(
        `${hlsBasePath}/master.m3u8`,
        fs.readFileSync(`${tempDir}/hls/master.m3u8`),
      );

      // Upload each profile's files
      for (const profile of profiles) {
        const profileDir = `${tempDir}/hls/${profile.name}`;
        const files = fs.readdirSync(profileDir);

        for (const file of files) {
          const filePath = path.join(profileDir, file);
          const minioKey = `${hlsBasePath}/${profile.name}/${file}`;
          await this.minioService.uploadChunk(
            minioKey,
            fs.readFileSync(filePath),
          );
        }
      }

      this.logger.log(
        `Uploaded HLS output to MinIO: ${hlsBasePath}/master.m3u8`,
      );

      // 9. Set masterPlaylistPath on the highest quality record
      await this.prisma.videoTranscode.update({
        where: {
          fileId_versionId_quality: {
            fileId,
            versionId,
            quality: profiles[0].prismaQuality,
          },
        },
        data: {
          masterPlaylistPath: `${hlsBasePath}/master.m3u8`,
        },
      });

      // 10. Emit Kafka video.transcoded event
      this.kafkaService.emitVideoTranscoded({
        eventId: crypto.randomUUID(),
        fileId,
        versionId,
        masterManifestPath: `${hlsBasePath}/master.m3u8`,
        resolutions: profiles.map((p) => p.name),
        totalSegments,
        durationSeconds: duration,
        timestamp: new Date().toISOString(),
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(
        `Transcoding complete for ${fileId}: ${profiles.length} qualities, ${totalSegments} total segments in ${elapsed}s`,
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown transcoding error';

      this.logger.error(`Transcoding failed for ${fileId}: ${errorMessage}`);

      // Mark all pending/processing records as FAILED
      await this.prisma.videoTranscode.updateMany({
        where: {
          fileId,
          versionId,
          status: { in: [TranscodeStatus.PENDING, TranscodeStatus.PROCESSING] },
        },
        data: {
          status: TranscodeStatus.FAILED,
          errorMessage,
        },
      });

      throw error;
    } finally {
      // Cleanup temp directory
      try {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch {
        this.logger.warn(`Failed to cleanup temp dir: ${tempDir}`);
      }
    }
  }

  /**
   * Runs an external command (ffmpeg/ffprobe) and captures stdout/stderr.
   */
  private runCommand(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else
          reject(
            new Error(
              `${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`,
            ),
          );
      });
      proc.on('error', reject);
    });
  }
}
