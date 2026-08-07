import { asClass, type AwilixContainer } from 'awilix';
import { JobsRepository } from './repository.js';
import { JobsService } from './service.js';

export function registerJobs(container: AwilixContainer): void {
  container.register({
    jobsService: asClass(JobsService),
    jobsRepository: asClass(JobsRepository),
  });
}
