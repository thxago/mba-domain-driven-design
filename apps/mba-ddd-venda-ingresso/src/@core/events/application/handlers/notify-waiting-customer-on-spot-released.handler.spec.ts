import { randomUUID } from 'crypto';
import { MikroORM, MySqlDriver, EntityManager } from '@mikro-orm/mysql';
import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { Queue } from 'bull';
import config from '../../../../mikro-orm.config';
import { EventsModule } from '../../../../events/events.module';
import { DomainEventManager } from '../../../common/domain/domain-event-manager';
import { IIntegrationEvent } from '../../../common/domain/integration-event';
import { StoredEvent } from '../../../stored-events/domain/entities/stored-event.entity';
import { StoredEventMysqlRepository } from '../../../stored-events/infra/db/repositories/stored-event-mysql.repository';
import { Customer } from '../../domain/entities/customer.entity';
import { Event } from '../../domain/entities/event.entity';
import { Partner } from '../../domain/entities/partner.entity';
import { WaitingList } from '../../domain/entities/waiting-list.entity';
import { WaitingListEntryStatus } from '../../domain/entities/waiting-list-entry.entity';
import { SpotOfferedToWaitingCustomer } from '../../domain/events/domain-events/spot-offered-to-waiting-customer.event';
import { SpotOfferedToWaitingCustomerIntegrationEvent } from '../../domain/events/integration-events/spot-offered-to-waiting-customer.int-events';
import { WaitingListMysqlRepository } from '../../infra/db/repositories/waiting-list-mysql.repository';
import { EventMysqlRepository } from '../../infra/db/repositories/event-mysql.repository';
import { NotifyWaitingCustomerOnSpotReleasedHandler } from './notify-waiting-customer-on-spot-released.handler';

describe('Waiting customer notification policy and integration mapping', () => {
  let orm: MikroORM<MySqlDriver>;
  let em: EntityManager;
  let manager: DomainEventManager;
  let repo: WaitingListMysqlRepository;
  let container: TestingModule;
  let event: Event;
  let customers: Customer[];
  let databaseCreated = false;
  let queue: { add: jest.Mock };
  const dbName = `events_task10_${randomUUID().replace(/-/g, '')}`;

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
    event.addSection({ name: 'Section', total_spots: 1, price: 200 });
    event.publishAll();
    const section = event.sections.values()[0];
    event.markSpotAsReserved({
      section_id: section.id,
      spot_id: section.spots.values()[0].id,
    });
    em.persist([partner, ...customers, event]);
    await em.flush();
    em.clear();

    repo = new WaitingListMysqlRepository(em);
    manager = new DomainEventManager();
    const storedRepo = new StoredEventMysqlRepository(em);
    manager.register('*', async (domainEvent) => {
      storedRepo.add(domainEvent);
    });
    const handler = new NotifyWaitingCustomerOnSpotReleasedHandler(
      repo,
      manager,
    );
    container = await Test.createTestingModule({
      providers: [
        {
          provide: NotifyWaitingCustomerOnSpotReleasedHandler,
          useValue: handler,
        },
      ],
    }).compile();
    queue = { add: jest.fn().mockResolvedValue({}) };
    const composition = new EventsModule(
      manager,
      container.get(ModuleRef),
      queue as unknown as Queue<IIntegrationEvent>,
    );
    composition.onModuleInit();
  }, 30000);

  afterEach(async () => {
    await container?.close();
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

  async function releaseSpot() {
    const aggregate = await new EventMysqlRepository(em).findById(event.id);
    const spot = aggregate.sections.values()[0].spots.values()[0];
    aggregate.markSpotAsAvailable(spot.id);
    await manager.publish(aggregate);
    await em.flush();
    em.clear();
    return spot.id;
  }

  test('promotes only the first pending, persists and publishes its integration payload', async () => {
    const section = event.sections.values()[0];
    const list = WaitingList.create({
      event_id: event.id,
      section_id: section.id,
    });
    const first = list.join(customers[0].id);
    const second = list.join(customers[1].id);
    await repo.add(list);
    await em.flush();
    em.clear();
    const published = jest.fn();
    manager.register(SpotOfferedToWaitingCustomer.name, published);

    const spotId = await releaseSpot();

    const updated = await repo.findById(list.id);
    expect(updated.entries.values().map((entry) => entry.status)).toEqual([
      WaitingListEntryStatus.NOTIFIED,
      WaitingListEntryStatus.PENDING,
    ]);
    expect(updated.entries.values().map((entry) => entry.id.value)).toEqual([
      first.id.value,
      second.id.value,
    ]);
    expect(published).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const integration = queue.add.mock.calls[0][0];
    expect(integration).toBeInstanceOf(
      SpotOfferedToWaitingCustomerIntegrationEvent,
    );
    expect(integration.event_name).toBe(
      SpotOfferedToWaitingCustomerIntegrationEvent.name,
    );
    expect(integration.payload).toEqual({
      customer_id: customers[0].id.value,
      event_id: event.id.value,
      section_id: section.id.value,
      spot_id: spotId.value,
    });
    expect(integration.occurred_on).toBe(
      published.mock.calls[0][0].occurred_on,
    );
    expect(
      await em.count(StoredEvent, {
        type_name: SpotOfferedToWaitingCustomer.name,
      }),
    ).toBe(1);
    const unchangedSpot = (
      await new EventMysqlRepository(em).findById(event.id)
    ).sections
      .values()[0]
      .spots.values()[0];
    expect(unchangedSpot.is_reserved).toBe(false);
  });

  test('does nothing when the section has no waiting list', async () => {
    const add = jest.spyOn(repo, 'add');

    await releaseSpot();

    expect(add).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(await em.count(WaitingList, {})).toBe(0);
    expect(
      await em.count(StoredEvent, {
        type_name: SpotOfferedToWaitingCustomer.name,
      }),
    ).toBe(0);
  });

  test.each([false, true])(
    'does not offer or persist when the list has no pending entries (notified: %s)',
    async (notified) => {
      const list = WaitingList.create({
        event_id: event.id,
        section_id: event.sections.values()[0].id,
      });
      if (notified) {
        list.join(customers[0].id).markAsNotified();
      }
      await repo.add(list);
      await em.flush();
      em.clear();
      const add = jest.spyOn(repo, 'add');

      await releaseSpot();

      expect(add).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(
        await em.count(StoredEvent, {
          type_name: SpotOfferedToWaitingCustomer.name,
        }),
      ).toBe(0);
      const updated = await repo.findById(list.id);
      expect(updated.entries.values().map((entry) => entry.status)).toEqual(
        notified ? [WaitingListEntryStatus.NOTIFIED] : [],
      );
    },
  );
});