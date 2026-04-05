import {
    Controller,
    Post,
    Get,
    Param,
    Query,
    Body,
    UseGuards,
    Res,
    StreamableFile,
    BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CvGenerationService } from './cv-generation.service';
import { GenerateCvDto } from './dto/generate-cv.dto';
import { createReadStream } from 'fs';
import type { Response } from 'express';

@Controller('cv-generation')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CvGenerationController {
    constructor(private readonly cvGenerationService: CvGenerationService) { }

    @Post()
    @Roles(UserRole.BID_MANAGER)
    async generate(@Body() dto: GenerateCvDto, @CurrentUser() user: any) {
        const userId = user?.user_id || user?.id;
        return this.cvGenerationService.generate(dto, userId);
    }

    @Get(':generatedId/download')
    @Roles(UserRole.BID_MANAGER)
    async download(
        @Param('generatedId') generatedId: string,
        @Query('format') format: 'docx' | 'pdf',
        @Res({ passthrough: true }) res: Response,
    ) {
        if (format !== 'docx' && format !== 'pdf') {
            throw new BadRequestException('format must be docx or pdf');
        }
        const file = await this.cvGenerationService.getGeneratedFile(generatedId, format);
        res.set({
            'Content-Type': file.mime,
            'Content-Disposition': `attachment; filename="${file.filename}"`,
        });
        return new StreamableFile(createReadStream(file.path));
    }
}
