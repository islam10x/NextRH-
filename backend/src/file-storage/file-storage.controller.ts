import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '../users/entities/user.entity';
import { FileStorageService } from './file-storage.service';

@Controller('file-storage')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FileStorageController {
    constructor(private readonly fileStorageService: FileStorageService) { }

    @Get('metadata/me')
    @Roles(UserRole.EMPLOYEE)
    async getMyMetadata(@CurrentUser() user: any) {
        const userId = user.user_id || user.id;
        return this.fileStorageService.getEmployeeMetadata(userId);
    }
}
