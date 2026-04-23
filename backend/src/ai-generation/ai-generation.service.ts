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
        this.httpService.post(
          'http://localhost:11434/api/generate',
          {
            model: 'qwen2.5:1.5b-instruct',
            prompt,
            stream: false,
          },
          {
            // Prevent long request stalls from blocking callers.
            timeout: 10000,
          },
        ),
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
    let projects: Array<{
      projectId: string;
      projectName: string;
      projectDescription: string;
    }> = [];
    try {
      // Raw select avoids selecting non-required columns (for example project_type)
      // and keeps the scheduler resilient on older schemas.
      projects = await this.projectRepository.query(
        `
          SELECT
            p.project_id AS "projectId",
            p.project_name AS "projectName",
            p.project_description AS "projectDescription"
          FROM projects p
          WHERE LOWER(p.project_name) = $1
            AND p.generated_title IS NULL
            AND p.project_description IS NOT NULL
            AND p.project_description <> ''
        `,
        ['unknown project'],
      );
    } catch (err: any) {
      this.logger.warn(
        `Backfill query skipped due to schema mismatch: ${err?.message ?? err}`,
      );
      return;
    }

    if (projects.length === 0) return;

    this.logger.log(
      `Backfill: found ${projects.length} project(s) without generated title`,
    );

    for (const project of projects) {
      try {
        const description = String(project.projectDescription || '').trim();
        if (!description) continue;

        const title = await this.generateProjectTitle(description);
        await this.projectRepository
          .createQueryBuilder()
          .update(Project)
          .set({ generatedTitle: title })
          .where('project_id = :projectId', { projectId: project.projectId })
          .andWhere('generated_title IS NULL')
          .execute();

        this.logger.log(
          `Generated title for project ${project.projectId}: "${title}"`,
        );
      } catch (err) {
        this.logger.warn(
          `Backfill failed for project ${project.projectId}: ${err?.message ?? err}`,
        );
      }
    }
  }
}
