import { asClass, type AwilixContainer } from 'awilix';
import { SchedulingRepository } from './repository.js';
import { SchedulingService } from './service.js';
import { RadicaleCalendarProvider } from './radicale-calendar-provider.js';

export function registerScheduling(container: AwilixContainer): void {
  container.register({
    schedulingRepository: asClass(SchedulingRepository).singleton(),
    schedulingService: asClass(SchedulingService).singleton(),
    calendarProvider: asClass(RadicaleCalendarProvider).singleton(),
  });
}
