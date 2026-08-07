// VIOLATION FIXTURE 1: cross-module import of another module's repository.
import { ApplicationsRepository } from '../applications/repository.js';
// VIOLATION FIXTURE 2: @talon/db imported outside repository.ts.
import '@talon/db';

// Orchestration; the only place transactions begin. Permission scopes are
// checked here, never in components.
export class JobsService {
  constructor(private readonly leaked: ApplicationsRepository) {}
}
