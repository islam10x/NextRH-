import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from './entities/project.entity';
import { ProjectParticipant } from './entities/participant.entity';

@Module({
    imports: [TypeOrmModule.forFeature([Project, ProjectParticipant])],
})
export class ProjectsModule { }
