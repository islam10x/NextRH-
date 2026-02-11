import { Controller, Post, Body } from '@nestjs/common';
import { CvService } from './cv.service';

@Controller('cv')
export class CvController {
    constructor(private readonly cvService: CvService) { }

    @Post('process')
    async processCv(@Body() body: { userId: string, data: any }) {
        return this.cvService.processCvData(body.userId, body.data);
    }
}
