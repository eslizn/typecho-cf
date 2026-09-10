import type { APIRoute } from 'astro';
import { getDb } from '@/db';
import { loadOptions } from '@/lib/options';
import { getRequestCoreContextFromLocals, getClientIp } from '@/lib/context';
import { parseActivatedPlugins, setActivatedPlugins } from '@/lib/plugin';
import { INCOMING_FEEDBACK_RATE_LIMIT, saveIncomingFeedback } from '@/lib/incoming-feedback';
import { trackSlidingWindow } from '@/lib/login-rate-limit';
import { env } from 'cloudflare:workers';
import { InputError, readBoundedFormData } from '@/lib/input';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);
  const pluginCtx = core?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  if (!core) await setActivatedPlugins(pluginCtx, parseActivatedPlugins(options.activatedPlugins as string | undefined));
  let form: FormData;
  try { form = await readBoundedFormData(request, REQUEST_BODY_LIMITS.publicForm); }
  catch (error) { return new Response(error instanceof Error ? error.message : 'invalid', { status: error instanceof InputError ? error.status : 400 }); }
  const url = String(form.get('url') || '').trim();
  // Unauthenticated public endpoint: throttle per IP before touching D1.
  const ip = getClientIp(request);
  if (!trackSlidingWindow(`trackback:${ip}`, INCOMING_FEEDBACK_RATE_LIMIT)) {
    return new Response('rate-limited', {
      status: 429,
      headers: { 'Retry-After': String(INCOMING_FEEDBACK_RATE_LIMIT.windowSeconds) },
    });
  }
  const result = await saveIncomingFeedback(db, pluginCtx, options, {
    cid: Number.parseInt(params.cid || '0', 10), author: String(form.get('blog_name') || form.get('title') || '匿名'),
    mail: '', url, text: String(form.get('excerpt') || ''), type: 'trackback',
    ip, agent: request.headers.get('user-agent') || '',
  });
  if (result instanceof Response) return result;
  return new Response('<response><error>0</error></response>', { headers: { 'content-type': 'text/xml; charset=utf-8' } });
};
