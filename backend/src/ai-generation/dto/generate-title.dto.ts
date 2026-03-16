import { IsNotEmpty, IsString } from 'class-validator';

export class GenerateTitleDto {
  @IsString()
  @IsNotEmpty()
  description: string;
}
