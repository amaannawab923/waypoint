// Real, path-based, address-bar-updating URLs (createBrowserRouter) rather
// than in-memory-only routing — this is also exactly what a future plain-web
// deployment of Waypoint would use unchanged, since the router itself is not
// Electron-specific. What makes this resolvable in every environment this
// app runs in is handled outside this file, not by swapping router
// implementations: webpack-dev-server's historyApiFallback in dev
// (.erb/configs/webpack.config.renderer.dev.ts), a custom `app://` protocol
// handler with the same SPA-fallback behavior in the packaged desktop build
// (src/main/main.ts), and a standard static-host SPA rewrite rule if this
// ever ships as a website.
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { AppShell } from '@/layouts/AppShell';
import { ProjectLayout } from '@/layouts/ProjectLayout';
import { isOnboarded } from '@/lib/onboarding';

import Login from '@/pages/auth/Login';
import Signup from '@/pages/auth/Signup';
import CreateWorkspace from '@/pages/auth/CreateWorkspace';

import Home from '@/pages/Home';
import YourWork from '@/pages/YourWork';
import Drafts from '@/pages/Drafts';
import Stickies from '@/pages/Stickies';
import Notifications from '@/pages/Notifications';
import ProjectsList from '@/pages/ProjectsList';
import ArchivedProjects from '@/pages/ArchivedProjects';
import AnalyticsPage from '@/pages/AnalyticsPage';
import WorkspaceViewsPage from '@/pages/WorkspaceViewsPage';

import WorkItemsLayout from '@/pages/work-items/WorkItemsLayout';
import WorkItemDetailPage from '@/pages/work-items/WorkItemDetailPage';

import CyclesPage from '@/pages/CyclesPage';
import CycleDetailPage from '@/pages/CycleDetailPage';
import ModulesPage from '@/pages/ModulesPage';
import ModuleDetailPage from '@/pages/ModuleDetailPage';
import ProjectViewsPage from '@/pages/ProjectViewsPage';
import IntakePage from '@/pages/IntakePage';
import PagesPage from '@/pages/PagesPage';
import PageDetailPage from '@/pages/PageDetailPage';

import ProjectSettingsLayout from '@/pages/project-settings/ProjectSettingsLayout';
import ProjectSettingsGeneral from '@/pages/project-settings/General';
import ProjectSettingsMembers from '@/pages/project-settings/Members';
import ProjectSettingsFeatures from '@/pages/project-settings/Features';
import ProjectSettingsStates from '@/pages/project-settings/States';
import ProjectSettingsLabels from '@/pages/project-settings/Labels';
import ProjectSettingsEstimates from '@/pages/project-settings/Estimates';
import ProjectSettingsAutomations from '@/pages/project-settings/Automations';

import WorkspaceSettingsLayout from '@/pages/workspace-settings/WorkspaceSettingsLayout';
import WorkspaceSettingsGeneral from '@/pages/workspace-settings/General';
import WorkspaceSettingsMembers from '@/pages/workspace-settings/Members';
import WorkspaceSettingsAgents from '@/pages/workspace-settings/Agents';
import AgentDetailPage from '@/pages/workspace-settings/AgentDetailPage';
import WorkspaceSettingsBilling from '@/pages/workspace-settings/Billing';
import WorkspaceSettingsExports from '@/pages/workspace-settings/Exports';
import WorkspaceSettingsWebhooks from '@/pages/workspace-settings/Webhooks';

import ProfileSettingsLayout from '@/pages/profile-settings/ProfileSettingsLayout';
import ProfileSettingsProfile from '@/pages/profile-settings/Profile';
import ProfileSettingsPreferences from '@/pages/profile-settings/Preferences';
import ProfileSettingsNotifications from '@/pages/profile-settings/Notifications';
import ProfileSettingsSecurity from '@/pages/profile-settings/Security';
import ProfileSettingsTokens from '@/pages/profile-settings/Tokens';

import AdminLayout from '@/pages/admin/AdminLayout';
import AdminGeneral from '@/pages/admin/General';
import AdminEmail from '@/pages/admin/Email';
import AdminAuth from '@/pages/admin/Auth';
import AdminWorkspaces from '@/pages/admin/Workspaces';
import AdminAI from '@/pages/admin/AI';
import AdminImages from '@/pages/admin/Images';

/**
 * Guards every route nested under AppShell. There's no real backend/session
 * — this just checks the `waypoint:onboarded` localStorage flag (see
 * src/lib/onboarding.ts) and bounces to /login if it's explicitly 'false'.
 * Anything else (missing key included) is treated as already onboarded, so
 * this can never lock out someone with pre-existing localStorage state.
 */
function RequireOnboarded() {
  if (!isOnboarded()) return <Navigate to="/login" replace />;
  return <Outlet />;
}

export const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/signup', element: <Signup /> },
  { path: '/onboarding/workspace', element: <CreateWorkspace /> },

  {
    element: <RequireOnboarded />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: '/', element: <Home /> },
          { path: '/your-work', element: <YourWork /> },
          { path: '/drafts', element: <Drafts /> },
          { path: '/stickies', element: <Stickies /> },
          { path: '/notifications', element: <Notifications /> },
          { path: '/projects', element: <ProjectsList /> },
          { path: '/projects/archived', element: <ArchivedProjects /> },
          { path: '/analytics', element: <AnalyticsPage /> },
          { path: '/views', element: <WorkspaceViewsPage /> },

          {
            path: '/projects/:projectId',
            element: <ProjectLayout />,
            children: [
              { index: true, element: <Navigate to="work-items" replace /> },
              { path: 'work-items', element: <WorkItemsLayout /> },
              { path: 'work-items/:identifier', element: <WorkItemDetailPage /> },
              { path: 'cycles', element: <CyclesPage /> },
              { path: 'cycles/:cycleId', element: <CycleDetailPage /> },
              { path: 'modules', element: <ModulesPage /> },
              { path: 'modules/:moduleId', element: <ModuleDetailPage /> },
              { path: 'views', element: <ProjectViewsPage /> },
              { path: 'pages', element: <PagesPage /> },
              { path: 'pages/:pageId', element: <PageDetailPage /> },
              { path: 'intake', element: <IntakePage /> },
              {
                path: 'settings',
                element: <ProjectSettingsLayout />,
                children: [
                  { index: true, element: <Navigate to="general" replace /> },
                  { path: 'general', element: <ProjectSettingsGeneral /> },
                  { path: 'members', element: <ProjectSettingsMembers /> },
                  { path: 'features', element: <ProjectSettingsFeatures /> },
                  { path: 'states', element: <ProjectSettingsStates /> },
                  { path: 'labels', element: <ProjectSettingsLabels /> },
                  { path: 'estimates', element: <ProjectSettingsEstimates /> },
                  { path: 'automations', element: <ProjectSettingsAutomations /> },
                ],
              },
            ],
          },

          {
            path: '/settings',
            element: <WorkspaceSettingsLayout />,
            children: [
              { index: true, element: <Navigate to="general" replace /> },
              { path: 'general', element: <WorkspaceSettingsGeneral /> },
              { path: 'members', element: <WorkspaceSettingsMembers /> },
              { path: 'agents', element: <WorkspaceSettingsAgents /> },
              { path: 'agents/new', element: <AgentDetailPage /> },
              { path: 'agents/:agentId', element: <AgentDetailPage /> },
              { path: 'billing', element: <WorkspaceSettingsBilling /> },
              { path: 'exports', element: <WorkspaceSettingsExports /> },
              { path: 'webhooks', element: <WorkspaceSettingsWebhooks /> },
            ],
          },

          {
            path: '/profile',
            element: <ProfileSettingsLayout />,
            children: [
              { index: true, element: <Navigate to="general" replace /> },
              { path: 'general', element: <ProfileSettingsProfile /> },
              { path: 'preferences', element: <ProfileSettingsPreferences /> },
              { path: 'notifications', element: <ProfileSettingsNotifications /> },
              { path: 'security', element: <ProfileSettingsSecurity /> },
              { path: 'tokens', element: <ProfileSettingsTokens /> },
            ],
          },

          {
            path: '/admin',
            element: <AdminLayout />,
            children: [
              { index: true, element: <Navigate to="general" replace /> },
              { path: 'general', element: <AdminGeneral /> },
              { path: 'email', element: <AdminEmail /> },
              { path: 'authentication', element: <AdminAuth /> },
              { path: 'workspaces', element: <AdminWorkspaces /> },
              { path: 'ai', element: <AdminAI /> },
              { path: 'images', element: <AdminImages /> },
            ],
          },

          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);
