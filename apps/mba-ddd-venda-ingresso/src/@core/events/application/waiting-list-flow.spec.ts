import { randomUUID } from 'crypto';
import { MikroORM, MySqlDriver } from '@mikro-orm/mysql';
import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { Queue } from 'bull';
import config from '../../../mikro-orm.config';
import { EventsModule } from '../../../events/events.module';
import { ApplicationService } from '../../common/application/application.service';
import { DomainEventManager } from '../../common/domain/domain-event-manager';
import { IIntegrationEvent } from '../../common/domain/integration-event';
import { UnitOfWorkMikroOrm } from '../../common/infra/unit-of-work-mikro-orm';
import { StoredEvent } from '../../stored-events/domain/entities/stored-event.entity';
import { StoredEventMysqlRepository } from '../../stored-events/infra/db/repositories/stored-event-mysql.repository';
import { Customer } from '../domain/entities/customer.entity';
import { Order, OrderStatus } from '../domain/entities/order.entity';
import { Partner } from '../domain/entities/partner.entity';
import { SpotReservation } from '../domain/entities/spot-reservation.entity';
import { WaitingListEntryStatus } from '../domain/entities/waiting-list-entry.entity';
import { CustomerJoinedWaitingList } from '../domain/events/domain-events/customer-joined-waiting-list.event';
import { OrderCancelled } from '../domain/events/domain-events/order-cancelled.event';
import { EventSpotReleased } from '../domain/events/domain-events/event-spot-released.event';
import { SpotOfferedToWaitingCustomer } from '../domain/events/domain-events/spot-offered-to-waiting-customer.event';
import { SpotOfferedToWaitingCustomerIntegrationEvent } from '../domain/events/integration-events/spot-offered-to-waiting-customer.int-events';
import { CustomerMysqlRepository } from '../infra/db/repositories/customer-mysql.repository';
import { EventMysqlRepository } from '../infra/db/repositories/event-mysql.repository';
import { OrderMysqlRepository } from '../infra/db/repositories/order-mysql.repository';
import { SpotReservationMysqlRepository } from '../infra/db/repositories/spot-reservation-mysql.repository';
import { WaitingListMysqlRepository } from '../infra/db/repositories/waiting-list-mysql.repository';
import { CancelOrderService } from './cancel-order.service';
import { WaitingListService } from './waiting-list.service';
import { ReleaseSpotOnOrderCancelledHandler } from './handlers/release-spot-on-order-cancelled.handler';
import { NotifyWaitingCustomerOnSpotReleasedHandler } from './handlers/notify-waiting-customer-on-spot-released.handler';

test('one cancellation releases the spot and notifies only the first waiting customer', async () => {
  const dbName = `events_flow_${randomUUID().replace(/-/g, '')}`;
  const orm = await MikroORM.init<MySqlDriver>({
    ...config,
    dbName,
    forceEntityConstructor: true,
  });
  const databaseCreated = await orm.schema.ensureDatabase();
  let container: TestingModule;

  try {
    await orm.schema.refreshDatabase();
    const em = orm.em.fork();
    const partner = Partner.create({ name: 'Partner' });
    const buyer = Customer.create({ name: 'A', cpf: '70375887091' });
    const first = Customer.create({ name: 'B', cpf: '59211087074' });
    const second = Customer.create({ name: 'C', cpf: '52998224725' });
    const event = partner.initEvent({ name: 'Event', date: new Date() });
    event.addSection({ name: 'Section', total_spots: 1, price: 200 });
    event.publishAll();
    const section = event.sections.values()[0];
    const spot = section.spots.values()[0];
    event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id });
    const order = Order.create({
      customer_id: buyer.id,
      event_spot_id: spot.id,
      amount: 200,
    });
    order.pay();
    const reservation = SpotReservation.create({
      spot_id: spot.id,
      customer_id: buyer.id,
    });
    em.persist([partner, buyer, first, second, event, order, reservation]);
    await em.flush();
    em.clear();

    const eventRepo = new EventMysqlRepository(em);
    const orderRepo = new OrderMysqlRepository(em);
    const waitingRepo = new WaitingListMysqlRepository(em);
    const manager = new DomainEventManager();
    const storedRepo = new StoredEventMysqlRepository(em);
    manager.register('*', async (domainEvent) => {
      storedRepo.add(domainEvent);
    });
    const application = new ApplicationService(
      new UnitOfWorkMikroOrm(em),
      manager,
    );
    const releaseHandler = new ReleaseSpotOnOrderCancelledHandler(
      eventRepo,
      new SpotReservationMysqlRepository(em),
      manager,
    );
    const notifyHandler = new NotifyWaitingCustomerOnSpotReleasedHandler(
      waitingRepo,
      manager,
    );
    container = await Test.createTestingModule({
      providers: [
        {
          provide: ReleaseSpotOnOrderCancelledHandler,
          useValue: releaseHandler,
        },
        {
          provide: NotifyWaitingCustomerOnSpotReleasedHandler,
          useValue: notifyHandler,
        },
      ],
    }).compile();
    const queue = { add: jest.fn().mockResolvedValue({}) };
    new EventsModule(
      manager,
      container.get(ModuleRef),
      queue as unknown as Queue<IIntegrationEvent>,
    ).onModuleInit();

    const waitingService = new WaitingListService(
      waitingRepo,
      new CustomerMysqlRepository(em),
      eventRepo,
      application,
    );
    for (const customer of [first, second]) {
      await waitingService.join({
        event_id: event.id.value,
        section_id: section.id.value,
        customer_id: customer.id.value,
      });
      em.clear();
    }
    const pending = await waitingService.list(event.id.value, section.id.value);
    expect(pending.map((entry) => entry.status)).toEqual([
      WaitingListEntryStatus.PENDING,
      WaitingListEntryStatus.PENDING,
    ]);
    em.clear();

    await new CancelOrderService(orderRepo, application).cancel(order.id.value);
    em.clear();

    expect((await orderRepo.findById(order.id)).status).toBe(
      OrderStatus.CANCELLED,
    );
    const released = await eventRepo.findById(event.id);
    expect(
      released.allowReserveSpot({
        section_id: section.id,
        spot_id: spot.id,
      }),
    ).toBe(true);
    expect(released.sections.values()[0].spots.values()[0].is_reserved).toBe(
      false,
    );
    expect(await em.count(SpotReservation, {})).toBe(0);
    const entries = await waitingService.list(event.id.value, section.id.value);
    expect(entries.map((entry) => entry.customer_id.value)).toEqual([
      first.id.value,
      second.id.value,
    ]);
    expect(entries.map((entry) => entry.status)).toEqual([
      WaitingListEntryStatus.NOTIFIED,
      WaitingListEntryStatus.PENDING,
    ]);
    const stored = await em.find(StoredEvent, {});
    expect(stored.map((entry) => entry.type_name).sort()).toEqual(
      [
        CustomerJoinedWaitingList.name,
        CustomerJoinedWaitingList.name,
        OrderCancelled.name,
        EventSpotReleased.name,
        SpotOfferedToWaitingCustomer.name,
      ].sort(),
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][0]).toBeInstanceOf(
      SpotOfferedToWaitingCustomerIntegrationEvent,
    );
    expect(queue.add.mock.calls[0][0].payload).toEqual({
      customer_id: first.id.value,
      event_id: event.id.value,
      section_id: section.id.value,
      spot_id: spot.id.value,
    });
  } finally {
    await container?.close();
    try {
      if (databaseCreated) {
        await orm.schema.dropDatabase(dbName);
      }
    } finally {
      await orm.close();
    }
  }
}, 30000);