import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from "class-validator";

export class RespondCrossTeamRequestDto {
  @IsBoolean()
  approved: boolean;

  @ValidateIf((value) => value.approved === true)
  @IsUUID()
  selectedProfileId?: string;

  @IsString()
  @IsOptional()
  responseNote?: string;
}
