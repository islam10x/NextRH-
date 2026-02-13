import {
    Controller,
    Post,
    Body,
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
import { CvService } from './cv.service';

@Controller('cv')
export class CvController {
    constructor(private readonly cvService: CvService) { }

    /**
     * Your Logic: Endpoint for AI parsing service to send structured data
     */
    @Post('process')
    async processCv(@Body() body: { userId: string, data: any }) {
        return this.cvService.processCvData(body.userId, body.data);
    }

    /**
     * Rania's Logic: Endpoint for employees to upload CV files
     */
    @Post('upload')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.EMPLOYEE)
    @UseInterceptors(
        FileInterceptor('file', {
            limits: { fileSize: 10 * 1024 * 1024 },
            fileFilter: (_req, file, cb) => {
                const allowed = [
                    'application/pdf',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'image/png',
                    'image/jpeg',
                ];
                if (!allowed.includes(file.mimetype)) {
                    return cb(new BadRequestException('Unsupported file type'), false);
                }
                return cb(null, true);
            },
        })
    )
    async uploadCv(
        @UploadedFile(
            new ParseFilePipeBuilder()
                .addMaxSizeValidator({ maxSize: 10 * 1024 * 1024 })
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

        const userId = user.user_id || user.id;
        return this.cvService.saveEmployeeCv(userId, file);
    }
}
