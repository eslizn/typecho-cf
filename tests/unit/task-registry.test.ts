import { beforeEach, describe, expect, it } from 'vitest';
import {
  findTask,
  listScheduledTasks,
  registerAsyncTask,
  registerScheduledTask,
  resetTaskRegistry,
} from '@/lib/tasks/registry';

const handler = async () => ({ status: 'success' as const });

describe('task registry', () => {
  beforeEach(() => {
    resetTaskRegistry();
  });

  it('rejects duplicate registrations and cross-kind conflicts', () => {
    registerAsyncTask('plugin-a', { id: 'sync', handler });

    expect(() => registerAsyncTask('plugin-a', { id: 'sync', handler })).toThrow(/already registered/);
    expect(() => registerScheduledTask('plugin-a', {
      id: 'sync',
      schedule: '* * * * *',
      handler,
    })).toThrow(/already registered/);
  });

  it('precompiles scheduled cron and applies defaults', () => {
    const task = registerScheduledTask('plugin-a', {
      id: 'hourly',
      schedule: '*/5 * * * *',
      handler,
    });

    expect(task.concurrency).toBe(1);
    expect(task.timeoutSeconds).toBe(30);
    expect(task.compiledSchedule.matches({
      minute: 10,
      hour: 3,
      dayOfMonth: 1,
      month: 1,
      dayOfWeek: 1,
    })).toBe(true);
    expect(task.compiledSchedule.matches({
      minute: 11,
      hour: 3,
      dayOfMonth: 1,
      month: 1,
      dayOfWeek: 1,
    })).toBe(false);
  });

  it('filters scheduled tasks by active plugin ids', () => {
    registerScheduledTask('plugin-a', {
      id: 'one',
      schedule: '* * * * *',
      handler,
    });
    registerScheduledTask('plugin-b', {
      id: 'two',
      schedule: '* * * * *',
      handler,
    });
    registerAsyncTask('plugin-a', { id: 'request-only', handler });

    expect(listScheduledTasks(new Set(['plugin-b'])).map(task => task.pluginId)).toEqual(['plugin-b']);
    expect(findTask('plugin-a', 'request-only', 'scheduled')).toBeUndefined();
  });

  it('keeps task identities distinct when ids contain the delimiter', () => {
    const first = registerAsyncTask('plugin:a', { id: 'work', handler });
    const second = registerAsyncTask('plugin', { id: 'a:work', handler });

    expect(findTask('plugin:a', 'work', 'async')).toBe(first);
    expect(findTask('plugin', 'a:work', 'async')).toBe(second);
  });

  it('validates concurrency and timeout bounds', () => {
    expect(() => registerAsyncTask('plugin-a', {
      id: 'bad-concurrency',
      concurrency: 0,
      handler,
    })).toThrow(/concurrency/);
    expect(() => registerAsyncTask('plugin-a', {
      id: 'bad-timeout',
      timeoutSeconds: 301,
      handler,
    })).toThrow(/timeoutSeconds/);
  });
});
