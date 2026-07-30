import { IsString, IsNotEmpty, IsUUID, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UploadChunkDto {
  @IsUUID()
  @IsNotEmpty()
  fileId!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  chunkIndex!: number;

  @IsString()
  @IsNotEmpty()
  checksum!: string;
}
