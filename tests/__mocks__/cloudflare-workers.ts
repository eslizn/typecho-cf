/**
 * Mock for `cloudflare:workers` module — provides stubs for the Cloudflare
 * Workers runtime environment so unit tests can run in Node.js.
 */

// Mock caches API (used for edge caching)
class MockCache {
  private store = new Map<string, Response>();

  async match(request: Request | string): Promise<Response | undefined> {
    const key = typeof request === 'string' ? request : request.url;
    return this.store.get(key);
  }

  async put(request: Request | string, response: Response): Promise<void> {
    const key = typeof request === 'string' ? request : request.url;
    this.store.set(key, response.clone());
  }

  async delete(request: Request | string): Promise<boolean> {
    const key = typeof request === 'string' ? request : request.url;
    return this.store.delete(key);
  }

  /** Internal method for test cleanup */
  _reset() {
    this.store.clear();
  }
}

const mockCache = new MockCache();

export const caches = {
  default: mockCache,
};

export const env = {
  DB: null as any,
  BUCKET: null as any,
};

// Export internal reset for test cleanup
export const _resetCaches = () => {
  mockCache._reset();
};
