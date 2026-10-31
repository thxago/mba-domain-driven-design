import { randomUUID } from 'crypto';
import { MikroORM, MySqlDriver, EntityManager } from '@mikro-orm/mysql';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import config from '../../../../../../mikro-orm.config';
import {
  Customer,
  CustomerId,
} from '../../../../domain/entities/customer.entity';
import { Event, EventId } from '../../../../domain/entities/event.entity';
import { EventSectionId } from '../../../../domain/entities/event-section';
import { EventSpotId } from '../../../../domain/entities/event-spot';
import { Partner } from '../../../../domain/entities/partner.entity';
import {
  WaitingList,
  WaitingListId,
} from '../../../../domain/entities/waiting-list.entity';
import {
  WaitingListEntry,
  WaitingListEntryId,
  WaitingListEntryStatus,
} from '../../../../domain/entities/waiting-list-entry.entity';
import { WaitingListMysqlRepository } from '../waiting-list-mysql.repository';
import { EventMysqlRepository } from '../event-mysql.repository';
import { EventSpotReleased } from '../../../../domain/events/domain-events/event-spot-released.event';

describe('Waiting list persistence and event lookup', () => {
  let orm: MikroORM<MySqlDriver>;
  let em: EntityManager;
  let repo: WaitingListMysqlRepository;
  let eventRepo: EventMysqlRepository;
  let event: Event;
  let customers: Customer[];
  let databaseCreated = false;
  const dbName = `events_task6_${randomUUID().replace(/-/g, '')}`;

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
    repo = new WaitingListMysqlRepository(em);
    eventRepo = new EventMysqlRepository(em);
    const partner = Partner.create({ name: 'Partner' });
    customers = [
      Customer.create({ name: 'First', cpf: '70375887091' }),
      Customer.create({ name: 'Second', cpf: '59211087074' }),
    ];
    event = partner.initEvent({ name: 'Event', date: new Date() });
    event.addSection({ name: 'First', total_spots: 2, price: 100 });
    event.addSection({ name: 'Second', total_spots: 2, price: 200 });
    event.publishAll();
    em.persist([partner, ...customers, event]);
    await em.flush();
  }, 30000);

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

  test('reloads the whole waiting list with typed IDs and ordered child entries', async () => {
    const section = event.sections.values()[0];
    const list = WaitingList.create({
      event_id: event.id,
      section_id: section.id,
    });
    const later = WaitingListEntry.create({
      customer_id: customers[1].id,
      position: 2,
    });
    const earlier = WaitingListEntry.create({
      customer_id: customers[0].id,
      position: 1,
    });
    list.entries.add(later, earlier);
    await repo.add(list);
    await em.flush();
    em.clear();

    const found = await repo.findById(list.id.value);

    expect(found).toBeInstanceOf(WaitingList);
    expect(found.id).toBeInstanceOf(WaitingListId);
    expect(found.event_id).toBeInstanceOf(EventId);
    expect(found.section_id).toBeInstanceOf(EventSectionId);
    expect(found.toJSON()).toEqual(list.toJSON());
    const entries = found.entries.values();
    expect(entries.map((entry) => entry.position)).toEqual([1, 2]);
    expect(entries[0]).toBeInstanceOf(WaitingListEntry);
    expect(entries[0].id).toBeInstanceOf(WaitingListEntryId);
    expect(entries[0].customer_id).toBeInstanceOf(CustomerId);
    found.notifyFirstPending(new EventSpotId());
    await repo.add(found);
    await em.flush();
    em.clear();

    const updated = await repo.findById(list.id);
    expect(updated.entries.values().map((entry) => entry.status)).toEqual([
      WaitingListEntryStatus.NOTIFIED,
      WaitingListEntryStatus.PENDING,
    ]);
    const rejoined = updated.join(customers[0].id);
    expect(rejoined.position).toBe(3);
    await repo.add(updated);
    await em.flush();
    em.clear();
    expect((await repo.findById(list.id)).entries.values()).toHaveLength(3);
  });

  test('finds a list by the event and section pair with string or typed IDs', async () => {
    const [first, second] = event.sections.values();
    const lists = [first, second].map((section) =>
      WaitingList.create({ event_id: event.id, section_id: section.id }),
    );
    lists[0].join(customers[0].id);
    for (const list of lists) {
      await repo.add(list);
    }
    await em.flush();
    em.clear();

    expect(
      (
        await repo.findByEventAndSection(event.id.value, first.id.value)
      ).id.equals(lists[0].id),
    ).toBe(true);
    expect(
      (await repo.findByEventAndSection(event.id, second.id)).id.equals(
        lists[1].id,
      ),
    ).toBe(true);
    expect(
      await repo.findByEventAndSection(new EventId(), first.id),
    ).toBeNull();
    expect(
      await repo.findByEventAndSection(event.id, new EventSectionId()),
    ).toBeNull();
    expect(await repo.findById(new WaitingListId())).toBeNull();
    expect(await repo.findAll()).toHaveLength(2);
  });

  test('enforces one waiting list per event and section', async () => {
    const section = event.sections.values()[0];
    await repo.add(
      WaitingList.create({ event_id: event.id, section_id: section.id }),
    );
    await em.flush();
    await repo.add(
      WaitingList.create({ event_id: event.id, section_id: section.id }),
    );

    await expect(em.flush()).rejects.toBeInstanceOf(
      UniqueConstraintViolationException,
    );
  });

  test('deletes the waiting list and its entries', async () => {
    const list = WaitingList.create({
      event_id: event.id,
      section_id: event.sections.values()[0].id,
    });
    list.join(customers[0].id);
    await repo.add(list);
    await em.flush();
    em.clear();

    await repo.delete(await repo.findById(list.id));
    await em.flush();
    em.clear();

    expect(await repo.findById(list.id)).toBeNull();
    expect(await em.count(WaitingListEntry, {})).toBe(0);
  });

  test('finds the owning event by a spot and loads all sections and spots', async () => {
    const section = event.sections.values()[1];
    const spot = section.spots.values()[1];
    event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id });
    await em.flush();
    em.clear();

    const found = await eventRepo.findByEventSpotId(spot.id.value);

    expect(found.id.equals(event.id)).toBe(true);
    expect(found.sections.values()).toHaveLength(2);
    expect(found.sections.values().map((s) => s.spots.values().length)).toEqual(
      [2, 2],
    );
    found.markSpotAsAvailable(new EventSpotId(spot.id.value));
    const released = [...found.events].find(
      (entry) => entry instanceof EventSpotReleased,
    ) as EventSpotReleased;
    expect(released.section_id.value).toBe(section.id.value);
    expect(released.spot_id.value).toBe(spot.id.value);
    await eventRepo.add(found);
    await em.flush();
    em.clear();
    const updated = await eventRepo.findById(event.id);
    expect(
      updated.allowReserveSpot({ section_id: section.id, spot_id: spot.id }),
    ).toBe(true);
    expect(
      (await eventRepo.findByEventSpotId(spot.id)).id.equals(event.id),
    ).toBe(true);
    expect(await eventRepo.findByEventSpotId(new EventSpotId())).toBeNull();
  });
});