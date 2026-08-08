/**
 * Orchestration. Permission scopes are checked here, never in a route handler
 * and never in a component.
 */
import type { ListUsersQuery, ListUsersResponse, Role } from '@talon/contracts';
import type { AuthenticatedUser, TenantTransaction } from '../../request-context.js';
import type { UsersRepository } from './repository.js';

export class UsersService {
  readonly #repository: UsersRepository;

  constructor({ usersRepository }: { usersRepository: UsersRepository }) {
    this.#repository = usersRepository;
  }

  /**
   * The people a job can be assigned to.
   *
   * No scope gate: a name and a role are what every screen in the product
   * already shows — the jobs list renders its recruiter, the board renders its
   * assignee. What is deliberately NOT here is the email, which
   * `UserSummarySchema` has no field for, so a picker cannot become a directory
   * of colleagues' addresses.
   */
  async listUsers(
    tx: TenantTransaction,
    _user: AuthenticatedUser,
    query: ListUsersQuery,
  ): Promise<ListUsersResponse> {
    const roles: Role[] = query.role === undefined ? [] : [query.role].flat();
    const records = await this.#repository.findSummaries(tx, roles);
    return { data: records };
  }
}
