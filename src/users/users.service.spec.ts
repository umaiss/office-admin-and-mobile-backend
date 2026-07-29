import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UsersService', () => {
  let service: UsersService;

  beforeEach(async () => {
    const mockPrismaService = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };

    // A unit test must not read the real environment: the test would then pass
    // or fail depending on the machine it runs on. We supply the config the
    // service needs, explicitly. 10 rounds instead of 12 keeps tests fast —
    // bcrypt is deliberately slow, and that cost is per hash.
    const mockConfig = { bcryptSaltRounds: 10 };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AppConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
