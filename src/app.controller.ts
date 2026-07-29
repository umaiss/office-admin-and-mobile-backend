import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from './auth/decorators/public.decorator';
import { AppService } from './app.service';

@ApiTags('App')
@Controller({ version: '1' })
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'API root — confirms the service is reachable' })
  getHello(): string {
    return this.appService.getHello();
  }
}
