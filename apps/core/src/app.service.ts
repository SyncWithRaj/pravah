import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHealth() {
    return {
      status: 'ok',
      service: 'pravah-core',
      timestamp: new Date().toISOString(),
    };
  }
}
