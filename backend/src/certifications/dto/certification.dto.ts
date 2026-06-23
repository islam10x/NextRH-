import { IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateCertificationDto {
  @IsString()
  @IsNotEmpty()
  certificationName: string;

  @IsString()
  @IsOptional()
  issuingOrganization?: string;

  @IsString()
  @IsOptional()
  issueDate?: string;

  @IsString()
  @IsOptional()
  expirationDate?: string;

  @IsString()
  @IsOptional()
  credentialId?: string;
}

export class UpdateCertificationDto {
  @IsString()
  @IsOptional()
  certificationName?: string;

  @IsString()
  @IsOptional()
  issuingOrganization?: string;

  @IsString()
  @IsOptional()
  issueDate?: string | null;

  @IsString()
  @IsOptional()
  expirationDate?: string | null;

  @IsString()
  @IsOptional()
  credentialId?: string;
}
