import { IsNotEmpty, IsString, Matches, MinLength } from "class-validator";

export const PASSWORD_POLICY_REGEX = /^(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
export const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 8 characters long and include at least one number and one special character.";

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @Matches(PASSWORD_POLICY_REGEX, {
    message: PASSWORD_POLICY_MESSAGE,
  })
  newPassword: string;
}
