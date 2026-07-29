import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const mockPrismaService = {
      onModuleInit: jest.fn(),
      $connect: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [{ provide: PrismaService, useValue: mockPrismaService }],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
