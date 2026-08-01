import { IsString, IsNotEmpty } from 'class-validator';

export class UploadChunkDto {
  @IsString()
  @IsNotEmpty()
  checksum!: string;
}
