import {
    Controller,
    Get,
    Post,
    Body,
    Patch,
    Param,
    Delete,
    UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from './entities/user.entity';

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
        console.log('--- UsersController.findAll ---');
        console.log('Current User:', user);
        const userId = user.user_id || user.id;
        const managerId = user.role === UserRole.TEAM_MANAGER ? userId : undefined;
        console.log('Manager ID filter:', managerId);

        const result = await this.usersService.findAll(managerId);
        console.log('Result count:', result.length);
        return result;
    }

    // All authenticated users can view a single user
    @Get(':id')
    async findOne(@Param('id') id: string) {
        return this.usersService.findById(id);
    }

    // Only bid_manager can update users
    @Patch(':id')
    @Roles(UserRole.BID_MANAGER)
    async update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
        const user = await this.usersService.update(id, updateUserDto);
        // Exclude password from response
        const { password, ...result } = user;
        return result;
    }

    // Only bid_manager can delete users
    @Delete(':id')
    @Roles(UserRole.BID_MANAGER)
    async remove(@Param('id') id: string) {
        await this.usersService.remove(id);
        return { message: 'User deleted successfully' };
    }
}
