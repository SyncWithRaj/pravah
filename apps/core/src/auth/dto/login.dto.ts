import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  // Can be email or username
  @IsString()
  @IsNotEmpty()
  identifier!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
