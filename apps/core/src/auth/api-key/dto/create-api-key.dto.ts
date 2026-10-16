import {
  IsString,
  Length,
  Matches,
  IsOptional,
  IsEnum,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Role } from '@prisma/client';

export class CreateApiKeyDto {
  @IsString()
  @Length(1, 100)
  @Matches(/^[a-zA-Z0-9_\-\.\s]+$/, {
    message:
      'Name can only contain alphanumeric characters, spaces, dots, hyphens, and underscores',
  })
  name!: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
