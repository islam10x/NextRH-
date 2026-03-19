import { Injectable, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User, UserStatus } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { RagService } from '../rag/rag.service';

@Injectable()
export class UsersService {
    private readonly logger = new Logger(UsersService.name);
    constructor(
        @InjectRepository(User)
        private readonly usersRepository: Repository<User>,
        private readonly ragService: RagService,
    ) { }

    async create(createUserDto: CreateUserDto): Promise<User> {
        // Check if user already exists
        const existingUser = await this.usersRepository.findOne({
            where: { email: createUserDto.email },
        });

        if (existingUser) {
            throw new ConflictException('User with this email already exists');
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

    async findAll(managerId?: string): Promise<User[]> {
        const query = this.usersRepository.createQueryBuilder('u')
            .select(['u.user_id', 'u.email', 'u.firstName', 'u.lastName', 'u.role', 'u.status', 'u.createdAt', 'u.updatedAt', 'u.invitedBy'])
            .leftJoin('team_members', 'tm', 'tm.employee_id = u.user_id')
            .leftJoin('teams', 't', 't.team_id = tm.team_id');
            
        if (managerId) {
            query.where('u.invitedBy = :managerId', { managerId })
                 .orWhere('t.manager_id = :managerId::uuid', { managerId });
        }

        return query.getMany();
    }

    async setCurrentRefreshToken(refreshToken: string, userId: string): Promise<void> {
        const currentHashedRefreshToken = await bcrypt.hash(refreshToken, 10);
        await this.usersRepository.update(userId, {
            currentHashedRefreshToken
        });
    }

    async getUserIfRefreshTokenMatches(refreshToken: string, userId: string): Promise<User | null> {
        const user = await this.usersRepository.findOne({
            where: { user_id: userId },
            select: [
                'user_id',
                'email',
                'firstName',
                'lastName',
                'role',
                'status',
                'currentHashedRefreshToken',
            ],
        });

        if (!user) {
            return null;
        }

        const isRefreshTokenMatching = await bcrypt.compare(
            refreshToken,
            user.currentHashedRefreshToken || ''
        );

        if (isRefreshTokenMatching) {
            return user;
        }

        return null;
    }

    async removeRefreshToken(userId: string): Promise<void> {
        return this.usersRepository.update(userId, {
            currentHashedRefreshToken: null!
        }).then(() => { });
    }

    async findById(id: string): Promise<User> {
        const user = await this.usersRepository.findOne({
            where: { user_id: id },
            select: ['user_id', 'email', 'firstName', 'lastName', 'role', 'status', 'createdAt', 'updatedAt'],
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        return user;
    }

    async findByEmail(email: string): Promise<User | null> {
        return this.usersRepository.findOne({
            where: { email },
        });
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
        await this.usersRepository.remove(user);
        try {
            await this.ragService.deleteUserVectors(user.user_id);
        } catch (error) {
            this.logger.warn(`Failed to delete RAG vectors for user ${user.user_id}: ${error?.message ?? error}`);
        }
    }

    async validatePassword(plainPassword: string, hashedPassword: string): Promise<boolean> {
        return bcrypt.compare(plainPassword, hashedPassword);
    }
}
