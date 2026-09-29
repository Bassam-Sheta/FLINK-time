/**
 * FLINK Time & Workforce Platform — Google Workspace Identity Service
 * Binds browser sessions to the server-observed Google account identity.
 *
 * Security rule:
 * - Never trust a client-supplied email as proof of identity.
 * - WEB sessions require Session.getActiveUser().getEmail().
 * - The observed email must exactly match the FLINK account Email.
 */
const IdentityService = {
  normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  },

  getCurrentGoogleEmail(required = true) {
    let email = '';
    try {
      if (
        typeof Session !== 'undefined' &&
        Session.getActiveUser
      ) {
        const activeUser = Session.getActiveUser();
        if (activeUser && activeUser.getEmail) {
          email = this.normalizeEmail(activeUser.getEmail());
        }
      }
    } catch (err) {
      if (!required) return '';
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Google Workspace identity could not be verified.',
        401
      );
    }

    if (!email && required) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Google Workspace sign-in is required to use FLINK Time.',
        401
      );
    }
    return email;
  },

  assertAccountIdentity(account, clientType = 'WEB') {
    const normalizedClient = String(clientType || 'WEB').toUpperCase();
    if (normalizedClient !== 'WEB' && normalizedClient !== 'SETUP_WIZARD') {
      return '';
    }

    const actualEmail = this.getCurrentGoogleEmail(true);
    const expectedEmail = this.normalizeEmail(account && account.Email);

    if (!expectedEmail || actualEmail !== expectedEmail) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Google Workspace identity does not match this FLINK account.',
        401
      );
    }
    return actualEmail;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IdentityService };
}
