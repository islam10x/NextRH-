import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Project } from '../projects/entities/project.entity';

@Injectable()
export class AIGenerationService {
  private readonly logger = new Logger(AIGenerationService.name);

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
  ) {}

  async generateProjectTitle(description: string): Promise<string> {
    const prompt = `Return only a short professional CV project title (max 8 words, no explanation, no quotes) for this project description: "${description}"`;

    try {
      const response: any = await firstValueFrom(
        this.httpService.post('http://localhost:11434/api/generate', {
          model: 'qwen2.5:1.5b-instruct',
          prompt,
          stream: false,
        }),
      );

      // Extract the title and strip surrounding quotes or extra whitespace
      let title: string = (response.data?.response ?? '').trim();
      title = title.replace(/^["']|["']$/g, ''); // remove leading/trailing quotes
      title = title.split('\n')[0].trim();        // take only the first line

      if (!title) {
        throw new Error('Empty response from Ollama');
      }

      return title;
    } catch (error) {
      console.error('Error generating title with Ollama:', error?.message ?? error);
      // Fallback: derive a short title from the first ~8 words of the description
      const words = description.trim().split(/\s+/);
      return words.slice(0, 8).join(' ') + (words.length > 8 ? '...' : '');
    }
  }

  /**
   * Generate a title for a project and persist it to the DB.
   * Only generates if the project name is "Unknown Project" and no title exists yet.
   */
  async generateAndStoreTitle(project: Project): Promise<Project> {
    if (
      project.projectName?.toLowerCase() !== 'unknown project' ||
      project.generatedTitle
    ) {
      return project;
    }

    const description = project.projectDescription;
    if (!description) {
      return project;
    }

    const title = await this.generateProjectTitle(description);
    project.generatedTitle = title;
    await this.projectRepository.save(project);
    this.logger.log(
      `Generated title for project ${project.project_id}: "${title}"`,
    );
    return project;
  }

  /**
   * Background cron job: scans projects named "Unknown Project" that lack a
   * generated title and fills them in. Runs every 5 minutes.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async backfillMissingTitles(): Promise<void> {
    const projects = await this.projectRepository
      .createQueryBuilder('p')
      .where('LOWER(p.project_name) = :name', { name: 'unknown project' })
      .andWhere('p.generated_title IS NULL')
      .andWhere('p.project_description IS NOT NULL')
      .andWhere("p.project_description != ''")
      .getMany();

    if (projects.length === 0) return;

    this.logger.log(
      `Backfill: found ${projects.length} project(s) without generated title`,
    );

    for (const project of projects) {
      try {
        await this.generateAndStoreTitle(project);
      } catch (err) {
        this.logger.warn(
          `Backfill failed for project ${project.project_id}: ${err?.message ?? err}`,
        );
      }
    }
  }
}
