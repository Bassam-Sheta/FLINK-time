'use strict';

/**
 * One call builds the world most v2 tests need: the fakes, a fake Turso attached to them, the Script Properties
 * the app reads for it, and the app loaded into a vm context.
 *
 *   const env = createEnv();
 *   env.run('Migrations.run_()');          // evaluate code inside the app context
 *   env.turso.db                           // the underlying SQLite, for seeding and inspection
 *   env.fakes                              // Session, clock, mail, fetch ...
 *
 * options.fakes  passed to createFakes()       options.turso  passed to createFakeTurso()
 */

const { createFakes } = require('./fakes');
const { createFakeTurso, TOKENS } = require('./fake-turso');
const { loadApp, runInApp } = require('./load-app');

function createEnv(options = {}) {
  const fakes = createFakes(options.fakes);
  const turso = createFakeTurso(options.turso);
  const origin = turso.attach(fakes);
  // Made-up values (BUILD_SPEC section 0, rule 6): the fake accepts exactly these two tokens.
  fakes.properties.set('TURSO_URL', origin);
  fakes.properties.set('TURSO_RW_TOKEN', TOKENS.rw);
  fakes.properties.set('TURSO_RO_TOKEN', TOKENS.ro);
  const ctx = loadApp({ fakes });

  // Answers the Nth call to Turso (counting from now) with a 503. With executeFirst the database really ran the
  // call first, so the work is done but the caller never learns it: the "unknown outcome" case.
  function breakNthCall(n, { executeFirst }) {
    const seen = { count: 0 };
    fakes.fetch.route(origin + '/', request => {
      seen.count += 1;
      if (seen.count === n) {
        if (executeFirst) turso.handleHttp(request);
        return { status: 503, body: 'upstream unavailable' };
      }
      return turso.handleHttp(request);
    }, { first: true });
  }

  return { ctx, fakes, turso, origin, run: code => runInApp(ctx, code), breakNthCall };
}

module.exports = { createEnv };
