import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Readable } from "stream";
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  UploadContext,
} from "./file-validation.constants";

// The clamscan package does not ship TypeScript types.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeClam = require("clamscan");

@Injectable()
export class FileValidationService {
  private readonly logger = new Logger(FileValidationService.name);
  private clamClientPromise: Promise<any> | null = null;

  constructor(private readonly configService: ConfigService) {}

  async validate(file: Express.Multer.File, context: UploadContext) {
    if (!file) {
      throw new BadRequestException("File is required");
    }

    this.validateMimeType(file);
    this.validateSize(file);
    await this.scanForViruses(file, context);
  }

  private validateMimeType(file: Express.Multer.File) {
    const normalized = file.mimetype?.toLowerCase() || "";
    if (!ALLOWED_UPLOAD_MIME_TYPES.includes(normalized)) {
      throw new BadRequestException("Unsupported file type");
    }
  }

  private validateSize(file: Express.Multer.File) {
    const sizeBytes =
      typeof file.size === "number" ? file.size : file.buffer?.length || 0;
    const configured = this.configService.get<string>("MAX_UPLOAD_BYTES");
    const parsed = configured ? Number(configured) : NaN;
    const maxBytes = Number.isFinite(parsed) ? parsed : MAX_UPLOAD_BYTES;
    if (sizeBytes > maxBytes) {
      const maxMb = Math.round(maxBytes / (1024 * 1024));
      throw new BadRequestException(`File exceeds ${maxMb} MB limit`);
    }
  }

  private async scanForViruses(
    file: Express.Multer.File,
    context: UploadContext,
  ) {
    const clamEnabled =
      this.configService.get<string>("CLAMAV_ENABLED") === "true";
    if (!clamEnabled) {
      return;
    }

    const clam = await this.getClamClient();
    if (!clam) {
      this.logger.warn("ClamAV client not available, skipping virus scan");
      return;
    }

    try {
      const fileStream = Readable.from(file.buffer);
      const { isInfected, viruses } = await clam.scanStream(fileStream);
      if (isInfected) {
        const signature = Array.isArray(viruses)
          ? viruses.join(", ")
          : String(viruses);
        this.logger.warn(`Blocked infected ${context} upload: ${signature}`);
        throw new BadRequestException(
          `Upload rejected: malware detected (${signature || "unknown signature"})`,
        );
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(
        `Virus scan failed: ${error instanceof Error ? error.message : error}`,
      );
      throw new BadRequestException("Unable to scan file for viruses");
    }
  }

  private async getClamClient() {
    if (this.clamClientPromise) {
      return this.clamClientPromise;
    }

    const host = this.configService.get<string>("CLAMAV_HOST") || "localhost";
    const port = Number(this.configService.get<string>("CLAMAV_PORT") || 3310);
    const timeout = Number(
      this.configService.get<string>("CLAMAV_TIMEOUT") || 60000,
    );

    this.clamClientPromise = new NodeClam()
      .init({
        clamdscan: {
          host,
          port,
          timeout,
        },
        removeInfected: false,
        quarantineInfected: false,
        scanLog: null,
        debugMode: false,
      })
      .catch((error: any) => {
        this.logger.error(
          `Failed to initialize ClamAV client: ${error?.message || error}`,
        );
        return null;
      });

    return this.clamClientPromise;
  }
}
