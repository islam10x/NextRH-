import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User, UserStatus } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
    constructor(
        @InjectRepository(User)
        private readonly usersRepository: Repository<User>,
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
        const whereClause = managerId ? { invitedBy: managerId } : {};
        return this.usersRepository.find({
            where: whereClause,
            select: ['user_id', 'email', 'firstName', 'lastName', 'role', 'status', 'createdAt', 'updatedAt', 'invitedBy'],
        });
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
    }

    async validatePassword(plainPassword: string, hashedPassword: string): Promise<boolean> {
        return bcrypt.compare(plainPassword, hashedPassword);
    }
}
