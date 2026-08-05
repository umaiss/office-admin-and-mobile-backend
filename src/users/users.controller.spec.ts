import { Test, TestingModule } from '@nestjs/testing';

import { Role } from '../generated/prisma/enums';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * The controller is a thin delegation layer, so what is worth pinning is exactly
 * that: every route reaches the service method it claims to, with the arguments
 * the route promises. In particular the two activate/deactivate routes differ
 * only by a boolean, which is the kind of thing that gets copy-pasted wrong and
 * would silently reactivate an account someone deliberately disabled.
 *
 * (This file previously asserted only "should be defined", with a mock declaring
 * a `findByEmail` method the service does not have — so it would have kept
 * passing no matter what the seven routes did.)
 */
describe('UsersController', () => {
  let controller: UsersController;
  let users: {
    create: jest.Mock;
    findMany: jest.Mock;
    findById: jest.Mock;
    update: jest.Mock;
    setActive: jest.Mock;
    resetPassword: jest.Mock;
  };

  const USER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  beforeEach(async () => {
    users = {
      create: jest.fn().mockResolvedValue({ id: USER_ID }),
      findMany: jest.fn().mockResolvedValue({ items: [], meta: {} }),
      findById: jest.fn().mockResolvedValue({ id: USER_ID }),
      update: jest.fn().mockResolvedValue({ id: USER_ID }),
      setActive: jest.fn().mockResolvedValue({ id: USER_ID }),
      resetPassword: jest.fn().mockResolvedValue({ message: 'ok' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: users }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('is defined', () => {
    expect(controller).toBeDefined();
  });

  it('creates a user from the body', async () => {
    const dto = {
      name: 'Bilal Ahmed',
      email: 'bilal@obtrack.local',
      password: 'Password123!',
      role: Role.OFFICE_BOY,
    };

    await controller.create(dto);

    expect(users.create).toHaveBeenCalledWith(dto);
  });

  it('passes the list query straight through', async () => {
    const query = { page: 2, limit: 50, role: Role.OFFICE_BOY };

    await controller.findMany(query);

    expect(users.findMany).toHaveBeenCalledWith(query);
  });

  it('fetches one user by id', async () => {
    await controller.findOne(USER_ID);

    expect(users.findById).toHaveBeenCalledWith(USER_ID);
  });

  it('updates the mutable profile fields', async () => {
    await controller.update(USER_ID, { name: 'Bilal A.' });

    expect(users.update).toHaveBeenCalledWith(USER_ID, { name: 'Bilal A.' });
  });

  it('activates with isActive true', async () => {
    await controller.activate(USER_ID);

    expect(users.setActive).toHaveBeenCalledWith(USER_ID, true);
  });

  it('deactivates with isActive false', async () => {
    await controller.deactivate(USER_ID);

    // The one that matters: getting this boolean wrong would re-enable an
    // account an admin had just disabled, and the response would look identical.
    expect(users.setActive).toHaveBeenCalledWith(USER_ID, false);
  });

  it('resets a password using only the new password from the body', async () => {
    await controller.resetPassword(USER_ID, { newPassword: 'NewPassw0rd!' });

    expect(users.resetPassword).toHaveBeenCalledWith(USER_ID, 'NewPassw0rd!');
  });
});
