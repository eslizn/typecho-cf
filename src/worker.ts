import { handle } from '@astrojs/cloudflare/handler';
import 'virtual:typecho-plugin-registry';
import { runScheduledTasks } from '@/lib/tasks/scheduler';
import { consumeTaskBatch } from '@/lib/tasks/runtime';

const worker = {
  fetch: handle,
  scheduled: runScheduledTasks,
  queue: consumeTaskBatch,
};

export default worker satisfies ExportedHandler<Env>;
