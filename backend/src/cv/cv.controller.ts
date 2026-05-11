import {
    Controller,
    Post,
    Get,
    Body,
    UseGuards,
    UseInterceptors,
    UploadedFile,
    BadRequestException,
    ParseFilePipeBuilder,
    HttpStatus,
    Param,
    Res,
    Query,
} from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '../users/entities/user.entity';
import { CvService } from './cv.service';
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_BYTES } from '../file-validation/file-validation.constants';

@Controller('cv')
export class CvController {
    constructor(private readonly cvService: CvService) { }

    /**
     * Returns the full parsed CV profile for the currently logged-in employee.
     */
    @Get('profile/me')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
    async getMyProfile(@CurrentUser() user: any) {
        const userId = user.user_id || user.id;
        return this.cvService.getMyProfile(userId);
    }

    /**
     * Your Logic: Endpoint for AI parsing service to send structured data
     */
    @Post('process')
    async processCv(@Body() body: { userId: string, data: any }) {
        return this.cvService.processCvData(body.userId, body.data);
    }

    /**
     * One-time backfill: populate project dates from stored metadata.json files
     */
    @Post('backfill-project-dates')
    async backfillProjectDates() {
        return this.cvService.backfillProjectDates();
    }

    /**
     * Rania's Logic: Endpoint for employees to upload CV files
     */
    @Post('upload')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
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
    async uploadCv(
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

        const userId = user.user_id || user.id;
        return this.cvService.saveEmployeeCv(userId, file);
    }

    /**
     * Endpoint for managers to view employee CV profiles by employee ID
     */
    @Get('profile/:employeeId')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
    async getEmployeeProfile(@Param('employeeId') employeeId: string) {
        return this.cvService.getMyProfile(employeeId);
    }

    /**
     * Generate a CV from an uploaded template file for a given employee.
     * The template's layout is preserved and personal data is replaced.
     * @param format - Output format: 'docx' (default) or 'pdf' (for preview)
     */
    @Post('generate')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.BID_MANAGER, UserRole.TEAM_MANAGER)
    @UseInterceptors(
        FileInterceptor('template', {
            limits: { fileSize: MAX_UPLOAD_BYTES },
            fileFilter: (_req, file, cb) => {
                const allowed = [
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'application/pdf',
                ];
                if (!allowed.includes((file.mimetype || '').toLowerCase())) {
                    return cb(new BadRequestException('Template must be .docx or .pdf format'), false);
                }
                return cb(null, true);
            },
        }),
    )
    async generateCv(
        @UploadedFile() template: Express.Multer.File,
        @Body('employeeId') employeeId: string,
        @Query('format') format: string,
        @Query('language') language: string,
        @Query('engine') engine: string,
        @CurrentUser() user: any,
        @Res() res: Response,
    ) {
        console.error('====================================================');
        console.error(`[HEARTBEAT] GENERATING CV FOR EMPLOYEE: ${employeeId}`);
        console.error('====================================================');

        if (!template) {
            throw new BadRequestException('Template file is required');
        }
        if (!employeeId) {
            throw new BadRequestException('employeeId is required');
        }

        // Basic UUID format check to catch obvious typos early
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(employeeId)) {
            throw new BadRequestException('employeeId must be a valid UUID');
        }

        const outputFormat = format === 'pdf' ? 'pdf' : 'docx';
        const normalizedLang = (language || '').toLowerCase();
        // Allow 'original' (no translation), 'fr', or 'en'. Anything else → 'en'.
        const targetLang =
            normalizedLang === 'original' || normalizedLang === 'fr' || normalizedLang === 'en'
                ? normalizedLang
                : 'en';
        const cvEngine = engine === 'fallback' ? 'fallback' : 'primary';
        const requestingUserId = user?.user_id || user?.id || null;
        const result = await this.cvService.generateCv(
            employeeId,
            template,
            outputFormat,
            targetLang,
            cvEngine,
            { requestingUserId },
        );

        const headers: Record<string, string | number> = {
            'Content-Type': result.mimeType,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(result.filename)}"`,
            'Content-Length': result.buffer.length,
            // Lets the browser read the custom warnings header from the
            // CORS-restricted blob response on the frontend.
            'Access-Control-Expose-Headers': 'X-CV-Warnings',
        };
        if (result.warnings) {
            headers['X-CV-Warnings'] = result.warnings;
        }
        res.set(headers);
        res.send(result.buffer);
    }

    /**
     * Generate a CV using a template the bid manager has previously used,
     * picked from their history (no file re-upload needed).
     */
    @Post('generate-from-history')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.BID_MANAGER, UserRole.TEAM_MANAGER)
    async generateFromHistory(
        @Body() body: { templateId: string; employeeId: string },
        @Query('format') format: string,
        @Query('language') language: string,
        @Query('engine') engine: string,
        @CurrentUser() user: any,
        @Res() res: Response,
    ) {
        console.error('====================================================');
        console.error(`[HEARTBEAT] GENERATING FROM HISTORY FOR EMPLOYEE: ${body?.employeeId}`);
        console.error('====================================================');
        if (!body?.templateId || !body?.employeeId) {
            throw new BadRequestException('templateId and employeeId are required');
        }
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(body.templateId) || !uuidRegex.test(body.employeeId)) {
            throw new BadRequestException('templateId and employeeId must be valid UUIDs');
        }

        const outputFormat = format === 'pdf' ? 'pdf' : 'docx';
        const normalizedLang = (language || '').toLowerCase();
        const targetLang =
            normalizedLang === 'original' || normalizedLang === 'fr' || normalizedLang === 'en'
                ? normalizedLang
                : 'en';
        const cvEngine = engine === 'fallback' ? 'fallback' : 'primary';
        const requestingUserId = user?.user_id || user?.id;
        if (!requestingUserId) {
            throw new BadRequestException('Authenticated user required');
        }

        const result = await this.cvService.generateCvFromHistory(
            requestingUserId,
            body.templateId,
            body.employeeId,
            outputFormat,
            targetLang,
            cvEngine,
        );

        const headers: Record<string, string | number> = {
            'Content-Type': result.mimeType,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(result.filename)}"`,
            'Content-Length': result.buffer.length,
            'Access-Control-Expose-Headers': 'X-CV-Warnings',
        };
        if (result.warnings) {
            headers['X-CV-Warnings'] = result.warnings;
        }
        res.set(headers);
        res.send(result.buffer);
    }

    /**
     * Generate a CV using another employee's stored CV as the template.
     * Applies the target employee's data onto the template employee's CV layout.
     * @param format - Output format: 'docx' (default) or 'pdf' (for preview)
     */
    @Post('generate-from-stored')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.BID_MANAGER, UserRole.TEAM_MANAGER)
    async generateFromStored(
        @Body() body: { templateEmployeeId: string; targetEmployeeId: string },
        @Query('format') format: string,
        @Query('language') language: string,
        @Res() res: Response,
    ) {
        if (!body.templateEmployeeId || !body.targetEmployeeId) {
            throw new BadRequestException('templateEmployeeId and targetEmployeeId are required');
        }

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(body.templateEmployeeId) || !uuidRegex.test(body.targetEmployeeId)) {
            throw new BadRequestException('templateEmployeeId and targetEmployeeId must be valid UUIDs');
        }

        const outputFormat = format === 'pdf' ? 'pdf' : 'docx';
        const targetLang = ['fr'].includes((language || '').toLowerCase())
            ? language.toLowerCase()
            : 'en';
        const result = await this.cvService.generateCvFromStoredTemplate(
            body.templateEmployeeId,
            body.targetEmployeeId,
            outputFormat,
            targetLang,
        );

        res.set({
            'Content-Type': result.mimeType,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(result.filename)}"`,
            'Content-Length': result.buffer.length,
        });
        res.send(result.buffer);
    }
}
