import { handle } from '@astrojs/cloudflare/handler';
import 'virtual:typecho-plugin-registry';
import { queue, scheduled } from '@/plugins/typecho-plugin-queue/worker-events';

const worker = {
  fetch: handle,
  scheduled,
  queue,
};

export default worker satisfies ExportedHandler<Env>;
