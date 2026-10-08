import { CacheService } from './cache.service';
import { createClient } from 'redis';

jest.mock('redis', () => ({ createClient: jest.fn() }));
describe('Redis bounded failure and recovery', () => {
  const client = {
    on: jest.fn(),
    connect: jest.fn(),
    quit: jest.fn(),
    destroy: jest.fn(),
    get: jest.fn(),
    isOpen: true,
    isReady: true,
  };
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
    client.isReady = true;
    client.isOpen = true;
    client.connect.mockResolvedValue(undefined);
    (createClient as jest.Mock).mockReturnValue(client);
  });
  it('bounds a stalled command, drops pending work and reconnects without replay', async () => {
    const service = new CacheService();
    client.get.mockReturnValue(new Promise(() => undefined));
    const result = expect(service.get('fixture')).rejects.toThrow(
      'Redis unavailable',
    );
    await jest.advanceTimersByTimeAsync(2000);
    await result;
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    client.get.mockResolvedValue('recovered');
    expect(await service.get('fixture')).toBe('recovered');
    jest.useRealTimers();
  });
  it('fails immediately while disconnected and bounds shutdown', async () => {
    const service = new CacheService();
    client.isReady = false;
    await expect(service.get('fixture')).rejects.toThrow('Redis unavailable');
    expect(client.get).not.toHaveBeenCalled();
    client.quit.mockReturnValue(new Promise(() => undefined));
    const close = service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(2000);
    await close;
    expect(client.destroy).toHaveBeenCalled();
    jest.useRealTimers();
  });
  it('does not wait indefinitely for startup', async () => {
    client.connect.mockReturnValue(new Promise(() => undefined));
    const startup = new CacheService().onModuleInit();
    await jest.advanceTimersByTimeAsync(3000);
    await startup;
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        disableOfflineQueue: true,
        commandsQueueMaxLength: 100,
      }),
    );
    jest.useRealTimers();
  });
});
