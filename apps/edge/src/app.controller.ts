import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  private cachedHealth = {
    status: 'ok',
    service: 'pravah-edge',
    timestamp: new Date().toISOString(),
  };

  constructor() {
    setInterval(() => {
      this.cachedHealth.timestamp = new Date().toISOString();
    }, 1000);
  }

  @Get('health')
  getHealth() {
    return this.cachedHealth;
  }
}

