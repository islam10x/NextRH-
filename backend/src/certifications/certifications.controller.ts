import {
    Controller,
    Post,
    Get,
    UseGuards,
    UseInterceptors,
    UploadedFile,
    BadRequestException,
    ParseFilePipeBuilder,
    HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '../users/entities/user.entity';
import { CertificationsService } from './certifications.service';
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_BYTES } from '../file-validation/file-validation.constants';

@Controller('certifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CertificationsController {
    constructor(private readonly certificationsService: CertificationsService) { }

    @Post('upload')
    @Roles(UserRole.EMPLOYEE)
    @UseInterceptors(
        FileInterceptor('file', {
            limits: { fileSize: MAX_UPLOAD_BYTES },
            fileFilter: (_req, file, cb) => {
                if (!ALLOWED_UPLOAD_MIME_TYPES.includes((file.mimetype || '').toLowerCase())) {
                    return cb(new BadRequestException('Unsupported file type'), false);
                }
                return cb(null, true);
            },
        })
    )
    async uploadCertification(
        @UploadedFile(
            new ParseFilePipeBuilder()
                .addMaxSizeValidator({ maxSize: MAX_UPLOAD_BYTES })
                .addFileTypeValidator({
                    fileType:
                        /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|image\/png|image\/jpeg)$/i,
                })
                .build({ errorHttpStatusCode: HttpStatus.BAD_REQUEST })
        )
        file: Express.Multer.File,
        @CurrentUser() user: any,
    ) {
        if (!file) {
            throw new BadRequestException('File is required');
        }

        return this.certificationsService.saveEmployeeCertification(user, file);
    }

    @Get('bid/stats')
    @Roles(UserRole.BID_MANAGER)
    async getBidStats() {
        return this.certificationsService.getGlobalCertStats();
    }

    @Get('team')
    @Roles(UserRole.TEAM_MANAGER)
    async getTeamCertifications(@CurrentUser() user: any) {
        const managerId = user?.user_id || user?.id;
        return this.certificationsService.getTeamCertifications(managerId);
    }

    @Get('team/stats')
    @Roles(UserRole.TEAM_MANAGER)
    async getTeamCertificationStats(@CurrentUser() user: any) {
        const managerId = user?.user_id || user?.id;
        return this.certificationsService.getTeamCertificationStats(managerId);
    }
}
