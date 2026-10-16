import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Min,
  Max,
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
  @Max(10000)
  totalChunks!: number;

  @IsString()
  @IsOptional()
  fullFileChecksum?: string;
}
