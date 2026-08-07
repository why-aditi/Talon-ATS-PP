import { asClass, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../context.js';
import { JobsRepository } from './repository.js';
import { JobsService } from './service.js';

export function registerJobs(container: AwilixContainer<Cradle>): void {
  container.register({
    jobsService: asClass(JobsService).singleton(),
    jobsRepository: asClass(JobsRepository).singleton(),
  });
}
