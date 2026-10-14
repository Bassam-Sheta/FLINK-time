'use strict';

// Generate role portals from their complete rendered source. Only byte-identical
// sections are shared; role-specific differences stay in their original files.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../apps-script');
const names = ['User', 'Admin', 'SuperAdmin'];
const sources = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(root, name + '.html'), 'utf8')]));
const context = vm.createContext({ console, HtmlService: {
  createHtmlOutputFromFile: name => ({ getContent: () => sources[name] })
} });
vm.runInContext(fs.readFileSync(path.join(root, 'Code.gs'), 'utf8'), context);
function sections(html) {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const starts = Array.from(script.matchAll(/^    (?:async )?function ([A-Za-z0-9_]+)\(/gm));
  return { styles: style, ...Object.fromEntries(starts.map((match, index) =>
    [match[1], script.slice(match.index, index + 1 < starts.length ? starts[index + 1].index : script.length)])) };
}
const canonical = sections(sources.User);
const metrics = [];
for (const name of ['Admin', 'SuperAdmin']) {
  const before = context.renderPortalHtml_(name);
  let after = before;
  for (const [key, body] of Object.entries(sections(before))) {
    if (body !== canonical[key]) continue;
    if (key === 'styles') after = after.replace('<style>' + body + '</style>', '<style>/* FLINK_SHARED:styles */</style>');
    else {
      if (after.split(body).length !== 2) throw new Error('Ambiguous shared section: ' + key);
      after = after.replace(body, '/* FLINK_SHARED:' + key + ' */\n');
    }
  }
  sources[name] = after;
  if (context.renderPortalHtml_(name) !== before) throw new Error(name + ' rendered output changed; no files written');
  metrics.push({ name, beforeLines: before.trimEnd().split(/\r?\n/).length, afterLines: after.trimEnd().split(/\r?\n/).length });
}
// All output comparisons must pass before writing either generated role file.
for (const name of ['Admin', 'SuperAdmin']) fs.writeFileSync(path.join(root, name + '.html'), sources[name]);
console.log(JSON.stringify(metrics, null, 2));
