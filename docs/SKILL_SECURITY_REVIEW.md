# Skill security review — 2026-10-06

Scope: the complete local text of Google Apps Script, security/hardening (including
its bundled patterns), test-driven development, systematic debugging, Playwright,
UI review and frontend design skills. These are instructions, not app dependencies.

Selected for this work: Google Apps Script, security/hardening, test-driven
development, systematic debugging, Playwright, and UI review. They are already
installed globally. Frontend design is reserved for requested visual changes.

Findings:
- The selected compact skills have no scripts, binaries, installers or network
  hooks. Their official-document links are reference material, not executable
  instructions. No permission/provider/MCP configuration change is required.
- The generic security patterns include Express cookies/headers, Redis examples
  and a denylist-based response example. These do not fit this platform; the skill's
  local qualifications correctly prohibit copying them into Apps Script and require
  output allowlists. Use the platform-specific skill first.
- The referenced shared security checklist is not included in the inspected
  package. It is missing evidence, not an audited resource.
- Frontend design asserts prior user aesthetic preferences that are not established
  here. Those assertions must not override this user's actual requirements.

Installation decision: retain the existing relevant skills and add the small,
locally authored `flink-workspace-reliability` project skill after reviewing its
entire proposed text. It contains only a task workflow and official reference
links: no scripts, external catalogs, plugins, secrets, permissions changes,
telemetry, downloads or automatic updates. Its distinct ID does not override the
existing skills. OpenCode V2 discovery was checked against
<https://opencode.ai/v2/docs/skills>.

Installed project skill SHA-256 (LF file):
`6b1dfad754c28ca6c31c92e43cf899bd9f6c7f6d535d2ae373bc3aaac6edc13a`.
Discovery and loading succeeded through the harness skill tool.

This is a point-in-time content review, not proof that instructions can never lead
to a mistake. Re-review any future file/hash change; no marketplace bundle has
been installed or declared safe without inspection.
