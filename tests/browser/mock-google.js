(() => {
  const nowIso = () => new Date().toISOString();
  const recoveryCodes = () => Array.from({ length: 8 }, (_, index) => 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-0000-000' + (index + 1));
  const businessDate = '2026-09-29';
  const mockRole = String(window.__FLINK_MOCK_ROLE || 'USER').toUpperCase();
  const setupInitialized = window.__FLINK_MOCK_SETUP_INITIALIZED !== false;
  const state = {
    loggedOut: false,
    passwordChanged: false,
    activeTimer: null,
    timesheetStatus: 'OPEN',
    nextVersion: 2,
    calls: [],
    entries: [{
      entryId: 'E-100',
      projectId: 'P1',
      projectName: 'Client Portal',
      taskId: 'T1',
      taskName: 'Operations',
      description: 'Morning operations',
      startUtc: '2026-09-29T06:00:00.000Z',
      startUTC: '2026-09-29T06:00:00.000Z',
      endUtc: '2026-09-29T07:00:00.000Z',
      endUTC: '2026-09-29T07:00:00.000Z',
      startLocal: '2026-09-29 09:00',
      endLocal: '2026-09-29 10:00',
      businessDate,
      durationSeconds: 3600,
      durationFormatted: '01:00:00',
      approvalStatus: 'OPEN',
      status: 'ACTIVE',
      locked: false,
      billable: true,
      version: 1
    }]
  };
  window.__mockState = state;

  const workspaces = [
    { WorkspaceID: 'W1', WorkspaceName: 'Cairo Operations', Timezone: 'Africa/Cairo', Status: 'ACTIVE' },
    { WorkspaceID: 'W2', WorkspaceName: 'Cairo Support', Timezone: 'Africa/Cairo', Status: 'ACTIVE' }
  ];

  const user = () => {
    if (mockRole === 'ADMIN') {
      return {
        userId: 'U2',
        username: 'manager',
        displayName: 'Operations Manager',
        email: 'manager@example.test',
        role: 'ADMIN',
        status: 'ACTIVE',
        primaryWorkspaceId: 'W1',
        assignedWorkspaces: ['W1', 'W2'],
        mustChangePassword: false
      };
    }
    if (mockRole === 'SUPER_ADMIN') {
      return {
        userId: 'U0',
        username: 'rootadmin',
        displayName: 'System Owner',
        email: 'owner@example.test',
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        primaryWorkspaceId: 'W1',
        assignedWorkspaces: ['W1', 'W2'],
        mustChangePassword: false
      };
    }
    return {
      userId: 'U1',
      username: 'employee',
      displayName: 'Normal Employee',
      email: 'employee@example.test',
      role: 'USER',
      status: 'ACTIVE',
      primaryWorkspaceId: 'W1',
      assignedWorkspaces: ['W1', 'W2'],
      mustChangePassword: false
    };
  };

  const trackedSeconds = () =>
    state.entries.reduce((sum, entry) => sum + Number(entry.durationSeconds || 0), 0);

  const detailedEntry = entry => ({
    entryId: entry.entryId,
    userId: 'U1',
    userName: 'Normal Employee',
    projectId: entry.projectId,
    projectName: entry.projectName,
    taskId: entry.taskId,
    taskName: entry.taskName,
    description: entry.description,
    tags: '',
    startUTC: entry.startUTC || entry.startUtc,
    endUTC: entry.endUTC || entry.endUtc,
    businessDate: entry.businessDate || businessDate,
    startLocal: entry.startLocal || '2026-09-29 12:00',
    endLocal: entry.endLocal || '2026-09-29 12:02',
    timezone: 'Africa/Cairo',
    durationSeconds: entry.durationSeconds,
    durationFormatted: entry.durationFormatted || '00:02:00',
    billable: !!entry.billable,
    approvalStatus: entry.approvalStatus || 'OPEN',
    source: 'WEB',
    manual: false
  });

  async function handle(action, body) {
    state.calls.push({ action, body: JSON.parse(JSON.stringify(body || {})) });
    const payload = body && body.payload ? body.payload : {};
    const workspaceId = body && body.workspaceId ? body.workspaceId : 'W1';

    switch (action) {
      case 'setup.status':
        return {
          initialized: setupInitialized,
          currentStep: setupInitialized ? 9 : 0
        };

      case 'auth.login':
        if (payload.username !== 'employee' || payload.password !== 'demo-pass') {
          throw new Error('Invalid username or password.');
        }
        if (window.__TEST_ENROLLMENT) return { enrollmentRequired: true, sessionToken: 'ENROLLMENT-ONLY', user: user() };
        return {
          mfaRequired: true,
          mfaChallengeToken: 'MFA_U1_demo_challenge',
          userId: 'U1',
          clientType: 'WEB'
        };

      case 'auth.verifyMfa':
        if (payload.mfaChallengeToken !== 'MFA_U1_demo_challenge' || payload.code !== '123456') {
          throw new Error('Invalid two-factor authentication code.');
        }
        return { sessionToken: 'SESSION-1', expiresAt: nowIso(), user: user() };

      case 'auth.validateSession':
        return { user: user(), role: mockRole, enrollmentRequired: ['ENROLLMENT-ONLY', 'RECOVERY-ONLY'].includes(body.sessionToken) };

      case 'auth.recoverMfa':
        if (payload.password !== 'demo-pass' || payload.code !== recoveryCodes()[0]) throw new Error('Recovery verification failed.');
        return { enrollmentRequired: true, sessionToken: 'RECOVERY-ONLY', user: user() };

      case 'auth.regenerateRecoveryCodes':
        if (payload.currentPassword !== 'demo-pass' || payload.totpCode !== '123456') throw new Error('Fresh verification failed.');
        return { recoveryCodes: recoveryCodes() };

      case 'auth.requestPasswordRecovery':
        return { message: 'If recovery is available for your Google account, a code will be emailed to you.' };

      case 'auth.completePasswordRecovery':
        if (payload.code !== recoveryCodes()[0] || !payload.newPassword) throw new Error('Recovery verification failed.');
        return { ok: true, signInRequired: true, message: 'Password changed. Sign in and complete MFA.' };

      case 'setup.completeStep':
        if (payload.step === 1) return { enrollmentRequired: true, sessionToken: 'ENROLLMENT-ONLY', user: user() };
        return { ok: true };

      case 'auth.enrollMfa':
        if (payload.currentPassword !== 'demo-pass') throw new Error('Fresh password verification failed.');
        return { secret: 'SYNTHETIC-SETUP-KEY', expiresAt: new Date(Date.now() + 600000).toISOString() };

      case 'auth.confirmMfa':
        if (payload.code !== '123456') throw new Error('Invalid authenticator verification.');
        return { ok: true, sessionToken: 'MFA-VERIFIED', expiresAt: nowIso(), recoveryCodes: recoveryCodes() };

      case 'auth.changePassword':
        if (payload.oldPassword !== 'demo-pass' || !payload.newPassword) {
          throw new Error('Current password is incorrect.');
        }
        state.passwordChanged = true;
        return { sessionToken: 'SESSION-2', expiresAt: nowIso(), user: user() };

      case 'auth.logout':
        state.loggedOut = true;
        localStorage.setItem('flink_mock_server_logout', '1');
        return { ok: true };

      case 'workspaces.list':
        return workspaces;

      case 'dashboard.radar':
        return {
          timestampUTC: nowIso(),
          activeCount: state.activeTimer ? 1 : 0,
          workers: state.activeTimer ? [{
            timerId: state.activeTimer.timerId,
            userId: 'U1',
            userName: 'Normal Employee',
            workspaceId: state.activeTimer.workspaceId,
            workspaceName: workspaces.find(w => w.WorkspaceID === state.activeTimer.workspaceId).WorkspaceName,
            projectId: state.activeTimer.projectId,
            projectName: state.activeTimer.projectName,
            taskId: state.activeTimer.taskId,
            description: state.activeTimer.description,
            startedAtUTC: state.activeTimer.startedAtUTC,
            elapsedSeconds: 2,
            source: 'WEB'
          }] : []
        };

      case 'dashboard.overview': {
        const seconds = trackedSeconds();
        return {
          accessibleWorkspacesCount: 2,
          workspacesCount: 2,
          activeTimersCount: state.activeTimer ? 1 : 0,
          workingNow: [],
          todayTrackedHours: +(seconds / 3600).toFixed(2),
          weekTrackedHours: +(seconds / 3600).toFixed(2),
          currentBusinessDate: businessDate,
          currentWeekStart: '2026-09-27',
          currentWeekEnd: '2026-10-03',
          workspacePeriods: [],
          pendingApprovalsCount: 0,
          pendingRequestsCount: 0
        };
      }

      case 'projects.list':
        return workspaceId === 'W2'
          ? [{ ProjectID: 'P2', ProjectName: 'Support Queue', Status: 'ACTIVE' }]
          : [{ ProjectID: 'P1', ProjectName: 'Client Portal', Status: 'ACTIVE' }];

      case 'tasks.list':
        return payload.projectId === 'P2'
          ? [{ TaskID: 'T2', TaskName: 'Tickets', ProjectID: 'P2', Status: 'OPEN' }]
          : [{ TaskID: 'T1', TaskName: 'Operations', ProjectID: 'P1', Status: 'OPEN' }];

      case 'tags.list':
        return [{ TagID: 'TAG1', TagName: 'Standard', Status: 'ACTIVE' }];

      case 'timer.getActive':
        return state.activeTimer && state.activeTimer.workspaceId === workspaceId
          ? state.activeTimer
          : null;

      case 'timer.start':
        state.activeTimer = {
          timerId: 'TIMER-1',
          workspaceId,
          projectId: payload.projectId,
          projectName: payload.projectId === 'P2' ? 'Support Queue' : 'Client Portal',
          taskId: payload.taskId || '',
          description: payload.description || '',
          startedAtUTC: new Date(Date.now() - 2000).toISOString()
        };
        return state.activeTimer;

      case 'timer.stop': {
        if (!state.activeTimer) throw new Error('No active timer.');
        const timer = state.activeTimer;
        const entry = {
          entryId: 'E-' + (100 + state.entries.length),
          projectId: timer.projectId,
          projectName: timer.projectName,
          taskId: timer.taskId,
          taskName: timer.taskId === 'T2' ? 'Tickets' : 'Operations',
          description: timer.description,
          startUtc: timer.startedAtUTC,
          startUTC: timer.startedAtUTC,
          endUtc: nowIso(),
          endUTC: nowIso(),
          startLocal: '2026-09-29 12:00',
          endLocal: '2026-09-29 12:02',
          businessDate,
          durationSeconds: 120,
          durationFormatted: '00:02:00',
          approvalStatus: 'OPEN',
          status: 'ACTIVE',
          locked: false,
          billable: true,
          version: state.nextVersion++
        };
        state.entries.push(entry);
        state.activeTimer = null;
        return { entryId: entry.entryId, durationSeconds: 120 };
      }

      case 'entries.list':
        return state.entries.map(entry => ({ ...entry }));

      case 'entries.update': {
        const entry = state.entries.find(item => item.entryId === payload.entryId);
        if (!entry) throw new Error('Entry not found.');
        Object.assign(entry, payload.updates || {});
        entry.version = state.nextVersion++;
        return { ...entry };
      }

      case 'entries.delete':
        state.entries = state.entries.filter(item => item.entryId !== payload.entryId);
        return { ok: true };

      case 'timesheet.getWeekly':
        return {
          periodStart: '2026-09-27T00:00:00.000Z',
          periodEnd: '2026-10-03T23:59:59.999Z',
          status: state.timesheetStatus,
          dayLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
          rows: [{
            projectId: workspaceId === 'W2' ? 'P2' : 'P1',
            projectName: workspaceId === 'W2' ? 'Support Queue' : 'Client Portal',
            taskName: workspaceId === 'W2' ? 'Tickets' : 'Operations',
            days: [0, 0, trackedSeconds(), 0, 0, 0, 0],
            totalSeconds: trackedSeconds()
          }]
        };

      case 'timesheet.submit':
        state.timesheetStatus = 'SUBMITTED';
        state.entries = state.entries.map(entry => ({
          ...entry,
          approvalStatus: 'SUBMITTED',
          locked: true
        }));
        return { ok: true };

      case 'reports.detailed':
        return {
          workspaceId,
          totalCount: state.entries.length,
          entries: state.entries.map(detailedEntry)
        };

      case 'reports.summary': {
        const seconds = trackedSeconds();
        return {
          workspaceId,
          groupings: ['project'],
          totalEntries: state.entries.length,
          overall: {
            totalSeconds: seconds,
            billableSeconds: seconds,
            totalHours: +(seconds / 3600).toFixed(2),
            billableHours: +(seconds / 3600).toFixed(2)
          },
          groups: []
        };
      }

      default:
        throw new Error('Mock backend does not implement action: ' + action);
    }
  }

  function runner(successHandler, failureHandler, userObject) {
    return new Proxy({}, {
      get(_target, prop) {
        if (prop === 'withSuccessHandler') return fn => runner(fn, failureHandler, userObject);
        if (prop === 'withFailureHandler') return fn => runner(successHandler, fn, userObject);
        if (prop === 'withUserObject') return obj => runner(successHandler, failureHandler, obj);
        if (prop === 'handleClientRequest') {
          return (action, body) => {
            Promise.resolve()
              .then(() => handle(action, body))
              .then(data => {
                if (successHandler) successHandler({ ok: true, data }, userObject);
              })
              .catch(error => {
                if (failureHandler) failureHandler(error, userObject);
              });
          };
        }
        return undefined;
      }
    });
  }

  window.google = { script: { run: runner() } };
})();
