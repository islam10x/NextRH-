import { IsNotEmpty, IsOptional, IsString, IsUUID } from "class-validator";

export class RequestCrossTeamMemberDto {
  @IsUUID()
  projectId: string;

  @IsUUID()
  targetTeamId: string;

  @IsString()
  @IsOptional()
  @IsNotEmpty()
  requestNote?: string;
}
