import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AIGenerationService } from './ai-generation.service';
import { GenerateTitleDto } from './dto/generate-title.dto';

@Controller('ai-generation')
export class AIGenerationController {
  constructor(private readonly aiGenerationService: AIGenerationService) {}

  @Post('generate-title')
  @HttpCode(HttpStatus.OK)
  async generateTitle(@Body() generateTitleDto: GenerateTitleDto) {
    const { description } = generateTitleDto;
    const title = await this.aiGenerationService.generateProjectTitle(description);
    return { title };
  }
}
