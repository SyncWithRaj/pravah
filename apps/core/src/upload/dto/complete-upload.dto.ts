import { IsNotEmpty, IsUUID } from 'class-validator';

export class CompleteUploadDto {
  @IsUUID()
  @IsNotEmpty()
  fileId!: string;
}
