/** Core keys are kept in one list so the English catalog cannot silently
 * drift behind the server-rendered core UI. Add a key here before using it
 * from core code. */
export const CORE_TRANSLATION_KEYS = [
  'core.locale.auto',
  'core.locale.zhCN',
  'core.locale.en',
  'core.error.forbidden',
  'core.error.notFound',
  'core.error.server',
  'core.error.serviceUnavailable',
  'feed.untitled',
  'feed.anonymous',
  'feed.comments.title',
  'feed.comments.description',
  'feed.comment.title',
  'feed.category.title',
  'feed.tag.title',
  'feed.author.title',
  'feed.user',
  'mail.untitled',
  'mail.anonymous',
  'mail.comment.subject',
  'mail.comment.intro',
  'mail.comment.view',
  'mail.comment.replySubject',
  'mail.comment.replyIntro',
  'mail.reset.subject',
  'mail.reset.greeting',
  'mail.reset.instructions',
  'mail.reset.expiry',
  'mail.reset.ignore',
] as const;

export type CoreTranslationKey = typeof CORE_TRANSLATION_KEYS[number];
