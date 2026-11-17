import { AppController } from './app.controller';

describe('Edge AppController', () => {
  let controller: AppController;

  beforeEach(() => {
    jest.useFakeTimers();
    controller = new AppController();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reports edge service health', () => {
    expect(controller.getHealth()).toEqual({
      status: 'ok',
      service: 'pravah-edge',
      timestamp: expect.any(String),
    });
  });

  it('refreshes the timestamp every second', () => {
    const first = controller.getHealth().timestamp;

    jest.advanceTimersByTime(1000);

    expect(controller.getHealth().timestamp).not.toBe(first);
  });
});
