import { randomUUID } from 'crypto';
import { MikroORM, MySqlDriver, EntityManager } from '@mikro-orm/mysql';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import config from '../../../mikro-orm.config';
import { ApplicationService } from '../../common/application/application.service';
import { DomainEventManager } from '../../common/domain/domain-event-manager';
import { UnitOfWorkMikroOrm } from '../../common/infra/unit-of-work-mikro-orm';
import { StoredEvent } from '../../stored-events/domain/entities/stored-event.entity';
import { StoredEventMysqlRepository } from '../../stored-events/infra/db/repositories/stored-event-mysql.repository';
import { OrdersController } from '../../../events/orders/orders.controller';
import { Customer } from '../domain/entities/customer.entity';
import { Event } from '../domain/entities/event.entity';
import { Order, OrderId, OrderStatus } from '../domain/entities/order.entity';
import { Partner } from '../domain/entities/partner.entity';
import { SpotReservation } from '../domain/entities/spot-reservation.entity';
import { WaitingList } from '../domain/entities/waiting-list.entity';
import { WaitingListEntryStatus } from '../domain/entities/waiting-list-entry.entity';
import { OrderCancelled } from '../domain/events/domain-events/order-cancelled.event';
import { OrderMysqlRepository } from '../infra/db/repositories/order-mysql.repository';
import { CancelOrderService } from './cancel-order.service';
import { OrderService } from './order.service';
import { ReleaseSpotOnOrderCancelledHandler } from './handlers/release-spot-on-order-cancelled.handler';
import { EventMysqlRepository } from '../infra/db/repositories/event-mysql.repository';
import { SpotReservationMysqlRepository } from '../infra/db/repositories/spot-reservation-mysql.repository';
import { EventSpotReleased } from '../domain/events/domain-events/event-spot-released.event';

describe('CancelOrderService and REST endpoint', () => {
  let orm: MikroORM<MySqlDriver>;
  let em: EntityManager;
  let service: CancelOrderService;
  let orderRepo: OrderMysqlRepository;
  let app: INestApplication;
  let event: Event;
  let order: Order;
  let list: WaitingList;
  let manager: DomainEventManager;
  let databaseCreated = false;
  const dbName = `events_task7_${randomUUID().replace(/-/g, '')}`;

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
    const customer = Customer.create({
      name: 'Customer',
      cpf: '70375887091',
    });
    event = partner.initEvent({ name: 'Event', date: new Date() });
    event.addSection({ name: 'Section', total_spots: 1, price: 200 });
    event.publishAll();
    const section = event.sections.values()[0];
    const spot = section.spots.values()[0];
    event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id });
    order = Order.create({
      customer_id: customer.id,
      event_spot_id: spot.id,
      amount: 200,
    });
    list = WaitingList.create({ event_id: event.id, section_id: section.id });
    list.join(customer.id);
    const reservation = SpotReservation.create({
      spot_id: spot.id,
      customer_id: customer.id,
    });
    em.persist([partner, customer, event, order, list, reservation]);
    await em.flush();
    em.clear();

    manager = new DomainEventManager();
    const storedRepo = new StoredEventMysqlRepository(em);
    manager.register('*', async (domainEvent) => {
      storedRepo.add(domainEvent);
    });
    orderRepo = new OrderMysqlRepository(em);
    service = new CancelOrderService(
      orderRepo,
      new ApplicationService(new UnitOfWorkMikroOrm(em), manager),
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

  test.each([OrderStatus.PENDING, OrderStatus.PAID])(
    'cancels status %s, publishes and stores its event without touching other aggregates',
    async (status) => {
      if (status === OrderStatus.PAID) {
        const paid = await orderRepo.findById(order.id);
        paid.pay();
        await em.flush();
        em.clear();
      }
      const published = jest.fn();
      manager.register(OrderCancelled.name, published);
      const add = jest.spyOn(orderRepo, 'add');

      const cancelled = await service.cancel(order.id.value);

      expect(cancelled.status).toBe(OrderStatus.CANCELLED);
      expect(add).toHaveBeenCalledWith(cancelled);
      expect(published).toHaveBeenCalledTimes(1);
      expect(published.mock.calls[0][0].event_spot_id.value).toBe(
        order.event_spot_id.value,
      );
      em.clear();
      expect((await orderRepo.findById(order.id)).status).toBe(
        OrderStatus.CANCELLED,
      );
      const stored = await em.find(StoredEvent, {
        type_name: OrderCancelled.name,
      });
      expect(stored).toHaveLength(1);
      expect(stored[0].body).toMatchObject({
        aggregate_id: { _value: order.id.value },
        status: OrderStatus.CANCELLED,
        event_spot_id: { _value: order.event_spot_id.value },
      });
      const unchangedEvent = await em.findOne(Event, { id: event.id });
      expect(
        unchangedEvent.sections.values()[0].spots.values()[0].is_reserved,
      ).toBe(true);
      expect(await em.count(SpotReservation, {})).toBe(1);
      const unchangedList = await em.findOne(WaitingList, { id: list.id });
      expect(unchangedList.entries.values()[0].status).toBe(
        WaitingListEntryStatus.PENDING,
      );
    },
  );

  test('rejects a missing order with the exact message and no stored event', async () => {
    await expect(service.cancel(new OrderId().value)).rejects.toThrow(
      'Order not found',
    );

    expect(await em.count(StoredEvent, {})).toBe(0);
    expect((await orderRepo.findById(order.id)).status).toBe(
      OrderStatus.PENDING,
    );
  });

  test('releases and persists the spot through the registered cancellation reaction', async () => {
    const handler = new ReleaseSpotOnOrderCancelledHandler(
      new EventMysqlRepository(em),
      new SpotReservationMysqlRepository(em),
      manager,
    );
    for (const eventName of ReleaseSpotOnOrderCancelledHandler.listensTo()) {
      manager.register(eventName, (domainEvent) => handler.handle(domainEvent));
    }
    const published = jest.fn();
    manager.register(EventSpotReleased.name, published);

    await service.cancel(order.id.value);
    em.clear();

    const updatedEvent = await em.findOne(Event, { id: event.id });
    const section = updatedEvent.sections.values()[0];
    expect(section.spots.values()[0].is_reserved).toBe(false);
    expect(
      updatedEvent.allowReserveSpot({
        section_id: section.id,
        spot_id: order.event_spot_id,
      }),
    ).toBe(true);
    expect(await em.count(SpotReservation, {})).toBe(0);
    expect((await orderRepo.findById(order.id)).status).toBe(
      OrderStatus.CANCELLED,
    );
    expect(published).toHaveBeenCalledTimes(1);
    const stored = await em.find(StoredEvent, {
      type_name: EventSpotReleased.name,
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].body).toMatchObject({
      event_id: { _value: event.id.value },
      section_id: { _value: section.id.value },
      spot_id: { _value: order.event_spot_id.value },
    });
    expect(
      (await em.findOne(WaitingList, { id: list.id })).entries.values()[0]
        .status,
    ).toBe(WaitingListEntryStatus.PENDING);

    await expect(service.cancel(order.id.value)).rejects.toThrow(
      'Order already cancelled',
    );
    expect(published).toHaveBeenCalledTimes(1);
  });

  test('rejects repeated cancellation without storing another event', async () => {
    await service.cancel(order.id.value);
    em.clear();

    await expect(service.cancel(order.id.value)).rejects.toThrow(
      'Order already cancelled',
    );

    expect((await orderRepo.findById(order.id)).status).toBe(
      OrderStatus.CANCELLED,
    );
    expect(
      await em.count(StoredEvent, { type_name: OrderCancelled.name }),
    ).toBe(1);
  });

  test('exposes POST cancellation and serializes the cancelled status', async () => {
    const module = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        {
          provide: OrderService,
          useValue: { list: jest.fn(), create: jest.fn() },
        },
        { provide: CancelOrderService, useValue: service },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer())
      .post(`/events/${event.id.value}/orders/${order.id.value}/cancel`)
      .expect(201);

    expect(response.body).toEqual({
      id: order.id.value,
      amount: order.amount,
      status: OrderStatus.CANCELLED,
      customer_id: order.customer_id.value,
      event_spot_id: order.event_spot_id.value,
    });
    em.clear();
    expect(
      await em.count(StoredEvent, { type_name: OrderCancelled.name }),
    ).toBe(1);
  });
});