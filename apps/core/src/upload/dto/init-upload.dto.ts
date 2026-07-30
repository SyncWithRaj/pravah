import { IsString, IsNotEmpty, IsNumber, Min } from 'class-validator';

export class InitUploadDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  mimeType!: string;

  @IsNumber()
  @Min(1)
  totalSize!: number;

  @IsNumber()
  @Min(1)
  totalChunks!: number;
}
