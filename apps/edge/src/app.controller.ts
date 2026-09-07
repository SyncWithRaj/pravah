import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      service: 'pravah-edge',
      timestamp: new Date().toISOString(),
    };
  }
}
