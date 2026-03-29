/**
 * Mock for `cloudflare:workers` module — provides stubs for the Cloudflare
 * Workers runtime environment so unit tests can run in Node.js.
 */

export const env = {
  DB: null as any,
  R2: null as any,
};
