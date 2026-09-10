/**
 * Structural guard for the shared admin editor bootstrap.
 *
 * write-post.astro and write-page.astro used to inline their own copies of the
 * editor jQuery (~380 lines each, and already drifting). The invariant is that
 * the bootstrap lives in exactly one place; this cannot be asserted by
 * rendering the pages (no DOM harness), so it asserts the single-source shape
 * directly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGES = ['src/pages/admin/write-post.astro', 'src/pages/admin/write-page.astro'];

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf-8');
}

describe('admin editor bootstrap', () => {
  it.each(PAGES)('%s renders the shared EditorScript component', (path) => {
    const contents = source(path);
    expect(contents).toContain("from '@/components/admin/EditorScript.astro'");
    expect(contents).toContain('<EditorScript messagesJson={editorMessagesJson} />');
  });

  it.each(PAGES)('%s no longer carries its own copy of the editor script', (path) => {
    const contents = source(path);
    expect(contents).not.toContain('Typecho.insertFileToEditor');
    expect(contents).not.toContain('pastableTextarea');
  });

  it('keeps the bootstrap in the component, parameterised by the message bundle', () => {
    const component = source('src/components/admin/EditorScript.astro');
    expect(component).toContain('<script type="application/json" id="editor-client-messages"');
    expect(component).toContain("JSON.parse(document.getElementById('editor-client-messages')");
    expect(component).not.toContain('= {messagesJson};');
    expect(component).not.toContain('editorMessagesJson');
    for (const vendor of ['hyperdown.js', 'pagedown.js', 'paste.js', 'purify.js', 'typecho-tags.js']) {
      expect(component).toContain(`/vendor/${vendor}`);
    }
  });

  it('never interpolates server data inside an is:inline script body', () => {
    // Astro emits the body of an `is:inline` script verbatim, so `{foo}` reaches
    // the browser as literal text: `const messages = {foo};` is an object-literal
    // shorthand that throws ReferenceError and kills every handler in the file.
    // The bytes must therefore travel in a JSON script tag and be parsed.
    for (const path of ['src/layouts/Admin.astro', 'src/components/admin/EditorScript.astro']) {
      const contents = source(path);
      expect(contents, path).not.toMatch(/const\s+\w+\s*=\s*\{[A-Za-z_$][\w$]*\};/);
      expect(contents, path).toContain('JSON.parse(document.getElementById(');
    }
  });
});
