import { AppService } from './app.service';

describe('AppService', () => {
  it('reports the core service as healthy with a timestamp', () => {
    const service = new AppService();

    expect(service.getHealth()).toEqual({
      status: 'ok',
      service: 'pravah-core',
      timestamp: expect.any(String) as string,
    });
  });
});
