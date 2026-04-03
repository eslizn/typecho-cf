import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

// ==================== Users ====================
export const users = sqliteTable('typecho_users', {
  uid: integer('uid').primaryKey({ autoIncrement: true }),
  name: text('name'),
  password: text('password'),
  mail: text('mail'),
  url: text('url'),
  screenName: text('screenName'),
  created: integer('created').default(0),
  activated: integer('activated').default(0),
  logged: integer('logged').default(0),
  group: text('group').default('visitor'),
  authCode: text('authCode'),
}, (table) => [
  uniqueIndex('typecho_users_name').on(table.name),
  uniqueIndex('typecho_users_mail').on(table.mail),
]);

// ==================== Contents ====================
export const contents = sqliteTable('typecho_contents', {
  cid: integer('cid').primaryKey({ autoIncrement: true }),
  title: text('title'),
  slug: text('slug'),
  created: integer('created').default(0),
  modified: integer('modified').default(0),
  text: text('text'),
  order: integer('order').default(0),
  authorId: integer('authorId').default(0),
  template: text('template'),
  type: text('type').default('post'),
  status: text('status').default('publish'),
  password: text('password'),
  commentsNum: integer('commentsNum').default(0),
  allowComment: text('allowComment').default('0'),
  allowPing: text('allowPing').default('0'),
  allowFeed: text('allowFeed').default('0'),
  parent: integer('parent').default(0),
}, (table) => [
  uniqueIndex('typecho_contents_slug').on(table.slug),
  index('typecho_contents_created').on(table.created),
]);

// ==================== Comments ====================
export const comments = sqliteTable('typecho_comments', {
  coid: integer('coid').primaryKey({ autoIncrement: true }),
  cid: integer('cid').default(0),
  created: integer('created').default(0),
  author: text('author'),
  authorId: integer('authorId').default(0),
  ownerId: integer('ownerId').default(0),
  mail: text('mail'),
  url: text('url'),
  ip: text('ip'),
  agent: text('agent'),
  text: text('text'),
  type: text('type').default('comment'),
  status: text('status').default('approved'),
  parent: integer('parent').default(0),
}, (table) => [
  index('typecho_comments_cid').on(table.cid),
  index('typecho_comments_created').on(table.created),
]);

// ==================== Metas (Categories & Tags) ====================
export const metas = sqliteTable('typecho_metas', {
  mid: integer('mid').primaryKey({ autoIncrement: true }),
  name: text('name'),
  slug: text('slug'),
  type: text('type').notNull(),
  description: text('description'),
  count: integer('count').default(0),
  order: integer('order').default(0),
  parent: integer('parent').default(0),
}, (table) => [
  index('typecho_metas_slug').on(table.slug),
]);

// ==================== Relationships (Content <-> Meta) ====================
export const relationships = sqliteTable('typecho_relationships', {
  cid: integer('cid').notNull(),
  mid: integer('mid').notNull(),
}, (table) => [
  uniqueIndex('typecho_relationships_cid_mid').on(table.cid, table.mid),
]);

// ==================== Options ====================
export const options = sqliteTable('typecho_options', {
  name: text('name').notNull(),
  user: integer('user').notNull().default(0),
  value: text('value'),
}, (table) => [
  uniqueIndex('typecho_options_name_user').on(table.name, table.user),
]);

// ==================== Fields ====================
export const fields = sqliteTable('typecho_fields', {
  cid: integer('cid').notNull(),
  name: text('name').notNull(),
  type: text('type').default('str'),
  str_value: text('str_value'),
  int_value: integer('int_value').default(0),
  float_value: real('float_value').default(0),
}, (table) => [
  uniqueIndex('typecho_fields_cid_name').on(table.cid, table.name),
  index('typecho_fields_int_value').on(table.int_value),
  index('typecho_fields_float_value').on(table.float_value),
]);
