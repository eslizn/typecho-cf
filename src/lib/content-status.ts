/**
 * Content status policy shared by the admin write endpoints.
 *
 * Mirrors PHP Typecho's `Widget\Contents\EditTrait::checkStatus()`: editors
 * choose the visibility, while contributors can only submit posts for review
 * (`waiting`) and never keep a content password. Page writes are editor-only
 * and are checked by the callers before this policy is applied.
 */
export type ContentKind = 'post' | 'page';

export interface ContentWritePolicyInput {
  kind: ContentKind;
  isEditor: boolean;
  isDraft: boolean;
  visibility: string;
  password: string | null;
}

export interface ContentWritePolicyResult {
  status: string;
  password: string | null;
}

const EDITOR_VISIBILITIES = new Set(['publish', 'hidden', 'private', 'waiting']);

export function resolveContentWritePolicy(
  input: ContentWritePolicyInput,
): ContentWritePolicyResult {
  if (input.kind === 'page') {
    // The page form only offers publish/hidden. Password handling is left to
    // the caller because the page editor does not submit the field and an
    // existing password must survive an unrelated page edit.
    return {
      status: input.visibility === 'hidden' ? 'hidden' : 'publish',
      password: input.password,
    };
  }

  if (!input.isEditor) {
    return { status: 'waiting', password: null };
  }

  if (input.isDraft) {
    // Editors keep Typecho-CF's draft workflow (a revision/draft row), while
    // contributors are forced to `waiting` above.
    return { status: 'draft', password: input.password };
  }

  if (EDITOR_VISIBILITIES.has(input.visibility)) {
    return { status: input.visibility, password: null };
  }

  // `password` publishes with the submitted password; empty/legacy values
  // publish with no password. This matches Typecho's checkStatus branches.
  return {
    status: 'publish',
    password: input.visibility === 'password' ? input.password : null,
  };
}
