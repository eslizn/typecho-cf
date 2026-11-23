import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_QUEUE_NAME } from './binding';
import { readQueueProviderConfig } from './config';

describe('queue provider config', () => {
  it('defaults the display name and optional credentials', () => {
    expect(readQueueProviderConfig(undefined)).toEqual({
      queueName: DEFAULT_TASK_QUEUE_NAME,
      accountId: '',
      apiToken: '',
    });
    expect(readQueueProviderConfig({ queueName: '', accountId: '  ', apiToken: 42 })).toEqual({
      queueName: DEFAULT_TASK_QUEUE_NAME,
      accountId: '',
      apiToken: '',
    });
  });

  it('normalizes values saved from the plugin settings form', () => {
    expect(readQueueProviderConfig({
      queueName: ' custom-queue ',
      accountId: ' account-id ',
      apiToken: ' read-token ',
    })).toEqual({
      queueName: 'custom-queue',
      accountId: 'account-id',
      apiToken: 'read-token',
    });
  });

  it('ignores environment-style keys so configuration stays inside the plugin', () => {
    expect(readQueueProviderConfig({
      QUEUE_NAME: 'env-queue',
      CF_ACCOUNT_ID: 'env-account',
      CF_API_TOKEN: 'env-token',
    })).toEqual({
      queueName: DEFAULT_TASK_QUEUE_NAME,
      accountId: '',
      apiToken: '',
    });
  });
});
