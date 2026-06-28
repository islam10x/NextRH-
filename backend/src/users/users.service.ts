import {
  Injectable,
  ConflictException,
  NotFoundException,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as bcrypt from "bcryptjs";
import { User, UserStatus, UserRole } from "./entities/user.entity";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { RagService } from "../rag/rag.service";
import { ConfigService } from "@nestjs/config";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { UpdateMyProfileDto } from "./dto/update-my-profile.dto";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly ragService: RagService,
    private readonly configService: ConfigService,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    // Check if user already exists
    const existingUser = await this.usersRepository.findOne({
      where: { email: createUserDto.email },
    });

    if (existingUser) {
      throw new ConflictException("User with this email already exists");
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(createUserDto.password, 10);

    // Create user
    const user = this.usersRepository.create({
      ...createUserDto,
      password: hashedPassword,
      status: UserStatus.ACTIVE,
      activatedAt: new Date(),
    });

    return this.usersRepository.save(user);
  }

  async findAll(managerId?: string): Promise<any[]> {
    const query = this.usersRepository
      .createQueryBuilder("u")
      .select([
        "u.user_id",
        "u.email",
        "u.firstName",
        "u.lastName",
        "u.role",
        "u.status",
        "u.createdAt",
        "u.updatedAt",
        "u.invitedBy",
        "u.invitedAt",
        "u.avatarPath",
      ])
      .leftJoin("team_members", "tm", "tm.employee_id = u.user_id")
      .leftJoin("teams", "t", "t.team_id = tm.team_id");

    if (managerId) {
      query
        .where("u.invitedBy = :managerId", { managerId })
        .orWhere("t.manager_id = :managerId::uuid", { managerId });
    }

    const users = await query.getMany();
    return users.map((user) => this.toSafeUser(user));
  }

  async setCurrentRefreshToken(
    refreshToken: string,
    userId: string,
  ): Promise<void> {
    const currentHashedRefreshToken = await bcrypt.hash(refreshToken, 10);
    await this.usersRepository.update(userId, {
      currentHashedRefreshToken,
    });
  }

  async getUserIfRefreshTokenMatches(
    refreshToken: string,
    userId: string,
  ): Promise<User | null> {
    const user = await this.usersRepository.findOne({
      where: { user_id: userId },
      select: [
        "user_id",
        "email",
        "firstName",
        "lastName",
        "role",
        "status",
        "currentHashedRefreshToken",
      ],
    });

    if (!user) {
      return null;
    }

    const isRefreshTokenMatching = await bcrypt.compare(
      refreshToken,
      user.currentHashedRefreshToken || "",
    );

    if (isRefreshTokenMatching) {
      return user;
    }

    return null;
  }

  async removeRefreshToken(userId: string): Promise<void> {
    return this.usersRepository
      .update(userId, {
        currentHashedRefreshToken: null!,
      })
      .then(() => {});
  }

  async findById(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { user_id: id },
      select: [
        "user_id",
        "email",
        "firstName",
        "lastName",
        "role",
        "status",
        "createdAt",
        "updatedAt",
        "avatarPath",
      ],
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { email },
    });
  }

  async findByKeycloakSub(sub: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { keycloakSub: sub } });
  }

  /**
   * Resolve the local user behind a verified Keycloak token (JIT provisioning).
   * Keycloak owns identity AND roles; the local row mirrors them so existing
   * DB-side queries/joins (findAll, relations) keep working.
   * 1. Already linked → sync role if it changed.
   * 2. Known email, not linked yet (existing user) → link `keycloak_sub`, sync role.
   * 3. Unknown → create the local row (role from token, else EMPLOYEE).
   *
   * `role` is undefined when the token carries no app role (misconfigured
   * mapper); in that case we keep the stored role rather than overwrite it.
   */
  async findOrProvisionFromKeycloak(claims: {
    sub: string;
    email: string;
    firstName?: string;
    lastName?: string;
    role?: UserRole;
  }): Promise<User> {
    const linked = await this.findByKeycloakSub(claims.sub);
    if (linked) {
      if (claims.role && linked.role !== claims.role) {
        linked.role = claims.role;
        this.logger.log(
          `Synced role ${claims.role} from Keycloak for ${claims.email}`,
        );
        return this.usersRepository.save(linked);
      }
      return linked;
    }

    const byEmail = await this.findByEmail(claims.email);
    if (byEmail) {
      byEmail.keycloakSub = claims.sub;
      byEmail.status = UserStatus.ACTIVE;
      if (claims.role) byEmail.role = claims.role;
      if (!byEmail.activatedAt) byEmail.activatedAt = new Date();
      this.logger.log(`Linked Keycloak sub to existing user ${claims.email}`);
      return this.usersRepository.save(byEmail);
    }

    const created = this.usersRepository.create({
      email: claims.email,
      firstName: claims.firstName ?? null,
      lastName: claims.lastName ?? null,
      keycloakSub: claims.sub,
      role: claims.role ?? UserRole.EMPLOYEE,
      status: UserStatus.ACTIVE,
      activatedAt: new Date(),
    });
    this.logger.log(`Provisioned new user from Keycloak: ${claims.email}`);
    return this.usersRepository.save(created);
  }

  async getOwnProfile(userId: string) {
    const user = await this.findById(userId);
    return this.toSafeUser(user);
  }

  async updateOwnProfile(
    userId: string,
    updateMyProfileDto: UpdateMyProfileDto,
  ) {
    const user = await this.findById(userId);
    if (typeof updateMyProfileDto.firstName === "string") {
      user.firstName = updateMyProfileDto.firstName.trim();
    }
    if (typeof updateMyProfileDto.lastName === "string") {
      user.lastName = updateMyProfileDto.lastName.trim();
    }
    const saved = await this.usersRepository.save(user);
    return this.toSafeUser(saved);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.usersRepository.findOne({
      where: { user_id: userId },
      select: ["user_id", "password"],
    });

    if (!user?.password) {
      throw new NotFoundException("User not found");
    }

    const passwordMatches = await bcrypt.compare(
      dto.currentPassword,
      user.password,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException("Current password is incorrect");
    }

    const isSamePassword = await bcrypt.compare(dto.newPassword, user.password);
    if (isSamePassword) {
      throw new BadRequestException(
        "New password must be different from the current password",
      );
    }

    user.password = await bcrypt.hash(dto.newPassword, 10);
    await this.usersRepository.save(user);
    return { message: "Password updated successfully" };
  }

  async updateAvatar(userId: string, file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException("Avatar file is required");
    }

    const user = await this.findById(userId);
    const baseDir = await this.resolveUserBaseDir(user);
    const uploadDir = path.join(baseDir, "uploads");
    await fs.mkdir(uploadDir, { recursive: true });

    const extension = this.resolveAvatarExtension(file);
    if (!extension) {
      throw new BadRequestException("Unsupported avatar file type");
    }

    await this.removeExistingAvatarFiles(uploadDir);
    const fileName = `avatar${extension}`;
    const fullPath = path.join(uploadDir, fileName);
    await fs.writeFile(fullPath, file.buffer);

    const relativePath = path
      .relative(this.getStorageRoot(), fullPath)
      .replace(/\\/g, "/");
    user.avatarPath = relativePath;
    const saved = await this.usersRepository.save(user);

    return this.toSafeUser(saved);
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.findById(id);

    // If password is being updated, hash it
    if (updateUserDto.password) {
      updateUserDto.password = await bcrypt.hash(updateUserDto.password, 10);
    }

    Object.assign(user, updateUserDto);
    return this.usersRepository.save(user);
  }

  async remove(id: string): Promise<void> {
    const user = await this.findById(id);

    // Remove the user's folder from file-storage
    await this.removeUserBaseDir(user);

    await this.usersRepository.remove(user);
    try {
      await this.ragService.deleteUserVectors(user.user_id);
    } catch (error) {
      this.logger.warn(
        `Failed to delete RAG vectors for user ${user.user_id}: ${error?.message ?? error}`,
      );
    }
  }

  async validatePassword(
    plainPassword: string,
    hashedPassword: string,
  ): Promise<boolean> {
    return bcrypt.compare(plainPassword, hashedPassword);
  }

  getAvatarUrl(avatarPath?: string | null): string | null {
    if (!avatarPath) return null;
    const normalizedAvatarPath = avatarPath
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    const absoluteAvatarPath = path.join(
      this.getStorageRoot(),
      normalizedAvatarPath,
    );
    if (!existsSync(absoluteAvatarPath)) {
      // Folder renames after CV parsing can invalidate stale stored avatar paths.
      // Returning null avoids repeated frontend 404 fetches.
      return null;
    }
    const publicBaseUrl =
      this.configService.get<string>("BACKEND_PUBLIC_URL") ||
      `http://localhost:${this.configService.get<string>("PORT", "3000")}`;
    return `${publicBaseUrl.replace(/\/+$/, "")}/public/cv-database/${normalizedAvatarPath}`;
  }

  toSafeUser(user: Partial<User> & { user_id?: string }) {
    return {
      user_id: user.user_id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      invitedAt: user.invitedAt ?? null,
      avatarUrl: this.getAvatarUrl(user.avatarPath),
    };
  }

  private getStorageRoot() {
    return path.resolve(process.cwd(), "file-storage", "CV_Database");
  }

  private buildSafeFolderName(name: string, userId: string) {
    const normalized = name
      .trim()
      .replace(/\s+/g, " ")
      .split(" ")
      .filter(Boolean)
      .map(
        (token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase(),
      )
      .join("_");
    const userIdShort = userId.replace(/-/g, "").substring(0, 8);
    return `${(normalized || "User").replace(/[^a-zA-Z0-9.-]/g, "_")}_${userIdShort}`;
  }

  private async resolveUserBaseDir(user: User) {
    const rootDir = this.getStorageRoot();
    await fs.mkdir(rootDir, { recursive: true });

    const userIdShort = user.user_id.replace(/-/g, "").substring(0, 8);
    if (existsSync(rootDir)) {
      const folders = await fs.readdir(rootDir);
      const existing = folders.find((folder) =>
        folder.endsWith(`_${userIdShort}`),
      );
      if (existing) {
        return path.join(rootDir, existing);
      }
    }

    const fallbackName =
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
      user.email.split("@")[0] ||
      "user";
    const baseDir = path.join(
      rootDir,
      this.buildSafeFolderName(fallbackName, user.user_id),
    );
    await fs.mkdir(baseDir, { recursive: true });
    return baseDir;
  }

  private async removeUserBaseDir(user: User) {
    const rootDir = this.getStorageRoot();
    if (!existsSync(rootDir)) return;

    const userIdShort = user.user_id.replace(/-/g, "").substring(0, 8);
    const folders = await fs.readdir(rootDir);

    const folderToDelete = folders.find((folder) =>
      folder.endsWith(`_${userIdShort}`),
    );

    if (folderToDelete) {
      const fullPath = path.join(rootDir, folderToDelete);
      try {
        await fs.rm(fullPath, { recursive: true, force: true });
        this.logger.log(
          `[Folder Deletion] Successfully deleted folder ${folderToDelete} for user ${user.user_id}`,
        );
      } catch (error) {
        this.logger.warn(
          `[Folder Deletion] Failed to delete folder ${fullPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private resolveAvatarExtension(file: Express.Multer.File) {
    switch ((file.mimetype || "").toLowerCase()) {
      case "image/png":
        return ".png";
      case "image/jpeg":
      case "image/jpg":
        return ".jpg";
      case "image/webp":
        return ".webp";
      default:
        return "";
    }
  }

  private async removeExistingAvatarFiles(uploadDir: string) {
    try {
      const files = await fs.readdir(uploadDir);
      await Promise.all(
        files
          .filter((file) => /^avatar\./i.test(file))
          .map((file) => fs.unlink(path.join(uploadDir, file))),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to clear old avatar files: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
