import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { NotFoundError } from '../middleware/errors.js';
import * as projectsService from '../services/projects.service.js';
import {
  createProjectSchema,
  updateProjectSchema,
  addProjectMemberSchema,
  projectEstimateSchema,
  projectAutomationsSchema,
} from '../validation/projects.schema.js';

export const projectsRouter = Router();

projectsRouter.get(
  '/projects',
  asyncHandler(async (_req, res) => {
    res.json(await projectsService.listProjects());
  }),
);

projectsRouter.get(
  '/projects/archived',
  asyncHandler(async (_req, res) => {
    res.json(await projectsService.listArchivedProjects());
  }),
);

projectsRouter.get(
  '/projects/:id',
  asyncHandler(async (req, res) => {
    const project = await projectsService.getProject(req.params.id);
    if (!project) throw new NotFoundError('project');
    res.json(project);
  }),
);

projectsRouter.post(
  '/projects',
  asyncHandler(async (req, res) => {
    const input = createProjectSchema.parse(req.body);
    res.status(201).json(await projectsService.createProject(input));
  }),
);

projectsRouter.patch(
  '/projects/:id',
  asyncHandler(async (req, res) => {
    const patch = updateProjectSchema.parse(req.body);
    res.json(await projectsService.updateProject(req.params.id, patch));
  }),
);

projectsRouter.post(
  '/projects/:id/members',
  asyncHandler(async (req, res) => {
    const { memberId, role } = addProjectMemberSchema.parse(req.body);
    res.json(await projectsService.addProjectMember(req.params.id, memberId, role));
  }),
);

projectsRouter.delete(
  '/projects/:id/members/:memberId',
  asyncHandler(async (req, res) => {
    res.json(await projectsService.removeProjectMember(req.params.id, req.params.memberId));
  }),
);

projectsRouter.put(
  '/projects/:id/estimate',
  asyncHandler(async (req, res) => {
    const estimate = projectEstimateSchema.parse(req.body);
    res.json(await projectsService.updateProjectEstimate(req.params.id, estimate));
  }),
);

projectsRouter.get(
  '/projects/:id/automations',
  asyncHandler(async (req, res) => {
    res.json(await projectsService.getProjectAutomations(req.params.id));
  }),
);

projectsRouter.patch(
  '/projects/:id/automations',
  asyncHandler(async (req, res) => {
    const patch = projectAutomationsSchema.parse(req.body);
    res.json(await projectsService.updateProjectAutomations(req.params.id, patch));
  }),
);

projectsRouter.post(
  '/projects/:id/archive',
  asyncHandler(async (req, res) => {
    await projectsService.archiveProject(req.params.id);
    res.status(204).end();
  }),
);

projectsRouter.delete(
  '/projects/:id',
  asyncHandler(async (req, res) => {
    await projectsService.deleteProject(req.params.id);
    res.status(204).end();
  }),
);
