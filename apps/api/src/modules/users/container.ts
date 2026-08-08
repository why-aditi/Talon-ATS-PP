import { asClass, type AwilixContainer } from 'awilix';
import type { Cradle } from '../../context.js';
import { UsersRepository } from './repository.js';
import { UsersService } from './service.js';

export function registerUsers(container: AwilixContainer<Cradle>): void {
  container.register({
    usersService: asClass(UsersService).singleton(),
    usersRepository: asClass(UsersRepository).singleton(),
  });
}
