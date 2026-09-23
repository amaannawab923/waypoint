import { waypointSessionMcpServers } from './sessionMcpServers';

const sessionBrowserSessionServer = jest.fn();
const ultrafastSessionServer = jest.fn();
jest.mock('./sessionBrowser', () => ({
  sessionBrowserSessionServer: () => sessionBrowserSessionServer(),
}));
jest.mock('./ultrafast/registration', () => ({
  ultrafastSessionServer: () => ultrafastSessionServer(),
}));

const browser = {
  name: 'waypoint-browser',
  command: '/bin/waypoint',
  args: ['chrome-devtools-mcp.js', '--headless'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};
const ultrafast = {
  name: 'waypoint-ultrafast',
  command: '/bin/waypoint',
  args: ['ultrafast-mcp.js'],
  env: { ELECTRON_RUN_AS_NODE: '1', ULTRAFAST_KEY_FILE: '/data/runtime-key' },
};

beforeEach(() => {
  jest.clearAllMocks();
  sessionBrowserSessionServer.mockReturnValue(null);
  ultrafastSessionServer.mockReturnValue(null);
});

describe('waypointSessionMcpServers', () => {
  it('carries both of this app’s tools when both are ready', () => {
    sessionBrowserSessionServer.mockReturnValue(browser);
    ultrafastSessionServer.mockReturnValue(ultrafast);
    expect(waypointSessionMcpServers()).toEqual([browser, ultrafast]);
  });

  it('drops the ones whose own gates are not met, rather than sending a broken entry', () => {
    // ultrafast has no key configured: the browser still goes.
    sessionBrowserSessionServer.mockReturnValue(browser);
    expect(waypointSessionMcpServers()).toEqual([browser]);

    // and the other way round.
    jest.clearAllMocks();
    sessionBrowserSessionServer.mockReturnValue(null);
    ultrafastSessionServer.mockReturnValue(ultrafast);
    expect(waypointSessionMcpServers()).toEqual([ultrafast]);
  });

  it('is empty when nothing is ready — a session simply runs without the tools', () => {
    expect(waypointSessionMcpServers()).toEqual([]);
  });
});
