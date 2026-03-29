import {
    Controller,
    Get,
    Post,
    Body,
    Patch,
    Param,
    Delete,
    UseGuards,
    UseInterceptors,
    UploadedFile,
    BadRequestException,
    ParseFilePipeBuilder,
    HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from './entities/user.entity';
import { UpdateMyProfileDto } from './dto/update-my-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
    constructor(private readonly usersService: UsersService) { }

    // Only bid_manager can create users
    @Post()
    @Roles(UserRole.BID_MANAGER)
    async create(@Body() createUserDto: CreateUserDto) {
        const user = await this.usersService.create(createUserDto);
        // Exclude password from response
        const { password, ...result } = user;
        return result;
    }

    // Bid managers see all, Team managers see only their invites
    @Get()
    @Roles(UserRole.BID_MANAGER, UserRole.TEAM_MANAGER)
    async findAll(@CurrentUser() user: any) {
        const userId = user.user_id || user.id;
        const managerId = user.role === UserRole.TEAM_MANAGER ? userId : undefined;
        return this.usersService.findAll(managerId);
    }

    @Get('me')
    async getMe(@CurrentUser() user: any) {
        return this.usersService.getOwnProfile(user.user_id || user.id);
    }

    @Patch('me/profile')
    async updateMyProfile(@CurrentUser() user: any, @Body() dto: UpdateMyProfileDto) {
        return this.usersService.updateOwnProfile(user.user_id || user.id, dto);
    }

    @Post('me/password')
    async changeMyPassword(@CurrentUser() user: any, @Body() dto: ChangePasswordDto) {
        return this.usersService.changePassword(user.user_id || user.id, dto);
    }

    @Post('me/avatar')
    @UseInterceptors(
        FileInterceptor('file', {
            limits: { fileSize: 5 * 1024 * 1024 },
            fileFilter: (_req, file, cb) => {
                const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
                if (!allowed.includes((file.mimetype || '').toLowerCase())) {
                    return cb(new BadRequestException('Unsupported avatar file type'), false);
                }
                return cb(null, true);
            },
        }),
    )
    async updateMyAvatar(
        @CurrentUser() user: any,
        @UploadedFile(
            new ParseFilePipeBuilder()
                .addMaxSizeValidator({ maxSize: 5 * 1024 * 1024 })
                .addFileTypeValidator({ fileType: /^image\/(png|jpeg|jpg|webp)$/i })
                .build({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }),
        )
        file: Express.Multer.File,
    ) {
        return this.usersService.updateAvatar(user.user_id || user.id, file);
    }

    // All authenticated users can view a single user
    @Get(':id')
    async findOne(@Param('id') id: string) {
        const user = await this.usersService.findById(id);
        return this.usersService.toSafeUser(user);
    }

    // Only bid_manager can update users
    @Patch(':id')
    @Roles(UserRole.BID_MANAGER)
    async update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
        const user = await this.usersService.update(id, updateUserDto);
        return this.usersService.toSafeUser(user);
    }

    // Only bid_manager can delete users
    @Delete(':id')
    @Roles(UserRole.BID_MANAGER)
    async remove(@Param('id') id: string) {
        await this.usersService.remove(id);
        return { message: 'User deleted successfully' };
    }
}
