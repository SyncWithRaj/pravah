import { IsString, IsNotEmpty, Matches } from 'class-validator';

export class UploadChunkDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-fA-F0-9]{64}$/, {
    message: 'checksum must be a valid 64-character SHA-256 hex string',
  })
  checksum!: string;
}
