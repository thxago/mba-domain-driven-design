import { randomUUID } from 'crypto';
import { MikroORM, MySqlDriver, EntityManager } from '@mikro-orm/mysql';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import config from '../../../mikro-orm.config';
import { WaitingListController } from '../../../events/events/waiting-list.controller';
import { ApplicationService } from '../../common/application/application.service';
import { DomainEventManager } from '../../common/domain/domain-event-manager';
import { UnitOfWorkMikroOrm } from '../../common/infra/unit-of-work-mikro-orm';
import { StoredEvent } from '../../stored-events/domain/entities/stored-event.entity';
import { StoredEventMysqlRepository } from '../../stored-events/infra/db/repositories/stored-event-mysql.repository';
import { Customer, CustomerId } from '../domain/entities/customer.entity';
import { Event, EventId } from '../domain/entities/event.entity';
import { EventSectionId } from '../domain/entities/event-section';
import { Partner } from '../domain/entities/partner.entity';
import { WaitingList } from '../domain/entities/waiting-list.entity';
import {
  WaitingListEntry,
  WaitingListEntryStatus,
} from '../domain/entities/waiting-list-entry.entity';
import { CustomerJoinedWaitingList } from '../domain/events/domain-events/customer-joined-waiting-list.event';
import { SpotOfferedToWaitingCustomer } from '../domain/events/domain-events/spot-offered-to-waiting-customer.event';
import { CustomerMysqlRepository } from '../infra/db/repositories/customer-mysql.repository';
import { EventMysqlRepository } from '../infra/db/repositories/event-mysql.repository';
import { WaitingListMysqlRepository } from '../infra/db/repositories/waiting-list-mysql.repository';
import { WaitingListService } from './waiting-list.service';

describe('WaitingListService and REST endpoints', () => {
  let orm: MikroORM<MySqlDriver>;
  let em: EntityManager;
  let service: WaitingListService;
  let applicationService: ApplicationService;
  let app: INestApplication;
  let event: Event;
  let customers: Customer[];
  let input: { customer_id: string; event_id: string; section_id: string };
  let databaseCreated = false;
  const dbName = `events_task9_${randomUUID().replace(/-/g, '')}`;

  beforeAll(async () => {
    orm = await MikroORM.init<MySqlDriver>({
      ...config,
      dbName,
      forceEntityConstructor: true,
    });
    databaseCreated = await orm.schema.ensureDatabase();
  }, 30000);

  beforeEach(async () => {
    await orm.schema.refreshDatabase();
    em = orm.em.fork();
    const partner = Partner.create({ name: 'Partner' });
    customers = [
      Customer.create({ name: 'First', cpf: '70375887091' }),
      Customer.create({ name: 'Second', cpf: '59211087074' }),
    ];
    event = partner.initEvent({ name: 'Event', date: new Date() });
    event.addSection({ name: 'Section', total_spots: 2, price: 200 });
    event.publishAll();
    const section = event.sections.values()[0];
    section.spots.forEach((spot) =>
      event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id }),
    );
    em.persist([partner, ...customers, event]);
    await em.flush();
    em.clear();
    input = {
      customer_id: customers[0].id.value,
      event_id: event.id.value,
      section_id: section.id.value,
    };

    const manager = new DomainEventManager();
    const storedRepo = new StoredEventMysqlRepository(em);
    manager.register('*', async (domainEvent) => {
      storedRepo.add(domainEvent);
    });
    applicationService = new ApplicationService(
      new UnitOfWorkMikroOrm(em),
      manager,
    );
    service = new WaitingListService(
      new WaitingListMysqlRepository(em),
      new CustomerMysqlRepository(em),
      new EventMysqlRepository(em),
      applicationService,
    );
  }, 30000);

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  afterAll(async () => {
    if (orm) {
      try {
        if (databaseCreated) {
          await orm.schema.dropDatabase(dbName);
        }
      } finally {
        await orm.close();
      }
    }
  });

  test('creates and reuses a sold-out section list, persists entries and publishes join events', async () => {
    expect(event.total_spots_reserved).toBe(0);
    const first = await service.join(input);
    em.clear();
    const second = await service.join({
      ...input,
      customer_id: customers[1].id.value,
    });
    em.clear();

    expect(first.status).toBe(WaitingListEntryStatus.PENDING);
    expect(second.status).toBe(WaitingListEntryStatus.PENDING);
    expect(second.position).toBe(2);
    expect(await em.count(WaitingList, {})).toBe(1);
    const events = await em.find(StoredEvent, {
      type_name: CustomerJoinedWaitingList.name,
    });
    expect(events).toHaveLength(2);
    expect(events.map((stored) => stored.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          customer_id: { _value: customers[0].id.value },
          event_id: { _value: event.id.value },
          section_id: { _value: input.section_id },
        }),
        expect.objectContaining({
          customer_id: { _value: customers[1].id.value },
        }),
      ]),
    );
    expect(
      await em.count(StoredEvent, {
        type_name: SpotOfferedToWaitingCustomer.name,
      }),
    ).toBe(0);
  });

  test.each([
    ['customer_id', 'Customer not found'],
    ['event_id', 'Event not found'],
    ['section_id', 'Section not found'],
  ])(
    'rejects an unknown %s without creating a list or publishing',
    async (key, message) => {
      const id =
        key === 'customer_id'
          ? new CustomerId()
          : key === 'event_id'
          ? new EventId()
          : new EventSectionId();

      await expect(service.join({ ...input, [key]: id.value })).rejects.toThrow(
        message,
      );

      expect(await em.count(WaitingList, {})).toBe(0);
      expect(await em.count(StoredEvent, {})).toBe(0);
    },
  );

  test('rejects a section with any available spot even when counters report sold out', async () => {
    const loaded = await em.findOne(Event, { id: event.id });
    const section = loaded.sections.values()[0];
    loaded.markSpotAsAvailable(section.spots.values()[1].id);
    loaded.total_spots_reserved = loaded.total_spots;
    section.total_spots_reserved = section.total_spots;
    await em.flush();
    em.clear();

    await expect(service.join(input)).rejects.toThrow(
      'Section is not sold out',
    );

    expect(await em.count(WaitingList, {})).toBe(0);
    expect(await em.count(StoredEvent, {})).toBe(0);
  });

  test('rejects a duplicate pending customer without adding or publishing again', async () => {
    await service.join(input);
    em.clear();

    await expect(service.join(input)).rejects.toThrow(
      'Customer already in waiting list',
    );

    expect(await em.count(WaitingListEntry, {})).toBe(1);
    expect(await em.count(StoredEvent, {})).toBe(1);
  });

  test('lists stored entries in arrival order without publishing or changing statuses', async () => {
    const list = WaitingList.create({
      event_id: event.id,
      section_id: new EventSectionId(input.section_id),
    });
    list.entries.add(
      new WaitingListEntry({
        customer_id: customers[1].id,
        position: 2,
        status: WaitingListEntryStatus.PENDING,
      }),
      new WaitingListEntry({
        customer_id: customers[0].id,
        position: 1,
        status: WaitingListEntryStatus.NOTIFIED,
      }),
    );
    em.persist(list);
    await em.flush();
    em.clear();
    const run = jest.spyOn(applicationService, 'run');

    const entries = await service.list(input.event_id, input.section_id);

    expect(entries.map((entry) => entry.position)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.status)).toEqual([
      WaitingListEntryStatus.NOTIFIED,
      WaitingListEntryStatus.PENDING,
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(await em.count(StoredEvent, {})).toBe(0);
  });

  test('returns an empty array when the section has no waiting list', async () => {
    expect(await service.list(input.event_id, input.section_id)).toEqual([]);

    expect(await em.count(WaitingList, {})).toBe(0);
    expect(await em.count(StoredEvent, {})).toBe(0);
  });

  test('exposes POST and GET with ordered entries and their statuses', async () => {
    const module = await Test.createTestingModule({
      controllers: [WaitingListController],
      providers: [{ provide: WaitingListService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    const path = `/events/${input.event_id}/sections/${input.section_id}/waiting-list`;

    await request(app.getHttpServer()).get(path).expect(200, []);
    const first = await request(app.getHttpServer())
      .post(path)
      .send({ customer_id: input.customer_id })
      .expect(201);
    expect(first.body).toMatchObject({
      customer_id: input.customer_id,
      status: WaitingListEntryStatus.PENDING,
      position: 1,
    });
    em.clear();
    const second = await request(app.getHttpServer())
      .post(path)
      .send({ customer_id: customers[1].id.value })
      .expect(201);
    em.clear();
    const response = await request(app.getHttpServer()).get(path).expect(200);
    expect(response.body).toEqual([first.body, second.body]);
  });
});