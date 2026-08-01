import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Min,
  IsOptional,
} from 'class-validator';

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

  @IsString()
  @IsOptional()
  fullFileChecksum?: string;
}
