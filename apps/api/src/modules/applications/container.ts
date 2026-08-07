import { asClass, type AwilixContainer } from 'awilix';
import { ApplicationsRepository } from './repository.js';
import { ApplicationsService } from './service.js';

export function registerApplications(container: AwilixContainer): void {
  container.register({
    applicationsService: asClass(ApplicationsService),
    applicationsRepository: asClass(ApplicationsRepository),
  });
}
