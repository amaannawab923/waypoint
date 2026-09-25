import { waypointSessionMcpServers } from './sessionMcpServers';

const sessionBrowserSessionServer = jest.fn();
const ultrafastSessionServer = jest.fn();
jest.mock('./sessionBrowser', () => ({
  sessionBrowserSessionServer: () => sessionBrowserSessionServer(),
}));
jest.mock('./ultrafast/registration', () => ({
  ultrafastSessionServer: () => ultrafastSessionServer(),
}));

// The engine archive's own node, not this app's Electron binary, and no
// ELECTRON_RUN_AS_NODE — both changed when the servers moved off Electron
// to stop them taking a Dock tile.
const NODE_PATH = '/data/engine/0.1.0/emdash-workspace-server/node';
const browser = {
  name: 'waypoint-browser',
  command: NODE_PATH,
  args: ['chrome-devtools-mcp.js', '--headless'],
  env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
};
const ultrafast = {
  name: 'waypoint-ultrafast',
  command: NODE_PATH,
  args: ['ultrafast-mcp.js'],
  env: { ULTRAFAST_KEY_FILE: '/data/runtime-key' },
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
