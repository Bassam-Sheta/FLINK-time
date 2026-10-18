'use strict';

/**
 * Minimal renderer for Google Apps Script HTML templates.
 *
 * Apps Script templates support:
 *   <? statement ?>   run a statement
 *   <?= expression ?> print the HTML-escaped value
 *   <?!= expression ?> print the raw value
 *
 * Test-only helper: it mirrors those scriptlet semantics so a merged portal can be
 * rendered per view without deploying to Apps Script. The template source is this
 * repository's own committed file, never untrusted input.
 */

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPortal(source, variables = {}) {
  const parts = [];
  const pattern = /<\?([\s\S]*?)\?>/g;
  let index = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    parts.push({ type: 'text', value: source.slice(index, match.index) });
    const scriptlet = match[1];
    if (scriptlet.startsWith('=')) parts.push({ type: 'expr', value: scriptlet.slice(1) });
    else if (scriptlet.startsWith('!=')) parts.push({ type: 'raw', value: scriptlet.slice(2) });
    else parts.push({ type: 'code', value: scriptlet });
    index = match.index + match[0].length;
  }
  parts.push({ type: 'text', value: source.slice(index) });

  let body = 'let __out = "";\n';
  for (const part of parts) {
    if (part.type === 'text') body += '__out += ' + JSON.stringify(part.value) + ';\n';
    else if (part.type === 'expr') body += '__out += __escape(' + part.value + ');\n';
    else if (part.type === 'raw') body += '__out += String(' + part.value + ');\n';
    else body += part.value + '\n';
  }
  body += 'return __out;';

  const render = new Function('__escape', 'vars', 'with (vars) { ' + body + ' }');
  return render(escapeHtml, variables);
}

module.exports = { renderPortal, escapeHtml };
